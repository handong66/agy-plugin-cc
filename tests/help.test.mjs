import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, readRunArgs, runCompanion } from "./helpers.mjs";
import { parseFlags } from "../plugins/agy/scripts/lib/args.mjs";

// The prompt rides in the `-p` value of the agy flag vector, not in the last
// positional argument.
function promptOf(fake) {
  const args = readRunArgs(fake);
  return args[args.indexOf("-p") + 1];
}

// P-HELP: `task --help` used to reach agy as the prompt text and come back
// as a *model-generated* help page for the agy CLI — three recorded
// sessions, one of them stored as `completed` with a 14s duration.
test("task --help prints companion usage instead of spending a model turn", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--help"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agy-companion task/);
  assert.match(result.stdout, /--timeout-ms/);
  assert.match(result.stdout, /--read-only/);
  assert.match(result.stdout, /--background/, "help must state what happens to the Claude-side flags");
  assert.equal(fs.existsSync(fake.argsFile), false, "help must not spawn agy");

  const jobs = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).jobs;
  assert.equal(jobs.length, 0, "help must not create a job");
});

test("every known subcommand answers -h with its own flags", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  const expectations = {
    review: /--scope/,
    "adversarial-review": /focus text/,
    status: /--wait/,
    result: /--wait/,
    cancel: /cancel \[job-id\]/,
    transfer: /--source/,
    setup: /--enable-review-gate/,
    "task-resume-candidate": /--json/
  };

  for (const [subcommand, pattern] of Object.entries(expectations)) {
    const result = runCompanion([subcommand, "-h"], { env: fake.env, cwd });
    assert.equal(result.status, 0, `${subcommand} -h: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`agy-companion ${subcommand}`), `${subcommand} -h`);
    assert.match(result.stdout, pattern, `${subcommand} -h must list its real flags`);
  }
  assert.equal(fs.existsSync(fake.argsFile), false, "help must never spawn agy");
});

// `SUBCOMMAND_HELP[subcommand]` was a bare property read on an object literal,
// so any inherited `Object.prototype` name answered it: `constructor --help`
// found the Object constructor, passed the truthiness test that gates the help
// intercept, and was then spread into an array — `TypeError: perCommand is not
// iterable`, plus a stack trace, for a typo.
test("a subcommand named after an Object.prototype member does not crash", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  for (const subcommand of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    for (const argv of [[subcommand, "--help"], [subcommand, "-h"], [subcommand]]) {
      const result = runCompanion(argv, { env: fake.env, cwd });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 0, `${argv.join(" ")}: ${output}`);
      assert.doesNotMatch(output, /TypeError|not iterable|\bat main\b/, `${argv.join(" ")} must not throw`);
      // An unknown subcommand answers with the top-level help, whatever it is
      // named.
      assert.match(result.stdout, /Subcommands \(run `<subcommand> --help` for its flags\):/, argv.join(" "));
    }
  }
  assert.equal(fs.existsSync(fake.argsFile), false, "an unknown subcommand must never spawn agy");
});

test("the top-level help still lists every subcommand", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["--help"], { env: fake.env, cwd: makeTempGitRepo() });
  assert.equal(result.status, 0, result.stderr);
  for (const subcommand of ["setup", "task", "review", "status", "result", "cancel", "transfer"]) {
    assert.match(result.stdout, new RegExp(`\\b${subcommand}\\b`));
  }
});

// A leading unknown flag is a mistake, not prompt text: `--background` being
// trusted blindly is the same blindness in the other direction.
test("task refuses a leading unknown flag and names the escape hatch", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--wrote", "the", "fix"], { env: fake.env, cwd });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Unknown flag: --wrote/);
  assert.match(result.stdout + result.stderr, /task --help/);
  assert.match(result.stdout + result.stderr, /quote it/);
  assert.equal(fs.existsSync(fake.argsFile), false, "a rejected invocation must not spawn agy");
});

// args.mjs:49 deliberately protects natural-language task text that contains
// dashes. That leniency has to survive, and `--` has to switch it on explicitly.
test("dashes inside task text stay task text", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["task", "--read-only", "fix", "the", "--dry-run", "path"], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(promptOf(fake), "fix the --dry-run path");
});

test("-- makes everything after it task text, including --help", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["task", "--read-only", "--", "--help", "the", "--background", "flag"], {
    env: fake.env,
    cwd: makeTempGitRepo()
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(promptOf(fake), "--help the --background flag");
});

test("parseFlags reports leading unknown flags and stops at the sentinel", () => {
  const spec = { valueFlags: ["--model"], booleanFlags: ["--json"] };

  const bad = parseFlags(["--wrote", "a", "fix"], spec);
  assert.deepEqual(bad.unknownFlags, ["--wrote"]);

  // After free text begins, a dash is part of the prose again.
  const lenient = parseFlags(["fix", "the", "--dry-run", "path"], spec);
  assert.deepEqual(lenient.unknownFlags, []);
  assert.deepEqual(lenient.rest, ["fix", "the", "--dry-run", "path"]);

  const sentinel = parseFlags(["--json", "--", "--wrote", "--json"], spec);
  assert.deepEqual(sentinel.unknownFlags, []);
  assert.equal(sentinel.flags.get("--json"), true);
  assert.deepEqual(sentinel.rest, ["--wrote", "--json"], "nothing after -- is a flag");
});
