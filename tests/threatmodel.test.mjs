import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, readRunArgs, REPO_ROOT, runCompanion } from "./helpers.mjs";

const PROMPT = fs.readFileSync(
  path.join(REPO_ROOT, "plugins", "agy", "prompts", "adversarial-review.md"),
  "utf8"
);

// X3: an unbounded adversarial review reports network-attacker findings against
// a single-user local tool, and those findings then stop the user's actual
// work. Their words, verbatim: "please stop interrupting my task".
test("the adversarial prompt asks for a boundary and neutral vocabulary", () => {
  assert.match(PROMPT, /\{\{THREAT_MODEL\}\}/);
  assert.match(PROMPT, /`in-model`.*`out-of-model`/s);
  assert.match(PROMPT, /Out-of-model findings alone are never enough for `needs-attention`/);
  // Security-filter bait: the sibling runtime aborted a task outright on
  // `cyber_policy` after an adversarial review prompt full of attack language.
  for (const word of ["attacker", "malicious", "attack chain", "attack_surface"]) {
    assert.ok(!PROMPT.includes(word), `the prompt should avoid "${word}"`);
  }
});

test("--threat-model reaches the reviewer, and its absence has a stated default", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();

  const withModel = runCompanion(
    ["adversarial-review", "--threat-model", "single-user local tool, no network exposure"],
    { env: fake.env, cwd }
  );
  assert.equal(withModel.status, 0, withModel.stdout + withModel.stderr);
  assert.match(readRunArgs(fake).at(-1), /single-user local tool, no network exposure/);

  runCompanion(["adversarial-review"], { env: fake.env, cwd });
  const prompt = readRunArgs(fake).at(-1);
  assert.match(prompt, /No threat model was supplied by the caller/);
  assert.match(prompt, /single-user local application/);
  assert.match(prompt, /no network exposure/);
  // The default has to be exactly what README, the two skills, the slash
  // command and the changelog all promise it is. It carried an extra "and no
  // untrusted input" clause that appears in none of them — and it is false of
  // this runtime, whose inputs are caller flags, `--prompt-file` contents, git
  // remotes and repository files. Under that clause the reviewer is entitled
  // to push every argument-handling and untrusted-diff finding out of model,
  // where the prompt then forbids it from producing `needs-attention`.
  assert.doesNotMatch(prompt, /untrusted input/);
});

// Plain `review` shared the flag spec, so it accepted --threat-model, escaped
// the unknown-flag rejection, and then dropped the text during interpolation:
// `prompts/review.md` has no {{THREAT_MODEL}} slot. Documented nowhere,
// rejected nowhere, honoured nowhere — the shape 补充发现 3 rules out.
test("plain review rejects --threat-model instead of accepting and dropping it", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();
  const boundary = "single-user local tool XYZZY";

  const rejected = runCompanion(["review", "--threat-model", boundary], { env: fake.env, cwd });
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stdout, /Unknown flag: --threat-model/);
  assert.match(rejected.stdout, /adversarial-review flag/);
  assert.equal(fs.existsSync(fake.argsFile), false, "the run must not start with a flag that cannot be honoured");

  // The review prompt has no slot for it, and none is invented.
  const reviewPrompt = fs.readFileSync(path.join(REPO_ROOT, "plugins", "agy", "prompts", "review.md"), "utf8");
  assert.doesNotMatch(reviewPrompt, /THREAT_MODEL/);

  // The adversarial command still honours it end to end.
  const accepted = runCompanion(["adversarial-review", "--threat-model", boundary], { env: fake.env, cwd });
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(readRunArgs(fake).at(-1), /XYZZY/);
});
