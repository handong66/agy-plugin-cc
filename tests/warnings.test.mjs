import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";
import { detectPermissionWarnings } from "../plugins/agy/scripts/lib/agycli.mjs";

const REJECTION_LINE = "! permission requested: external_directory (/private/tmp/claude-501/x/scratchpad/dossier.json); auto-rejecting";

// PC3 (2): the stderr tail explains what agy printed; the typed warning
// says what it means. Claude Code stages prompts and material under
// /private/tmp/claude-501/..., agy refuses to read outside the repo, and
// the run still exits 0 — so the caller saw a thin answer with no cause.
test("an auto-rejected external path becomes a typed, actionable warning", () => {
  const fake = makeFakeEnv({
    extra: {
      AGY_FAKE_TEXT: "answer produced without the dossier",
      AGY_FAKE_STDERR: REJECTION_LINE
    }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--write", "read the scratchpad dossier"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Warnings:/);
  assert.match(result.stdout, /external_path_blocked: agy refused to read \/private\/tmp\/claude-501/);
  assert.match(result.stdout, /Copy the file into the repo, or inline its contents in the prompt/);
  assert.match(result.stderr, /warning: external_path_blocked/, "it must also be visible on stderr");

  // And it survives into the stored render and the machine-readable channel.
  const stored = runCompanion(["result"], { env: fake.env, cwd }).stdout;
  assert.match(stored, /external_path_blocked/);

  const fresh = makeFakeEnv({
    extra: { AGY_FAKE_TEXT: "answer", AGY_FAKE_STDERR: REJECTION_LINE }
  });
  const json = runCompanion(["task", "--json", "--write", "read it"], {
    env: fresh.env,
    cwd: makeTempGitRepo()
  });
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.warnings[0].class, "external_path_blocked");
  assert.equal(payload.warnings[0].path, "/private/tmp/claude-501/x/scratchpad/dossier.json");
});

// Every renderer printed the typed warnings except the one a caller reaches
// when the run is *over* and they are asking what happened to it: `status <id>`
// showed the raw log tail and no Warnings section, so the one channel dedicated
// to inspecting a finished job was the one that did not explain it.
test("status <id> shows the typed warnings, not only the raw log", () => {
  const fake = makeFakeEnv({
    extra: {
      AGY_FAKE_TEXT: "answer produced without the dossier",
      AGY_FAKE_STDERR: REJECTION_LINE
    }
  });
  const cwd = makeTempGitRepo();

  const run = runCompanion(["task", "--json", "--write", "read the scratchpad dossier"], { env: fake.env, cwd });
  const { jobId } = JSON.parse(run.stdout);

  const detail = runCompanion(["status", jobId], { env: fake.env, cwd });
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /Warnings:/);
  assert.match(detail.stdout, /external_path_blocked: agy refused to read \/private\/tmp\/claude-501/);
  // Above the raw activity log, for the same reason it sits above the stderr
  // block elsewhere: the tail says what agy printed, the warning says what
  // it means for the answer.
  assert.ok(
    detail.stdout.indexOf("Warnings:") < detail.stdout.indexOf("Recent activity:"),
    "the warnings belong above the raw log tail"
  );

  // A run with nothing to report must not grow an empty section.
  const quiet = makeFakeEnv();
  const quietCwd = makeTempGitRepo();
  const quietRun = runCompanion(["task", "--json", "--", "just answer"], { env: quiet.env, cwd: quietCwd });
  const quietDetail = runCompanion(["status", JSON.parse(quietRun.stdout).jobId], {
    env: quiet.env,
    cwd: quietCwd
  });
  assert.doesNotMatch(quietDetail.stdout, /Warnings:/);
});

// X1 (2): the prompt preamble tells headless delegates not to load interactive
// skills, but a repository AGENTS.md/CLAUDE.md can still win. 89 of 231 recorded
// agy job logs opened by loading a skill instead of doing the work, which
// is invisible in the answer and shows up only as turns and wall time.
test("loading an interactive skill is counted and warned about", () => {
  const fake = makeFakeEnv({
    extra: {
      AGY_FAKE_TEXT: "the answer, eventually",
      AGY_FAKE_SKILL: "pua"
    }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "do the work"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.warnings.map((warning) => warning.class), ["skills_loaded"]);
  assert.deepEqual(payload.warnings[0].skills, ["pua", "/Users/x/.config/agy/skills/pua/SKILL.md"]);
  assert.match(payload.warnings[0].message, /spent turns loading interactive skills/);
  assert.match(result.stderr, /warning: skills_loaded/);

  const clean = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "the answer" } });
  const quiet = runCompanion(["task", "--json", "--write", "do the work"], {
    env: clean.env,
    cwd: makeTempGitRepo()
  });
  assert.deepEqual(JSON.parse(quiet.stdout).warnings, [], "a clean run must not warn");
});

// The other side of that heuristic. Any read of any `SKILL.md` counted as skill
// loading, so a run pointed at a repository that *ships* skills — this one, and
// every plugin repo like it — was told it had wandered off to load a persona
// when it had done exactly the work it was asked to do. A file inside the
// workspace is material; a skill definition outside it is the failure mode.
test("reading a SKILL.md that belongs to the repository is not skill loading", () => {
  const cwd = makeTempGitRepo();
  const repoSkill = path.join(cwd, "skills", "house-style", "SKILL.md");
  fs.mkdirSync(path.dirname(repoSkill), { recursive: true });
  fs.writeFileSync(repoSkill, "# House style\n");

  for (const target of [repoSkill, "skills/house-style/SKILL.md"]) {
    const fake = makeFakeEnv({
      extra: { AGY_FAKE_TEXT: "reviewed the skill file", AGY_FAKE_SKILL_READ: target }
    });
    const run = runCompanion(["task", "--json", "--write", "review the skills directory"], {
      env: fake.env,
      cwd
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      JSON.parse(run.stdout).warnings,
      [],
      `reading ${target} is repository work, not skill loading`
    );
  }

  // A SKILL.md outside the workspace still is.
  const outside = makeFakeEnv({
    extra: {
      AGY_FAKE_TEXT: "eventually",
      AGY_FAKE_SKILL_READ: "/Users/x/.config/agy/skills/pua/SKILL.md"
    }
  });
  const flagged = runCompanion(["task", "--json", "--write", "do the work"], { env: outside.env, cwd });
  const warnings = JSON.parse(flagged.stdout).warnings;
  assert.deepEqual(warnings.map((warning) => warning.class), ["skills_loaded"]);
  assert.deepEqual(warnings[0].skills, ["/Users/x/.config/agy/skills/pua/SKILL.md"]);
});

// X2: 30 of 64 recorded "succeeded" review jobs opened no file at all, and the
// orchestrator counted those verdicts as votes. Here the diff is inlined in the
// prompt, so 0 tool calls is not automatically ungrounded — but it does mean
// nothing outside the diff was inspected, and the verdict must say so.
test("a review verdict carries the evidence behind it", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["review"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: NEEDS ATTENTION \(evidence: none\)/);
  assert.match(result.stdout, /no_evidence_review: this verdict was produced with 0 tool calls/);
  assert.match(result.stdout, /opinion, not a completed review/);

  const withEvidence = makeFakeEnv({ mode: "review-json", extra: { AGY_FAKE_TOOLS: "4" } });
  const json = runCompanion(["review", "--json"], { env: withEvidence.env, cwd: makeTempGitRepo() });
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.evidenceLevel, "substantive");
  assert.equal(payload.toolEventCount, 4);
  assert.deepEqual(payload.warnings, [], "a review that did work must not be flagged");
});

// X2 (1): a caller must be able to drop a zero-evidence verdict without parsing
// the warning text. The downgrade is its own field, so the run's own verdict
// (`outputState`, exit code) keeps meaning "did agy answer at all".
test("a zero-evidence review is machine-readably incomplete", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();
  const result = runCompanion(["review", "--json"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.resultComplete, false, "0 tool calls behind a verdict is not a completed review");
  assert.equal(payload.evidenceLevel, "none");
  assert.equal(payload.outputState, "completed", "the run itself finished; only the verdict is downgraded");
  assert.deepEqual(
    payload.warnings.map((warning) => warning.class),
    ["no_evidence_review"]
  );

  // It is stored with the job, so a caller that comes back later via
  // `result --json` sees the same downgrade.
  const stored = JSON.parse(runCompanion(["result", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(stored.payload.resultComplete, false);

  const withEvidence = makeFakeEnv({ mode: "review-json", extra: { AGY_FAKE_TOOLS: "4" } });
  const grounded = JSON.parse(
    runCompanion(["review", "--json"], { env: withEvidence.env, cwd: makeTempGitRepo() }).stdout
  );
  assert.equal(grounded.resultComplete, true);
});

test("a task run is never flagged for a missing review evidence trail", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "answer" } });
  const result = runCompanion(["task", "--json", "--write", "answer this"], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.evidenceLevel, "none");
  assert.deepEqual(payload.warnings, []);
  assert.equal(payload.resultComplete, true, "only review kinds are downgraded for missing evidence");
});

test("detectPermissionWarnings dedupes and names the working directory", () => {
  const warnings = detectPermissionWarnings(`${REJECTION_LINE}\n${REJECTION_LINE}\n`, { cwd: "/repo" });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].permission, "external_directory");
  assert.match(warnings[0].message, /outside \/repo/);

  assert.deepEqual(detectPermissionWarnings("nothing interesting here"), []);

  const other = detectPermissionWarnings("! permission requested: bash (rm -rf); auto-rejecting");
  assert.equal(other[0].class, "permission_blocked");
});
