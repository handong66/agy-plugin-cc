import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { collectReviewInput, parseRange } from "../plugins/agy/scripts/lib/git.mjs";
import { makeFakeEnv, makeTempDir, makeTempGitRepo, readRunArgs, runCompanion } from "./helpers.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// The prompt rides in the `-p` value of the agy flag vector.
function promptOf(fake) {
  const args = readRunArgs(fake);
  return args[args.indexOf("-p") + 1];
}

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

// PC6: every real review request in the corpus was a commit range and a file
// set (`git diff 71dcdc5..HEAD`, "the documents under docs/"), which the old
// selector could not express — so `review` was used zero times in two months.
function makeHistory() {
  const cwd = makeTempGitRepo();
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "--quiet", "-m", "first"]);
  const first = git(cwd, ["rev-parse", "HEAD"]).trim();

  fs.mkdirSync(path.join(cwd, "docs"));
  fs.writeFileSync(path.join(cwd, "docs", "spec.md"), "# spec\n\nrule one\n");
  fs.writeFileSync(path.join(cwd, "src.mjs"), "export const changed = true;\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "--quiet", "-m", "second"]);
  return { cwd, first };
}

test("a commit range can be written the way callers actually write it", () => {
  assert.deepEqual(parseRange("a..b"), { base: "a", head: "b", symmetric: false });
  assert.deepEqual(parseRange("a...b"), { base: "a", head: "b", symmetric: true });
  assert.deepEqual(parseRange("main..HEAD"), { base: "main", head: "HEAD", symmetric: false });
  assert.equal(parseRange("main"), null);

  const { cwd, first } = makeHistory();
  const asRange = collectReviewInput(cwd, { base: `${first}..HEAD` });
  assert.equal(asRange.isEmpty, false);
  assert.match(asRange.label, /diff [0-9a-f]+\.\.HEAD/);
  assert.match(asRange.input, /docs\/spec\.md/);
  assert.match(asRange.input, /src\.mjs/);

  // The same target reached through --base/--head.
  const asRefs = collectReviewInput(cwd, { base: first, head: "HEAD" });
  assert.equal(asRefs.isEmpty, false);
  assert.match(asRefs.input, /src\.mjs/);
});

test("a path filter narrows the review to the files that were asked about", () => {
  const { cwd, first } = makeHistory();
  const docsOnly = collectReviewInput(cwd, { base: `${first}..HEAD`, paths: ["docs"] });
  assert.match(docsOnly.input, /docs\/spec\.md/);
  assert.doesNotMatch(docsOnly.input, /export const changed/);
  assert.match(docsOnly.label, /limited to docs/);

  const nothingThere = collectReviewInput(cwd, { base: `${first}..HEAD`, paths: ["no-such-dir"] });
  assert.equal(nothingThere.isEmpty, true);
});

test("a bad ref is named, and truncation is reported as data", () => {
  const { cwd } = makeHistory();
  assert.throws(() => collectReviewInput(cwd, { base: "nope..HEAD" }), /Ref not found: nope/);

  // A clean tree is empty, not truncated.
  assert.equal(collectReviewInput(cwd, {}).isEmpty, true);

  fs.writeFileSync(path.join(cwd, "src.mjs"), "export const changed = false;\n");
  const working = collectReviewInput(cwd, {});
  assert.equal(working.truncated, false);
  assert.equal(typeof working.totalChars, "number");
  assert.ok(working.totalChars > 0);
});

// `--head` without `--base` used to fall through to the working-tree arm: the
// caller named a commit and got a review of their dirty files, exit 0, no
// warning. That is the argument-drop family the unknown-flag rejection exists
// to close, so it has to fail loudly instead.
test("--head without --base is refused instead of reviewing the working tree", () => {
  const { cwd, first } = makeHistory();
  assert.throws(() => collectReviewInput(cwd, { head: first }), /--head <ref> names one end of a commit range/);
  // The pair still works, and so does --scope branch with a base.
  assert.equal(collectReviewInput(cwd, { base: first, head: "HEAD" }).isEmpty, false);

  // End to end: a dirty tree is present, so the old behaviour would have exited
  // 0 with a working-tree review of it.
  fs.writeFileSync(path.join(cwd, "dirty.mjs"), "export const dirty = true;\n");
  const fake = makeFakeEnv({ mode: "review-json" });
  const result = runCompanion(["review", "--head", first], { env: fake.env, cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /--head <ref> names one end of a commit range/);
  assert.doesNotMatch(result.stdout, /uncommitted working tree changes/);
  assert.equal(fs.existsSync(fake.argsFile), false, "agy must not be spawned for a refused target");
});

test("review accepts focus text, a rubric and a range end to end", () => {
  const { cwd, first } = makeHistory();
  const fake = makeFakeEnv({ mode: "review-json", extra: { AGY_FAKE_STRUCTURED: JSON.stringify(VALID_REVIEW) } });
  const rubricFile = path.join(makeTempDir("agy-rubric"), "rubric.md");
  fs.writeFileSync(rubricFile, "blocker = critical; major = high; nit = low\n");

  const result = runCompanion(
    ["review", "--base", `${first}..HEAD`, "--paths", "docs", "--rubric-file", rubricFile, "check", "the", "spec", "wording"],
    { env: fake.env, cwd }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const prompt = promptOf(fake);
  assert.match(prompt, /User focus: check the spec wording/);
  assert.match(prompt, /blocker = critical/);
  assert.match(prompt, /docs\/spec\.md/);
  assert.doesNotMatch(prompt, /export const changed/);
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/, "no placeholder may survive interpolation");
});
