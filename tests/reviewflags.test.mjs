import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, readRunArgs, runCompanion } from "./helpers.mjs";

// 补充发现 4: `--scope` went straight through to lib/git.mjs, so the two values
// the command docs explicitly call unsupported (`staged`, `unstaged`) silently
// fell into the working-tree branch and the caller got a review of something
// else — then relayed it verbatim as authoritative.
test("a mistyped --scope fails fast instead of reviewing something else", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
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
test("review forwards --model and --variant instead of dropping them", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["review", "--model", "fake/model-two", "--variant", "max"], {
    env: fake.env,
    cwd
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const args = readRunArgs(fake);
  assert.ok(args.includes("--model"), JSON.stringify(args));
  assert.equal(args[args.indexOf("--model") + 1], "fake/model-two");
  assert.equal(args[args.indexOf("--variant") + 1], "max");
});

test("an unknown review flag is refused, and focus text reaches the reviewer", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
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
  assert.match(readRunArgs(fake).at(-1), /User focus: focus on the lock/);
});

test("adversarial review still passes its focus text through", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["adversarial-review", "check", "the", "lock", "path"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const args = readRunArgs(fake);
  assert.match(args.at(-1), /check the lock path/);
});
