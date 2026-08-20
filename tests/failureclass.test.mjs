import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { classifyFailure, FAILURE_CLASS_GUIDANCE } from "../plugins/agy/scripts/lib/agycli.mjs";
import { makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";

// P-MODEL: agy reports *why* it could not run on stderr, and the caller
// used to get 15 undifferentiated lines of it. Misclassification must never
// change the pass/fail verdict — only the next step printed above the tail.
test("classifyFailure names the recoverable classes and falls back safely", () => {
  const cases = [
    ["AI_APICallError: 403 not authorized to access the requested model", "model_unauthorized"],
    ["Error: Model not found: AIHubMix/gpt-5. Did you mean: aihubmix/gpt-5?", "model_not_found"],
    ["402 payment required: your credit balance is insufficient", "quota_exhausted"],
    ["401 unauthorized: no credentials found for provider anthropic", "auth_required"],
    ["Unexpected server error (500) from provider", "provider_error"],
    ["something nobody has ever seen before", "agy_failed"],
    ["", "agy_failed"]
  ];
  for (const [stderrTail, expected] of cases) {
    assert.equal(classifyFailure({ exitCode: 1, stderrTail }), expected, stderrTail);
    assert.ok(FAILURE_CLASS_GUIDANCE[expected], `${expected} needs a next step`);
  }

  // A run that did not fail has no failure class at all.
  assert.equal(classifyFailure({ exitCode: 0, stderrTail: "403 not authorized to use the model" }), null);
  // A spawn failure is about the binary, not the provider.
  assert.equal(classifyFailure({ exitCode: null, spawnError: "ENOENT", stderrTail: "" }), "agy_failed");
});

// X3: three separate ways the classifier read a tail as something it was not.
// The verdict never moved with it, but `failureClass` is a machine field on the
// job record and in `--json`, and orchestrators branch on it.
test("classifyFailure does not read HTTP codes or English out of context", () => {
  const cases = [
    // A bare 403 is what git says about a private remote. Sending the caller to
    // "choose a model the provider actually grants" is a wrong instruction, and
    // "retrying will not help" is a wrong claim.
    [
      "fatal: unable to access 'https://github.com/acme/private.git/': The requested URL returned error: 403",
      "agy_failed"
    ],
    // 429 is the one genuinely transient class, and it used to fall through to
    // the bucket whose guidance says there is no recognised reason.
    ["AI_APICallError: 429 Too Many Requests: rate limit exceeded", "rate_limited"],
    ["Error: the upstream provider is overloaded, try again shortly", "rate_limited"],
    // Billing beats throughput when a provider says both: waiting does not
    // refill a balance.
    ["429 You exceeded your current quota, please check your plan and billing details", "quota_exhausted"],
    // Ordinary English in an error line is not agy's model-id hint.
    ["Aborted: Did you mean to run the tests first? No model id here.", "agy_failed"],
    // 403 with model context still classifies, in both orders.
    ["provider refused: model anthropic/claude-opus-4-1 returned HTTP 403", "model_unauthorized"]
  ];
  for (const [stderrTail, expected] of cases) {
    assert.equal(classifyFailure({ exitCode: 1, stderrTail }), expected, stderrTail);
    assert.ok(FAILURE_CLASS_GUIDANCE[expected], `${expected} needs a next step`);
  }
});

// The model's own answer is not evidence about the provider. It used to be half
// the haystack, so a run that failed after writing about an HTTP code took the
// class from its own prose.
test("classifyFailure reads stderr only, never the model's own output", () => {
  const rawOutput = "I checked the endpoint and it returns HTTP 403. Did you mean: src/app.mjs?";
  assert.equal(classifyFailure({ exitCode: 1, stderrTail: "", rawOutput }), "agy_failed");
  assert.equal(
    classifyFailure({ exitCode: 1, stderrTail: "402 payment required", rawOutput }),
    "quota_exhausted",
    "and the stderr class is unaffected by whatever the model said"
  );
});

test("a quota failure is reported as unretryable instead of as raw stderr", () => {
  const fake = makeFakeEnv({
    mode: "fail",
    extra: {
      AGY_FAKE_STDERR:
        "AI_APICallError: 402 Payment Required — your credit balance is insufficient for this request"
    }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--", "summarise the diff"], { env: fake.env, cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /provider balance or quota is exhausted/i);
  assert.match(result.stdout, /not a plugin or prompt problem/i);
  // The raw tail stays exactly where it was — the class only adds a line above it.
  assert.match(result.stdout, /Most recent stderr:/);
  assert.match(result.stdout, /402 Payment Required/);
  assert.ok(
    result.stdout.indexOf("quota") < result.stdout.indexOf("Most recent stderr:"),
    "the next step must come before the stderr block"
  );

  const jsonResult = runCompanion(["task", "--json", "--", "summarise the diff"], { env: fake.env, cwd });
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.failureClass, "quota_exhausted");

  // And it is on the job record, so `status`/`result` say the same thing later.
  const stateFile = fs
    .readdirSync(path.join(fake.stateDir, "state"))
    .map((entry) => path.join(fake.stateDir, "state", entry, "state.json"))
    .find((candidate) => fs.existsSync(candidate));
  const jobs = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
  assert.ok(
    jobs.every((job) => job.failureClass === "quota_exhausted"),
    JSON.stringify(jobs.map((job) => [job.id, job.status, job.failureClass]))
  );
  assert.ok(jobs.every((job) => job.status === "failed"));
});

test("a rate-limited run is labelled retryable end to end", () => {
  const fake = makeFakeEnv({
    mode: "fail",
    extra: { AGY_FAKE_STDERR: "AI_APICallError: 429 Too Many Requests: rate limit exceeded" }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--", "summarise the diff"], { env: fake.env, cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Next step \(rate_limited\)/);
  assert.match(result.stdout, /wait and re-run the same request/i);
  assert.match(result.stdout, /429 Too Many Requests/, "the raw tail is still printed unchanged");

  const payload = JSON.parse(
    runCompanion(["task", "--json", "--", "summarise the diff"], { env: fake.env, cwd }).stdout
  );
  assert.equal(payload.failureClass, "rate_limited");
  assert.equal(payload.outputState, "failed", "a new class must not change the verdict");
});

test("an unauthorized model failure keeps the verdict and adds the next step", () => {
  const fake = makeFakeEnv({
    mode: "fail",
    extra: { AGY_FAKE_STDERR: "403 not authorized to access the requested model" }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--", "summarise the diff"], { env: fake.env, cwd });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureClass, "model_unauthorized");
  assert.equal(payload.ok, false);
  assert.equal(payload.outputState, "failed");
  assert.equal(result.status, 1);
});
