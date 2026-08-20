import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { REPO_ROOT, makeFakeEnv, makeTempDir, makeTempGitRepo, readRunArgs, runCompanion } from "./helpers.mjs";

const STATE_MODULE = path.join(REPO_ROOT, "plugins", "agy", "scripts", "lib", "state.mjs");
const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";

// A review that validates against plugins/agy/schemas/review-output.schema.json.
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
  next_steps: ["Await the delay before the next retry"]
};

test("setup --json reports a ready fake agy", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["setup", "--json"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.agyAvailable, true);
  assert.equal(report.authenticated, true);
  assert.equal(report.version, "9.9.9-fake");
});

test("task --write runs agy with --mode accept-edits and stores a resumable job", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "answer from fake" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "do", "the", "thing"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.rawOutput, "answer from fake");
  assert.equal(payload.agyConversationId, CONVERSATION_ID);

  const runArgs = readRunArgs(fake);
  // The write dial is agy's own: --mode accept-edits pointed at the repository.
  assert.ok(runArgs.includes("--mode"), `expected --mode in ${runArgs}`);
  assert.equal(runArgs[runArgs.indexOf("--mode") + 1], "accept-edits");
  assert.ok(!runArgs.includes("--auto"), "agy has no --auto; edits come from --mode accept-edits");
  assert.ok(!runArgs.includes("--agent"));
  assert.equal(runArgs[runArgs.indexOf("--add-dir") + 1], fs.realpathSync(cwd), "a write run is pointed at the repo");
  assert.equal(runArgs[runArgs.indexOf("-p") + 1], "do the thing");

  // status/result read the stored job back
  const status = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  const { jobs } = JSON.parse(status.stdout);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");

  const stored = runCompanion(["result", jobs[0].id, "--json"], { env: fake.env, cwd });
  assert.equal(JSON.parse(stored.stdout).payload.rawOutput, "answer from fake");

  // State must land in the namespaced data dir, never in the decoy that
  // simulates another plugin having clobbered CLAUDE_PLUGIN_DATA.
  assert.ok(fs.readdirSync(fake.stateDir).length > 0, "namespaced data dir must hold state");
  assert.equal(fs.readdirSync(fake.decoyDir).length, 0, "clobbered CLAUDE_PLUGIN_DATA must stay untouched");

  // resume-last reuses the recorded conversation id
  const resumed = runCompanion(["task", "--json", "--write", "--resume-last", "continue"], { env: fake.env, cwd });
  assert.equal(JSON.parse(resumed.stdout).ok, true);
  const resumedArgs = readRunArgs(fake);
  assert.equal(resumedArgs[resumedArgs.indexOf("--conversation") + 1], CONVERSATION_ID);
});

test("task defaults to read-only via a disposable workspace copy", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  const result = runCompanion(["task", "--json", "diagnose", "only"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  const runArgs = readRunArgs(fake);
  // Read-only is workspace isolation, not a flag: agy has no read-only mode,
  // --mode plan refuses reads, and named agents do not exist.
  assert.ok(!runArgs.includes("--agent"), "agy agents returns empty; there is no plan agent");
  assert.ok(!runArgs.includes("--auto"));
  assert.ok(!runArgs.includes("--mode"), "read-only runs never carry a mode flag");
  const workspace = runArgs[runArgs.indexOf("--add-dir") + 1];
  assert.match(workspace, /agy-review/, "the run is pointed at a disposable mirror");
  assert.notEqual(workspace, fs.realpathSync(cwd), "the repository path itself is never handed over");
  assert.equal(runArgs[runArgs.indexOf("-p") + 1], "diagnose only");
});

test("review parses structured findings and stays read-only", () => {
  const fake = makeFakeEnv({ mode: "review-json", extra: { AGY_FAKE_STRUCTURED: JSON.stringify(VALID_REVIEW) } });
  const cwd = makeTempGitRepo();
  const result = runCompanion(["review", "--json"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.review.verdict, "needs-attention");
  assert.equal(payload.review.findings.length, 1);

  const runArgs = readRunArgs(fake);
  const workspace = runArgs[runArgs.indexOf("--add-dir") + 1];
  assert.match(workspace, /agy-review/, "a review runs inside a disposable copy");
  assert.notEqual(workspace, fs.realpathSync(cwd), "never the repository");
  assert.ok(!runArgs.includes("--mode"), "reviews are never given a write mode");
  const prompt = runArgs[runArgs.indexOf("-p") + 1];
  assert.match(prompt, /<output_schema>/);
  assert.match(prompt, /<system_rules>/);
  assert.match(prompt, /<headless_delegation>/, "the composed prompt must carry the headless preamble");
  assert.match(prompt, /app\.mjs/, "review prompt should inline the untracked file");
});

// agy states *why* a run failed in the run document's `error` field on stdout,
// and leaves stderr empty while doing it (measured: an unrecognised --model
// exits 1 with an empty stderr). The classifier reads the document.
test("a failed run is classified from the run document, not from stderr", () => {
  const fake = makeFakeEnv({ mode: "fail" });
  const result = runCompanion(["task", "--json", "--write", "explode"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.outputState, "failed");
  assert.equal(payload.outputStateReason, "run-error");
  assert.equal(payload.stderrTail, "", "the whole explanation lives in the document's error field");
  assert.equal(payload.failureClass, "model_not_found");

  const human = runCompanion(["task", "--write", "explode"], {
    env: makeFakeEnv({ mode: "fail" }).env,
    cwd: makeTempGitRepo()
  });
  assert.equal(human.status, 1);
  assert.match(human.stdout, /Next step \(model_not_found\)/);
  assert.match(human.stdout, /agy does not recognise that model id/);
});

// P-COMPLETE: exit code 0 is not a verdict. Two recorded failure shapes —
// "no final output" (2026-07-17) and one line of narration after tool calls
// (2026-08-16) — must land on `incomplete`, never on `completed`.
test("empty answers are reported as incomplete, not completed", () => {
  const fake = makeFakeEnv({ mode: "empty-text" });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "summarise the contracts"], { env: fake.env, cwd });
  assert.equal(result.status, 2, `incomplete runs must exit 2, got ${result.status}: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.outputState, "incomplete");
  assert.equal(payload.outputStateReason, "empty-text");

  const status = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  const { jobs } = JSON.parse(status.stdout);
  assert.equal(jobs[0].status, "incomplete");
  assert.equal(jobs[0].outputState, "incomplete");

  // The stored result must be reachable and must not read like an answer.
  const stored = runCompanion(["result", jobs[0].id], { env: fake.env, cwd });
  assert.match(stored.stdout, /stopped before producing a final answer/);
  assert.doesNotMatch(stored.stdout, /\[agy returned no final output\]/);
  assert.match(stored.stdout, /Recover with: \/agy:rescue --resume/);
});

test("narration after tool calls is incomplete and keeps the partial output", () => {
  const fake = makeFakeEnv({ mode: "narration" });
  const cwd = makeTempGitRepo();
  const prompt = `<task>\n${"Review the parent contracts in detail. ".repeat(60)}\n</task>`;

  const result = runCompanion(["task", "--json", "--read-only", prompt], { env: fake.env, cwd });
  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputState, "incomplete");
  assert.equal(payload.outputStateReason, "narration");
  // agy has no stopReason of its own; its status is the nearest equivalent,
  // so a SUCCESS document reads as a finished turn even when the text is thin.
  assert.equal(payload.stopReason, "stop");
  assert.equal(payload.toolEventCount, 3);
  assert.equal(payload.rawOutput, "Parent contracts read. Now the source files.");

  const rendered = runCompanion(["result"], { env: fake.env, cwd }).stdout;
  assert.match(rendered, /stopReason: stop, 3 tool calls/);
  assert.match(rendered, /Parent contracts read\. Now the source files\./);
  assert.match(rendered, /Partial output below/);
  assert.match(rendered, /incomplete/);
  assert.deepEqual(JSON.parse(runCompanion(["result", "--json"], { env: fake.env, cwd }).stdout).payload.warnings, []);
});

// P-LIVENESS: a companion killed mid-run (Bash timeout, SIGTERM) never writes a
// terminal state, so its record used to read `running` forever — one was still
// counting at 201 minutes three hours after its process had exited.
test("status stops reporting a job as running once its process is gone", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  // A finished run first, so the store has a live-looking neighbour record.
  runCompanion(["task", "--json", "--write", "warm up the store"], { env: fake.env, cwd });

  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  const orphanScript = `
    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE)});
    upsertJob(${JSON.stringify(cwd)}, {
      id: "task-orphan-e2e",
      kind: "task",
      status: "running",
      cwd: ${JSON.stringify(cwd)},
      childPid: ${dead.pid},
      promptPreview: "you are the director verification rehearsal",
      startedAt: new Date(Date.now() - 201 * 60 * 1000).toISOString()
    });
  `;
  const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", orphanScript], {
    env: fake.env,
    encoding: "utf8"
  });
  assert.equal(seeded.status, 0, seeded.stderr);

  const status = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  const orphan = JSON.parse(status.stdout).jobs.find((job) => job.id === "task-orphan-e2e");
  assert.equal(orphan.status, "failed");
  assert.equal(orphan.failureClass, "orphaned");

  const table = runCompanion(["status", "--all"], { env: fake.env, cwd }).stdout;
  assert.match(table, /task-orphan-e2e \| task \| failed \(orphaned\)/);
  assert.doesNotMatch(table, /task-orphan-e2e \| task \| running/);

  const detail = runCompanion(["status", "task-orphan-e2e"], { env: fake.env, cwd }).stdout;
  assert.match(detail, /Status: failed \(orphaned\)/);
  assert.match(detail, /\/agy:rescue --resume/);

  // `--wait` must return at once instead of burning the whole 15-minute budget
  // re-reading a record that can never change again.
  const startedAt = Date.now();
  const waited = runCompanion(["status", "task-orphan-e2e", "--wait", "--json"], { env: fake.env, cwd });
  assert.equal(JSON.parse(waited.stdout).job.status, "failed");
  assert.ok(Date.now() - startedAt < 10_000, "status --wait must not poll a dead job");

  const cancelled = runCompanion(["cancel", "task-orphan-e2e"], { env: fake.env, cwd });
  assert.match(cancelled.stdout, /already failed \(orphaned\); nothing to cancel/);

  // The completed neighbour keeps its own verdict.
  const jobs = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).jobs;
  assert.equal(jobs.filter((job) => job.status === "completed").length, 1);
});

// PC3: Claude Code stages material in /private/tmp/claude-501/.../scratchpad,
// agy refuses to read outside the repo, says so on stderr, and exits 0.
// A successful-looking answer must still carry that cause.
test("a run that exited 0 still shows the auto-rejected path from stderr", () => {
  const fake = makeFakeEnv({
    extra: {
      AGY_FAKE_TEXT: "answer produced despite the rejected read",
      AGY_FAKE_STDERR: "! permission requested: external_directory (/private/tmp/*); auto-rejecting"
    }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--write", "read the scratchpad dossier"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /answer produced despite the rejected read/);
  assert.match(result.stdout, /Most recent stderr:/);
  assert.match(result.stdout, /permission requested: external_directory/);

  // And it survives into the stored render that /agy:result replays.
  const stored = runCompanion(["result"], { env: fake.env, cwd }).stdout;
  assert.match(stored, /permission requested: external_directory/);
});

// P-LIVENESS, second half: reconciliation runs from every reader, so a job can
// be relabelled `failed (orphaned)` in the window between its child exiting and
// its companion writing the verdict. The verdict must win, and no trace of the
// label may survive on a run that succeeded.
test("a reconcile that races the owning companion leaves no orphan label behind", () => {
  const fake = makeFakeEnv({
    extra: { AGY_FAKE_TEXT: "the real answer", AGY_FAKE_ORPHAN_RACE: "1" }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "answer the question"], { env: fake.env, cwd });
  assert.equal(result.status, 0, `a successful run must still exit 0: ${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).rawOutput, "the real answer");

  const jobs = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].failureClass ?? null, null, "the terminal write must clear the reconcile label");
  // The pid is dropped as the child exits, so the record spends the parse
  // window on the grace clock rather than pointing at a dead process.
  assert.equal(jobs[0].childPid ?? null, null);

  const table = runCompanion(["status", "--all"], { env: fake.env, cwd }).stdout;
  assert.match(table, /\| task \| completed \|/);
  assert.doesNotMatch(table, /orphaned/);

  const detail = runCompanion(["status", jobs[0].id], { env: fake.env, cwd }).stdout;
  assert.match(detail, /Status: completed$/m);
  assert.doesNotMatch(detail, /companion process for this job died/);

  const stored = runCompanion(["result", jobs[0].id], { env: fake.env, cwd }).stdout;
  assert.match(stored, /the real answer/);
  assert.doesNotMatch(stored, /orphaned/);
});

test("silent runs (no events) are treated as failures", () => {
  const fake = makeFakeEnv({ mode: "silent" });
  const result = runCompanion(["task", "--json", "--write", "quiet"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

// PC9/X5 warns when a newer copy of the plugin sits next to the running one:
// an orchestrator that hard-coded `.../agy/0.1.0/scripts/...` ran a stale
// copy for 3.5 hours. The warning shipped with no test at all, and it is the
// kind of code that only ever runs on a user's machine — three path segments
// of `..` and a version comparison, in a layout the test suite never builds.
function stageVersionedInstall(versions, running) {
  const cache = makeTempDir("agy-versioned-cache");
  const source = path.join(REPO_ROOT, "plugins", "agy");
  const staged = path.join(cache, running, "plugins", "agy");
  fs.mkdirSync(path.join(staged, "scripts"), { recursive: true });
  // The entry point must be a real file: Node resolves an entry symlink, and
  // the whole check hangs off `import.meta.url`. Everything it reads can be
  // linked back to the checkout.
  fs.copyFileSync(
    path.join(source, "scripts", "agy-companion.mjs"),
    path.join(staged, "scripts", "agy-companion.mjs")
  );
  fs.symlinkSync(path.join(source, "scripts", "lib"), path.join(staged, "scripts", "lib"));
  for (const name of ["prompts", "schemas", ".claude-plugin"]) {
    fs.symlinkSync(path.join(source, name), path.join(staged, name));
  }
  for (const version of versions) {
    fs.mkdirSync(path.join(cache, version), { recursive: true });
  }
  return path.join(staged, "scripts", "agy-companion.mjs");
}

// The check only fires from a *versioned* install: the version directory name
// must equal the plugin's own version (read from the checkout's plugin.json,
// which the staging links back), so the running copy is staged as 0.1.0.
test("a newer install sitting next to the running one is named on stderr", () => {
  const fake = makeFakeEnv();
  const entry = stageVersionedInstall(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");

  const result = spawnSync(process.execPath, [entry, "--help"], { env: fake.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /a newer install of this plugin exists \(0\.3\.0\)/, "the highest one, by version");
  assert.match(result.stderr, /you are running 0\.1\.0 from /);
  assert.match(result.stderr, /AGY_COMPANION_BIN/, "and it must say what to use instead");
  // A warning, not a replacement: the help the caller asked for is still there.
  assert.match(result.stdout, /^agy-companion 0\.1\.0 —/);

  // Only *newer* counts, and an unversioned checkout has nothing to compare.
  const newest = stageVersionedInstall(["0.1.0"], "0.1.0");
  const quiet = spawnSync(process.execPath, [newest, "--help"], { env: fake.env, encoding: "utf8" });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /newer install/);
  const inPlace = runCompanion(["--help"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.doesNotMatch(inPlace.stderr, /newer install/, "this checkout is not a versioned install");
});
