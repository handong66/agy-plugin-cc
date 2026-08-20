import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

import { REPO_ROOT, makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";

const STATE_MODULE = path.join(REPO_ROOT, "plugins", "agy", "scripts", "lib", "state.mjs");

// P-BG 1: `--background` is a Claude Code execution flag. Consuming it silently
// let two 2026-07-21 runs believe they had been detached while they were still
// on the 2-minute Bash wall that then killed them.
test("task rejects --background instead of silently swallowing it", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--background", "--write", "do the thing"], { env: fake.env, cwd });
  assert.equal(result.status, 1, "a swallowed execution flag must not look like a successful run");
  assert.match(result.stderr, /--background is a Claude Code execution flag/);
  assert.match(result.stderr, /Bash\(run_in_background: true\)/);
  assert.equal(fs.existsSync(fake.argsFile), false, "agy must not be spawned for a rejected flag");

  const jobs = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).jobs;
  assert.equal(jobs.length, 0, "a rejected invocation must not leave a job record");
});

test("review rejects --background too", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const result = runCompanion(["review", "--background"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--background is a Claude Code execution flag/);
});

// `--wait` keeps its no-op status: the companion is a foreground runner, which
// is exactly what the flag asks for.
test("--wait stays an accepted no-op on task", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "answer" } });
  const result = runCompanion(["task", "--json", "--wait", "--write", "do it"], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rawOutput, "answer");
});

// P-BG 3: `agy run` has no timeout flag, so only the companion can bound a
// run. Without it a stuck child kept its record `running` and the caller had no
// verdict at all.
test("task --timeout-ms kills the run and records failureClass timeout", () => {
  const fake = makeFakeEnv({ mode: "hang" });
  const cwd = makeTempGitRepo();

  const startedAt = Date.now();
  const result = runCompanion(["task", "--json", "--timeout-ms", "2000", "--write", "hang forever"], {
    env: fake.env,
    cwd
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 25_000, `the companion must enforce its own deadline (took ${elapsed}ms)`);
  assert.equal(result.status, 1, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.timedOut, true);

  const jobs = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).jobs;
  assert.equal(jobs[0].status, "failed");
  assert.equal(jobs[0].failureClass, "timeout");

  const rendered = runCompanion(["result", jobs[0].id], { env: fake.env, cwd }).stdout;
  assert.match(rendered, /stopped by the companion after 2000ms/);
  assert.match(rendered, /failed \(timeout\)/);
});

test("task rejects a non-numeric --timeout-ms", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["task", "--timeout-ms", "soon", "--write", "go"], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /--timeout-ms must be a positive number/);
});

// P-BG 2: `result --wait` is the primitive the two hand-written
// `for i in $(seq 1 180)` polling loops were emulating.
test("result --wait blocks until the job finishes, then prints the render", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  const jobId = "task-wait-e2e";

  // A record that is genuinely running: the pid is this test process, so
  // reconciliation leaves it alone.
  const seed = `
    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE)});
    upsertJob(${JSON.stringify(cwd)}, {
      id: ${JSON.stringify(jobId)},
      kind: "task",
      status: "running",
      cwd: ${JSON.stringify(cwd)},
      childPid: ${process.pid},
      promptPreview: "long running work",
      startedAt: new Date().toISOString()
    });
  `;
  const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", seed], {
    env: fake.env,
    encoding: "utf8"
  });
  assert.equal(seeded.status, 0, seeded.stderr);

  const finisher = `
    const { upsertJob, writeJobFile } = await import(${JSON.stringify(STATE_MODULE)});
    await new Promise((resolve) => setTimeout(resolve, 2500));
    writeJobFile(${JSON.stringify(cwd)}, ${JSON.stringify(jobId)}, {
      kind: "task",
      rawOutput: "the late answer",
      rendered: "the late answer\\n\\n---\\nJob: ${jobId} (task, completed, 3s)",
      outputState: "completed"
    });
    upsertJob(${JSON.stringify(cwd)}, {
      id: ${JSON.stringify(jobId)},
      status: "completed",
      childPid: null,
      durationMs: 3000,
      endedAt: new Date().toISOString(),
      summary: "the late answer"
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", finisher], {
    env: fake.env,
    stdio: "ignore"
  });

  const startedAt = Date.now();
  const waited = runCompanion(["result", jobId, "--wait", "--timeout-ms", "20000"], { env: fake.env, cwd });
  const elapsed = Date.now() - startedAt;
  child.kill();

  assert.equal(waited.status, 0, waited.stderr);
  assert.match(waited.stdout, /the late answer/);
  assert.ok(elapsed >= 1500, `--wait must actually wait, returned after ${elapsed}ms`);

  // Without --wait the same call has to say the job is unfinished rather than
  // block, so the two shapes stay distinguishable.
  const jobs = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).jobs;
  assert.equal(jobs.find((job) => job.id === jobId).status, "completed");
});

test("status --wait validates --timeout-ms the same way", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  const jobId = "task-budget-validation";

  // The check sits inside the `--wait` branch, which `commandStatus` only
  // reaches for a job that exists — against an empty store `describeMissingJob`
  // answers first and the validation never runs at all. So the job has to be
  // real, and the assertion has to name the one message under test.
  const seed = `
    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE)});
    upsertJob(${JSON.stringify(cwd)}, {
      id: ${JSON.stringify(jobId)},
      kind: "task",
      status: "running",
      cwd: ${JSON.stringify(cwd)},
      childPid: ${process.pid},
      promptPreview: "still going",
      startedAt: new Date().toISOString()
    });
  `;
  const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", seed], {
    env: fake.env,
    encoding: "utf8"
  });
  assert.equal(seeded.status, 0, seeded.stderr);

  const startedAt = Date.now();
  const result = runCompanion(["status", jobId, "--wait", "--timeout-ms", "later"], { env: fake.env, cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /--timeout-ms must be a positive number of milliseconds \(got later\)/);
  assert.doesNotMatch(output, /No job found/, "the job exists, so this must be the budget error");
  assert.ok(
    Date.now() - startedAt < 15_000,
    "an unusable budget must be rejected instead of falling back to the default poll loop"
  );

  // Pins the other half of the ordering: for an id that is not in the store the
  // lookup failure is still what the caller is told.
  const missing = runCompanion(["status", "no-such-job", "--wait", "--timeout-ms", "later"], { env: fake.env, cwd });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout + missing.stderr, /No job found with id no-such-job/);
});

test("result --wait gives up at its deadline instead of hanging", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  const seed = `
    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE)});
    upsertJob(${JSON.stringify(cwd)}, {
      id: "task-never-finishes",
      kind: "task",
      status: "running",
      cwd: ${JSON.stringify(cwd)},
      childPid: ${process.pid},
      promptPreview: "never finishes",
      startedAt: new Date().toISOString()
    });
  `;
  spawnSync(process.execPath, ["--input-type=module", "-e", seed], { env: fake.env, encoding: "utf8" });

  const startedAt = Date.now();
  const result = runCompanion(["result", "task-never-finishes", "--wait", "--timeout-ms", "2000"], {
    env: fake.env,
    cwd
  });
  assert.ok(Date.now() - startedAt < 20_000, "the wait must honour --timeout-ms");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /still running/);
});

// X2: `parseFlags` pushes "--timeout-ms requires a value" into `errors` and then
// carries on, so the flag reads as unset. Only `task` and `review` checked
// `errors`, which left `status`/`result` falling back to the 15-minute default
// and blocking for it — the error they had already produced never printed.
test("status and result reject flags that lost their value instead of blocking", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  const seed = `
    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE)});
    upsertJob(${JSON.stringify(cwd)}, {
      id: "task-valueless-flag",
      kind: "task",
      status: "running",
      cwd: ${JSON.stringify(cwd)},
      childPid: ${process.pid},
      promptPreview: "still going",
      startedAt: new Date().toISOString()
    });
  `;
  const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", seed], {
    env: fake.env,
    encoding: "utf8"
  });
  assert.equal(seeded.status, 0, seeded.stderr);

  for (const argv of [
    ["status", "task-valueless-flag", "--wait", "--timeout-ms"],
    ["result", "task-valueless-flag", "--wait", "--timeout-ms"]
  ]) {
    const startedAt = Date.now();
    const run = runCompanion(argv, { env: fake.env, cwd });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1, output);
    assert.match(output, /Invalid arguments: --timeout-ms requires a value/, argv.join(" "));
    assert.ok(
      Date.now() - startedAt < 15_000,
      `${argv.join(" ")} must be rejected rather than waiting out the default budget`
    );
  }

  // The other half of the same parse: a mistyped flag used to be read as a job
  // id (`status --jsn` → "No job found with id --jsn").
  const mistyped = runCompanion(["status", "--jsn"], { env: fake.env, cwd });
  assert.equal(mistyped.status, 1);
  assert.match(mistyped.stdout + mistyped.stderr, /Unknown flag: --jsn/);
  const mistypedResult = runCompanion(["result", "--strucutred-only"], { env: fake.env, cwd });
  assert.equal(mistypedResult.status, 1);
  assert.match(mistypedResult.stdout + mistypedResult.stderr, /Unknown flag: --strucutred-only/);
});

// The last member of that family. `transfer` read `flags` and dropped `errors`
// and `unknownFlags` on the floor, so `--source` with no value fell through to
// the transcript the SessionStart hook exported — handing off *a* session, just
// not the one the caller named — and a mistyped flag was ignored entirely.
test("transfer rejects the arguments it could not parse", () => {
  const fake = makeFakeEnv({ extra: { AGY_COMPANION_TRANSCRIPT_PATH: "/nonexistent/fallback.jsonl" } });
  const cwd = makeTempGitRepo();

  const valueless = runCompanion(["transfer", "--source"], { env: fake.env, cwd });
  const valuelessOutput = valueless.stdout + valueless.stderr;
  assert.equal(valueless.status, 1, valuelessOutput);
  assert.match(valuelessOutput, /Invalid arguments: --source requires a value/);
  assert.doesNotMatch(
    valuelessOutput,
    /fallback\.jsonl/,
    "a --source that lost its value must not fall back to the exported transcript"
  );

  const mistyped = runCompanion(["transfer", "--sorce", "/tmp/whatever.jsonl"], { env: fake.env, cwd });
  const mistypedOutput = mistyped.stdout + mistyped.stderr;
  assert.equal(mistyped.status, 1, mistypedOutput);
  assert.match(mistypedOutput, /Unknown flag: --sorce/);

  // Neither form may reach agy: the fixture records its argv only when it
  // is actually spawned.
  assert.equal(fs.existsSync(fake.argsFile), false, "a rejected transfer must not start a run");
});
