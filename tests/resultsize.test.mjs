import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

function storeDirOf(fake) {
  const stateRoot = path.join(fake.stateDir, "state");
  return path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
}

// P-RESULTSIZE 1: `String(x).trim() ?? "[no output stored]"` can never produce
// the placeholder — `.trim()` always returns a string — so an empty payload
// printed a blank line, indistinguishable from a store that could not be read.
test("an empty stored payload says so instead of printing a blank line", () => {
  const fake = makeFakeEnv({ mode: "empty-text" });
  const cwd = makeTempGitRepo();

  const run = runCompanion(["task", "--", "produce nothing"], { env: fake.env, cwd });
  const jobId = run.stdout.match(/Job: (task-[\w-]+)/)[1];

  const jobFile = path.join(storeDirOf(fake), "jobs", `${jobId}.json`);
  const payload = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  fs.writeFileSync(jobFile, JSON.stringify({ ...payload, rendered: "", rawOutput: "" }, null, 2));

  const result = runCompanion(["result", jobId], { env: fake.env, cwd });
  assert.match(result.stdout, /\[no output stored for job task-/);
});

// P-RESULTSIZE 2: the machine-readable channel exists, so the answer to "this
// output is too big" is a narrower channel, not a truncation flag that would
// invite the lossy compression `commands/result.md` forbids.
test("--structured-only yields the review object, or a reason and exit 1", () => {
  const fake = makeFakeEnv({ mode: "review-json", extra: { AGY_FAKE_STRUCTURED: JSON.stringify(VALID_REVIEW) } });
  const cwd = makeTempGitRepo();

  runCompanion(["review"], { env: fake.env, cwd });
  const structured = runCompanion(["result", "--structured-only"], { env: fake.env, cwd });
  assert.equal(structured.status, 0, structured.stdout + structured.stderr);
  const review = JSON.parse(structured.stdout);
  assert.equal(review.verdict, "needs-attention");
  assert.equal(review.findings.length, 1);

  const taskFake = makeFakeEnv();
  const taskCwd = makeTempGitRepo();
  runCompanion(["task", "--", "no schema here"], { env: taskFake.env, cwd: taskCwd });
  const missing = runCompanion(["result", "--structured-only"], { env: taskFake.env, cwd: taskCwd });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /no structured output/);
  assert.match(missing.stdout, /--json/);
});
