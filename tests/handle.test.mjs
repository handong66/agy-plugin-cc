import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";

// A review object that validates against the review output schema, so the fake
// review run finishes with exit 0 instead of failing as schema-mismatch.
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
      recommendation: "Await the computed delay before the next retry."
    }
  ],
  next_steps: ["Await the backoff delay."]
};

// PC1: the job id only ever appeared in the footer *after* the run, so a caller
// who detached the companion with Bash(run_in_background: true) — 28 recorded
// times — had no handle to poll while the run was in flight, and hand-rolled
// shadow job control (`seq 1 240` loops, grep on log files) instead.
test("task prints its job handle before the run starts", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "the answer" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--write", "do the thing"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);

  const [firstLine] = result.stdout.split("\n");
  const match = firstLine.match(/^Job: (\S+) \(task, running\) — poll with \/agy:status \1$/);
  assert.ok(match, `expected a handle line first, got: ${firstLine}`);
  assert.match(result.stdout, new RegExp(`Job: ${match[1]} \\(task, completed`), "same id in the footer");
});

test("--json keeps stdout a single document and puts the handle on stderr", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "the answer" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--write", "do the thing"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  const handleLine = result.stderr.split("\n").find((line) => line.startsWith("{"));
  const handle = JSON.parse(handleLine);
  assert.equal(handle.jobId, payload.jobId);
  assert.equal(handle.pollWith, `/agy:status ${payload.jobId}`);
  assert.match(handle.logFile, /\.log$/);
});

// The same contract on the path that does no work: `--resume-last` in a
// repository that has never run a job. The success branch was routed to stderr
// when the handle went there; this one kept printing a sentence to stdout ahead
// of the payload, so JSON.parse failed on the most ordinary state there is.
test("--json stays a single parseable document when there is nothing to resume", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "the answer" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--resume-last", "--", "hello world"], {
    env: fake.env,
    cwd
  });
  assert.equal(result.status, 0, result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.resumedFrom, null, "there was no session to resume");
  assert.equal(payload.outputState, "completed", "and the run itself still happened");
  assert.doesNotMatch(result.stdout, /No previous agy session/, "the notice must not precede the JSON");
  assert.match(result.stderr, /No previous agy session found for this repository/, "but it is still reported");
});

// The review half of the same family: an empty target printed a sentence and
// exited 0, so a `--json` caller got neither a document to parse nor a code to
// branch on — and a clean tree is the most benign thing a fan-in scheduler
// asks about.
test("review --json reports an empty target as JSON instead of a sentence", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "--quiet", "-m", "clean"], { cwd });

  const result = runCompanion(["review", "--json"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true, "an empty target is not a failure");
  assert.equal(payload.isEmpty, true);
  assert.equal(payload.outputState, "empty");
  assert.equal(payload.review, null);
  assert.equal(payload.resultComplete, false, "there is no verdict to count as an answer");
  assert.match(payload.label, /uncommitted working tree changes/);
  assert.equal(fs.existsSync(fake.argsFile), false, "and no model was paid to review nothing");

  // Adversarial takes the same branch, and the human channel keeps its prose.
  const adversarial = runCompanion(["adversarial-review", "--json"], { env: fake.env, cwd });
  assert.equal(JSON.parse(adversarial.stdout).outputState, "empty");
  const human = runCompanion(["review"], { env: fake.env, cwd });
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /Nothing to review: no changes found for/);
});

test("review announces its handle too", () => {
  const fake = makeFakeEnv({ mode: "review-json", extra: { AGY_FAKE_STRUCTURED: JSON.stringify(VALID_REVIEW) } });
  const result = runCompanion(["review"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.split("\n")[0], /^Job: \S+ \(review, running\)/);
});

// The result-handling skill used to promise `JSON.parse(stdout)` was "always
// safe" under `--json`. It is safe for every path that reaches a run — which is
// what FB-01 and FB-02 fixed — but not for a request rejected before one
// starts, and those paths print prose on stdout to this day. This pins both
// halves so the sentence in the skill stays true of the runtime.
test("--json emits a document for every run, and prose only for a rejected request", () => {
  const cwd = makeTempGitRepo();

  // Reached a run: a document whatever the exit code says.
  for (const [mode, expectedStatus] of [["fail", 1], ["silent", 1], ["success", 0]]) {
    const fake = makeFakeEnv({ mode });
    const run = runCompanion(["task", "--json", "--", "do the work"], { env: fake.env, cwd });
    assert.equal(run.status, expectedStatus, `${mode}: ${run.stdout}${run.stderr}`);
    const document = JSON.parse(run.stdout);
    assert.equal(typeof document.jobId, "string", `${mode} must still address its job`);
  }

  // Rejected before a run: plain text on stdout and exit 1. A caller must be
  // able to tell these apart by parse failure alone, so none of them may look
  // like a result.
  const rejected = [
    ["task", "--json", "--timeout-ms", "later", "--", "x"],
    ["task", "--json"],
    ["review", "--json", "--scope", "staged"],
    ["review", "--json", "--base", "nosuchref"],
    ["status", "no-such-job", "--json"],
    ["result", "no-such-job", "--json"]
  ];
  for (const argv of rejected) {
    const fake = makeFakeEnv({ mode: "review-json" });
    const run = runCompanion(argv, { env: fake.env, cwd });
    assert.equal(run.status, 1, `${argv.join(" ")}: ${run.stdout}${run.stderr}`);
    assert.throws(() => JSON.parse(run.stdout), `${argv.join(" ")} must not look like a result`);
    assert.ok(run.stdout.trim().length > 0, `${argv.join(" ")} must say what was wrong`);
  }
});
