import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { COMPANION, makeFakeEnv, makeTempDir, makeTempGitRepo, readRunArgs, runCompanion } from "./helpers.mjs";
import { splitAtSentinel } from "../plugins/agy/scripts/lib/args.mjs";

// The exact Phase 1 corpus case: the documented single-argument form ran the
// prompt through `tokenize`, which drops quote characters, swallows everything
// after an apostrophe, and folds newlines into spaces. 8 of 39 recorded task
// calls used that form, all of them carrying quoted, multi-line review
// contracts.
const HOSTILE_PROMPT = `<task>\nReview "foo" and don't break it.\n- line A\n- line B\n</task>`;

test("everything after -- survives the single-argument form byte for byte", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["task", `--read-only -- ${HOSTILE_PROMPT}`], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  assert.equal(result.status, 0, result.stderr);

  const runArgs = readRunArgs(fake);
  assert.equal(runArgs.at(-1), HOSTILE_PROMPT);
  assert.equal(runArgs[runArgs.indexOf("--agent") + 1], "plan", "flags before -- are still parsed");
});

test("--prompt-file passes the file through untouched", () => {
  const fake = makeFakeEnv();
  const promptDir = makeTempDir("agy-prompt");
  const promptFile = path.join(promptDir, "prompt.md");
  fs.writeFileSync(promptFile, `${HOSTILE_PROMPT}\n`);

  const result = runCompanion(["task", "--read-only", "--prompt-file", promptFile], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readRunArgs(fake).at(-1), HOSTILE_PROMPT);
});

test("--prompt-stdin reads the prompt from stdin", () => {
  const fake = makeFakeEnv();
  const result = spawnSync(process.execPath, [COMPANION, "task", "--read-only", "--prompt-stdin"], {
    cwd: makeTempGitRepo(),
    env: fake.env,
    input: HOSTILE_PROMPT,
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readRunArgs(fake).at(-1), HOSTILE_PROMPT);
});

test("a missing --prompt-file fails loudly instead of running an empty prompt", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["task", "--prompt-file", "/nope/does-not-exist.md"], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Could not read --prompt-file/);
  assert.equal(fs.existsSync(fake.argsFile), false);
});

test("a prompt file plus free text is a conflict, not a silent drop", () => {
  const fake = makeFakeEnv();
  const promptDir = makeTempDir("agy-prompt");
  const promptFile = path.join(promptDir, "prompt.md");
  fs.writeFileSync(promptFile, "from the file\n");

  const result = runCompanion(["task", "--prompt-file", promptFile, "and", "also", "this"], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Put everything in one place/);
});

test("splitAtSentinel only splits on a standalone --", () => {
  assert.deepEqual(splitAtSentinel("--read-only -- keep  this\nintact"), {
    head: "--read-only ",
    literal: "keep  this\nintact"
  });
  assert.deepEqual(splitAtSentinel("fix the --dry-run path"), {
    head: "fix the --dry-run path",
    literal: null
  });
  assert.equal(splitAtSentinel("--write --\nmulti\nline").literal, "multi\nline");
});

// The sentinel is a *leading* marker, the same way an unknown `--flag` only
// counts before the free text starts. It used to be positional-blind, so a
// standalone `--` inside ordinary prose was eaten: `run the suite -- then
// report` reached agy as `run the suite then report`, quietly rewriting
// the instruction into a different one that still reads as English.
test("a standalone -- inside task text stays task text", () => {
  assert.deepEqual(splitAtSentinel("run the suite -- then report"), {
    head: "run the suite -- then report",
    literal: null
  });
  // Only flags (and their values) may precede the sentinel.
  assert.equal(splitAtSentinel("--model a/b -- the prompt").literal, "the prompt");
  assert.equal(splitAtSentinel("-- the prompt").literal, "the prompt");

  const fake = makeFakeEnv();
  const result = runCompanion(["task", "run the suite -- then report"], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readRunArgs(fake).at(-1), "run the suite -- then report");
});
