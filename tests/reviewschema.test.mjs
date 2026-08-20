import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { validateAgainstSchema } from "../plugins/agy/scripts/lib/agycli.mjs";
import { makeFakeEnv, makeTempGitRepo, REPO_ROOT, runCompanion } from "./helpers.mjs";

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "plugins", "agy", "schemas", "review-output.schema.json"), "utf8")
);

const VALID_REVIEW = {
  verdict: "approve",
  summary: "Read both call sites and the test; the change is safe.",
  findings: [],
  next_steps: []
};

// 补充发现 2: `renderReviewOutput` accepted any object, so `{"note":"I could
// not finish"}` rendered as `Verdict: NEEDS ATTENTION` + empty summary + "No
// material findings." — a confident clean review the model never wrote.
test("validateAgainstSchema accepts a real review and names what a fake one is missing", () => {
  assert.deepEqual(validateAgainstSchema(VALID_REVIEW, SCHEMA), []);

  const abandoned = validateAgainstSchema({ note: "I could not finish" }, SCHEMA);
  assert.ok(abandoned.length > 0);
  assert.match(abandoned.join("; "), /verdict/);
  assert.match(abandoned.join("; "), /summary/);
  assert.match(abandoned.join("; "), /findings/);

  // Wrong verdict vocabulary is the other observed shape (GO / NO_GO / …).
  assert.match(
    validateAgainstSchema({ ...VALID_REVIEW, verdict: "GO" }, SCHEMA).join("; "),
    /verdict/
  );
  // findings must be an array, not a bare object or a string.
  assert.match(
    validateAgainstSchema({ ...VALID_REVIEW, findings: { one: "thing" } }, SCHEMA).join("; "),
    /findings/
  );
  assert.deepEqual(validateAgainstSchema({ ...VALID_REVIEW, findings: [] }, SCHEMA), []);
  // An unknown extra key is not a reason to throw a good review away: the
  // renderer ignores keys it does not read.
  assert.deepEqual(validateAgainstSchema({ ...VALID_REVIEW, extra: 1 }, SCHEMA), []);
  // A finding the renderer would print as `undefined:undefined` is one.
  assert.ok(
    validateAgainstSchema({ ...VALID_REVIEW, findings: [{ severity: "high", title: "x" }] }, SCHEMA).length > 0
  );
});

test("a review that is not a review is incomplete, not a clean verdict", () => {
  const fake = makeFakeEnv({
    mode: "review-json",
    extra: { AGY_FAKE_REVIEW_JSON: JSON.stringify({ note: "I could not finish" }), AGY_FAKE_TOOLS: "3" }
  });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["review"], { env: fake.env, cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  // The synthetic conclusion must be gone.
  assert.doesNotMatch(result.stdout, /Verdict: NEEDS ATTENTION/);
  assert.doesNotMatch(result.stdout, /No material findings/);
  // The model's actual words survive.
  assert.match(result.stdout, /I could not finish/);
  assert.match(result.stdout, /did not match/i);

  const jsonResult = runCompanion(["review", "--json"], { env: fake.env, cwd });
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.outputState, "incomplete");
  assert.equal(payload.outputStateReason, "schema-mismatch");
  assert.equal(payload.review, null);
  assert.equal(payload.resultComplete, false);
});

test("a well-formed review still renders as a verdict", () => {
  const fake = makeFakeEnv({ mode: "review-json", extra: { AGY_FAKE_TOOLS: "3" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["review", "--json"], { env: fake.env, cwd });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputState, "completed");
  assert.equal(payload.review.verdict, "needs-attention");
  assert.equal(result.status, 0);
});

// A run that stops on a blacklisted `stopReason` is `incomplete` even when the
// JSON it had already emitted validates. The three channels then disagreed
// about the same job: the human render said "this is not a verdict, do not
// infer one", while `--json` handed back a populated `review` and
// `--structured-only` printed the object with exit 0. Whichever channel a
// caller happened to read decided whether the review counted.
test("an unfinished run does not publish its JSON as a verdict", () => {
  const fake = makeFakeEnv({
    mode: "review-json",
    extra: { AGY_FAKE_TOOLS: "3", AGY_FAKE_STOP_REASON: "tool-calls" }
  });
  const cwd = makeTempGitRepo();

  const human = runCompanion(["review"], { env: fake.env, cwd });
  assert.equal(human.status, 2, human.stdout + human.stderr);
  assert.match(human.stdout, /stopped before producing a final answer/);

  const json = runCompanion(["review", "--json"], { env: fake.env, cwd });
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.outputState, "incomplete");
  assert.equal(payload.outputStateReason, "stop-reason");
  assert.equal(payload.review, null, "an unfinished run has no verdict to publish");
  assert.equal(payload.resultComplete, false);
  // The text is still there — this withholds the verdict, it does not hide the
  // evidence.
  assert.match(payload.rawOutput, /"verdict"/);

  const structured = runCompanion(["result", payload.jobId, "--structured-only"], { env: fake.env, cwd });
  assert.equal(structured.status, 1, structured.stdout);
  assert.match(structured.stdout, /did not finish|incomplete/i);
  assert.match(structured.stdout, /--json/, "it must say where the object can still be read");

  // And it can: the stored payload keeps the object for anyone who asks for the
  // whole thing rather than for a verdict.
  const whole = JSON.parse(
    runCompanion(["result", payload.jobId, "--json"], { env: fake.env, cwd }).stdout
  );
  assert.equal(whole.payload.structuredOutput.verdict, "needs-attention");
});
