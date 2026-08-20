import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";
import { detectPermissionWarnings } from "../plugins/agy/scripts/lib/agycli.mjs";

// The measured agy denial shape (docs/AGY-RUNTIME-CONTRACT.md §3): a headless
// run has no interactive approver, so a permission prompt resolves to *denied*
// and the run ends `status: "ERROR"` having done nothing. The evidence lives in
// the run document's `error` field on stdout — stderr stays empty.
const DENIED_ERROR =
  'permission check failed for command "cat a.txt": user denied permission to run command:\ncat a.txt';

// The other measured denial shape (§6): agy protects some of its own paths
// regardless of --dangerously-skip-permissions.
const PROTECTED_ERROR =
  "Permission denied for read_file(/Users/x/.gemini/antigravity-cli/note.txt). Matches hardcoded system protection boundary rule.";

// A review that validates against plugins/agy/schemas/review-output.schema.json,
// staged the way a real --json-schema run returns it (fixture AGY_FAKE_STRUCTURED).
const VALID_REVIEW = {
  verdict: "needs-attention",
  summary: "One blocking issue in the retry path.",
  findings: [
    {
      severity: "high",
      title: "Retry loop never backs off",
      body: "The delay is recomputed but never awaited, so all retries fire immediately.",
      file: "src/retry.mjs",
      line_start: 42,
      line_end: 42,
      confidence: 0.9,
      recommendation: "Await the delay before the next retry."
    }
  ],
  next_steps: ["Await the delay before the next retry", "Re-run the tests"]
};

// PC3 (2): agy's auto-denial explains itself in the run document's `error`
// field; the typed warning says what it means. A run that forgot
// --dangerously-skip-permissions ends ERROR having done nothing, and the caller
// sees a thin answer with no cause unless the warning is surfaced.
test("an auto-denied permission becomes a typed, actionable warning", () => {
  const fake = makeFakeEnv({ mode: "run-error", extra: { AGY_FAKE_ERROR: DENIED_ERROR } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "read the scratchpad dossier"], {
    env: fake.env,
    cwd
  });
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputState, "failed");
  assert.equal(payload.outputStateReason, "run-error");
  const warning = payload.warnings[0];
  assert.equal(warning.class, "permission_auto_denied");
  assert.equal(warning.permission, "cat");
  assert.match(warning.message, /denied itself/);
  assert.match(warning.message, /--dangerously-skip-permissions/);
  assert.match(result.stderr, /warning: permission_auto_denied/, "it must also be visible on stderr");

  // And it survives into the stored render and the machine-readable channel.
  const stored = runCompanion(["result"], { env: fake.env, cwd }).stdout;
  assert.match(stored, /permission_auto_denied/);

  const storedJson = JSON.parse(runCompanion(["result", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(storedJson.payload.warnings[0].class, "permission_auto_denied");
  assert.equal(storedJson.payload.warnings[0].permission, "cat");
});

// A run that trips agy's own hardcoded protection boundary — read back a file
// under ~/.gemini/antigravity-cli/, say — gets its own warning class with the
// path, because the skip-permissions flag cannot fix it.
test("a path behind agy's protection boundary is named in a typed warning", () => {
  const fake = makeFakeEnv({ mode: "run-error-with-text", extra: { AGY_FAKE_ERROR: PROTECTED_ERROR } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "read the note"], { env: fake.env, cwd });
  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputState, "incomplete");
  assert.equal(payload.outputStateReason, "run-error-with-partial-output");
  const warning = payload.warnings[0];
  assert.equal(warning.class, "protected_path_blocked");
  assert.equal(warning.permission, "read_file");
  assert.equal(warning.path, "/Users/x/.gemini/antigravity-cli/note.txt");
  assert.match(warning.message, /protection boundary/);
});

// Every renderer printed the typed warnings except the one a caller reaches
// when the run is *over* and they are asking what happened to it: `status <id>`
// showed the raw log tail and no Warnings section, so the one channel dedicated
// to inspecting a finished job was the one that did not explain it.
test("status <id> shows the typed warnings, not only the raw log", () => {
  const fake = makeFakeEnv({ mode: "run-error" });
  const cwd = makeTempGitRepo();

  const run = runCompanion(["task", "--json", "--write", "read the scratchpad dossier"], { env: fake.env, cwd });
  const { jobId } = JSON.parse(run.stdout);

  const detail = runCompanion(["status", jobId], { env: fake.env, cwd });
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /Warnings:/);
  assert.match(detail.stdout, /permission_auto_denied: agy asked for permission to run `cat`/);
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

// X2: 30 of 64 recorded "succeeded" review jobs opened no file at all, and the
// orchestrator counted those verdicts as votes. Here the diff is inlined in the
// prompt, so 0 tool calls is not automatically ungrounded — but it does mean
// nothing outside the diff was inspected, and the verdict must say so.
test("a review verdict carries the evidence behind it", () => {
  const fake = makeFakeEnv({ mode: "review-json", extra: { AGY_FAKE_STRUCTURED: JSON.stringify(VALID_REVIEW) } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["review"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: NEEDS ATTENTION \(evidence: substantive\)/);
  assert.doesNotMatch(result.stdout, /no_evidence_review/);

  const json = runCompanion(["review", "--json"], { env: fake.env, cwd: makeTempGitRepo() });
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.evidenceLevel, "substantive");
  assert.equal(payload.toolEventCount, 3);
  assert.deepEqual(payload.warnings, [], "a review that did work must not be flagged");
});

// X2 (1): a caller must be able to drop a zero-evidence verdict without parsing
// the warning text. The downgrade is its own field, so the run's own verdict
// (`outputState`, exit code) keeps meaning "did agy answer at all".
//
// The fixture's review-json lane always emits work steps, so the stageable
// zero-evidence review is the empty-answer one: 0 tool calls and no text, which
// agy reports as an ERROR-less SUCCESS document. That is `incomplete` for the
// run itself (empty-text) — but the evidence downgrade is exactly the one a
// completed run would carry: evidenceLevel "none", no_evidence_review warning,
// resultComplete false.
test("a zero-evidence review is machine-readably incomplete", () => {
  const fake = makeFakeEnv({ mode: "empty-text" });
  const cwd = makeTempGitRepo();
  const result = runCompanion(["review", "--json"], { env: fake.env, cwd });
  assert.equal(result.status, 2, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.resultComplete, false, "0 tool calls behind a verdict is not a completed review");
  assert.equal(payload.evidenceLevel, "none");
  assert.equal(payload.outputState, "incomplete");
  assert.equal(payload.outputStateReason, "empty-text");
  assert.deepEqual(
    payload.warnings.map((warning) => warning.class),
    ["no_evidence_review"]
  );

  // It is stored with the job, so a caller that comes back later via
  // `result --json` sees the same downgrade.
  const stored = JSON.parse(runCompanion(["result", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(stored.payload.resultComplete, false);
  assert.equal(stored.payload.evidenceLevel, "none");
  assert.deepEqual(stored.payload.warnings.map((warning) => warning.class), ["no_evidence_review"]);

  // The human channel carries the same warning instead of a clean verdict.
  const human = runCompanion(["result"], { env: fake.env, cwd }).stdout;
  assert.match(human, /no_evidence_review/);

  const withEvidence = makeFakeEnv({ mode: "review-json", extra: { AGY_FAKE_STRUCTURED: JSON.stringify(VALID_REVIEW) } });
  const grounded = JSON.parse(
    runCompanion(["review", "--json"], { env: withEvidence.env, cwd: makeTempGitRepo() }).stdout
  );
  assert.equal(grounded.resultComplete, true);
  assert.equal(grounded.evidenceLevel, "substantive");
  assert.deepEqual(grounded.warnings, []);
});

test("a task run is never flagged for a missing review evidence trail", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "answer" } });
  const result = runCompanion(["task", "--json", "--write", "answer this"], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.evidenceLevel, "thin");
  assert.deepEqual(payload.warnings, []);
  assert.equal(payload.resultComplete, true, "only review kinds are downgraded for missing evidence");

  // Even a task with zero tool calls behind it is not a review: the evidence
  // warning must stay off, and only the absent answer downgrades resultComplete.
  const empty = makeFakeEnv({ mode: "empty-text" });
  const emptyPayload = JSON.parse(
    runCompanion(["task", "--json", "--write", "answer this"], {
      env: empty.env,
      cwd: makeTempGitRepo()
    }).stdout
  );
  assert.equal(emptyPayload.evidenceLevel, "none");
  assert.deepEqual(emptyPayload.warnings, [], "no_evidence_review is a review-kind warning only");
  assert.equal(emptyPayload.resultComplete, false, "an empty answer is still not an answer");
});

test("detectPermissionWarnings dedupes and names the denial target", () => {
  const warnings = detectPermissionWarnings(`${DENIED_ERROR}\n${DENIED_ERROR}\n`);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].class, "permission_auto_denied");
  assert.equal(warnings[0].permission, "cat");
  assert.match(warnings[0].message, /denied itself/);

  // The other measured shape: agy's own protected paths, which the
  // skip-permissions flag does not lift. The path is part of the warning.
  const protectedWarnings = detectPermissionWarnings(PROTECTED_ERROR);
  assert.equal(protectedWarnings.length, 1);
  assert.equal(protectedWarnings[0].class, "protected_path_blocked");
  assert.equal(protectedWarnings[0].permission, "read_file");
  assert.equal(protectedWarnings[0].path, "/Users/x/.gemini/antigravity-cli/note.txt");

  // Same evidence in the error field of the run document: stderr is not special.
  assert.equal(detectPermissionWarnings("", { errorText: PROTECTED_ERROR })[0].class, "protected_path_blocked");

  // A run that was never pointed at the repository names the working directory.
  const notTargeted = detectPermissionWarnings("The file calc.py does not exist in the current working directory.", {
    cwd: "/repo"
  });
  assert.equal(notTargeted[0].class, "workspace_not_targeted");
  assert.match(notTargeted[0].message, /files missing from \/repo/);
  assert.match(notTargeted[0].message, /--add-dir/);

  assert.deepEqual(detectPermissionWarnings("nothing interesting here"), []);
});
