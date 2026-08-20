import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, readRunArgs, runCompanion } from "./helpers.mjs";

// A review that validates against plugins/agy/schemas/review-output.schema.json,
// staged the way a real --json-schema run returns it (fixture AGY_FAKE_STRUCTURED).
// Without it the fixture's placeholder review object fails schema validation and
// the run lands on `incomplete` — the flag tests below are about flags, not
// about the review being well-formed.
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

function reviewEnv() {
  return makeFakeEnv({ mode: "review-json", extra: { AGY_FAKE_STRUCTURED: JSON.stringify(VALID_REVIEW) } });
}

// 补充发现 4: `--scope` went straight through to lib/git.mjs, so the two values
// the command docs explicitly call unsupported (`staged`, `unstaged`) silently
// fell into the working-tree branch and the caller got a review of something
// else — then relayed it verbatim as authoritative.
test("a mistyped --scope fails fast instead of reviewing something else", () => {
  const fake = reviewEnv();
  const cwd = makeTempGitRepo();

  for (const scope of ["staged", "unstaged", "workingtree"]) {
    const result = runCompanion(["review", "--scope", scope], { env: fake.env, cwd });
    assert.equal(result.status, 1, `--scope ${scope} must be rejected`);
    assert.match(result.stdout, /--scope/);
    assert.match(result.stdout, /auto.*working-tree.*branch/s, result.stdout);
    // Nothing was run: no agy invocation happened at all.
    assert.equal(fs.existsSync(fake.argsFile), false, `--scope ${scope} still spawned agy`);
  }

  const ok = runCompanion(["review", "--scope", "working-tree"], { env: fake.env, cwd });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

// 补充发现 3: `--model` / `--variant` landed in `rest` and were dropped without
// a word, while README taught `/agy:review --model anthropic/...`.
// agy names the dial `--effort` (low|medium|high); `--variant` is kept as an
// alias and canonicalised onto it — the vector never speaks opencode's flag.
test("review forwards --model and --variant onto agy's own flag names", () => {
  const fake = reviewEnv();
  const cwd = makeTempGitRepo();

  const result = runCompanion(["review", "--model", "fake/model-two", "--variant", "high"], {
    env: fake.env,
    cwd
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const args = readRunArgs(fake);
  assert.ok(args.includes("--model"), JSON.stringify(args));
  assert.equal(args[args.indexOf("--model") + 1], "fake/model-two");
  assert.ok(args.includes("--effort"), "the variant must reach agy as --effort");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.ok(!args.includes("--variant"), "the vector speaks agy's own flag name");
});

test("an unknown review flag is refused, and focus text reaches the reviewer", () => {
  const fake = reviewEnv();
  const cwd = makeTempGitRepo();

  const unknown = runCompanion(["review", "--scpoe", "branch"], { env: fake.env, cwd });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /Unknown flag: --scpoe/);
  assert.match(unknown.stdout, /--scope/, "the error must list what review does accept");
  assert.equal(fs.existsSync(fake.argsFile), false);

  // Free text used to be dropped without a word by non-adversarial `review`
  // (PC6 gave it a slot instead of a warning), so a caller believed their
  // instructions had reached the reviewer when they had not.
  const focused = runCompanion(["review", "focus", "on", "the", "lock"], { env: fake.env, cwd });
  assert.equal(focused.status, 0, focused.stdout + focused.stderr);
  const args = readRunArgs(fake);
  assert.match(args[args.indexOf("-p") + 1], /User focus: focus on the lock/);
});

test("adversarial review still passes its focus text through", () => {
  const fake = reviewEnv();
  const cwd = makeTempGitRepo();

  const result = runCompanion(["adversarial-review", "check", "the", "lock", "path"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const args = readRunArgs(fake);
  assert.match(args[args.indexOf("-p") + 1], /check the lock path/);
});
