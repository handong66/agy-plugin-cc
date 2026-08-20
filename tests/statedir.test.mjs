import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { spawnSync } from "node:child_process";

import { makeFakeEnv, makeTempDir, makeTempGitRepo, REPO_ROOT, runCompanion } from "./helpers.mjs";

// M2/PC7: 0.1.1 added the namespaced env var but kept `CLAUDE_PLUGIN_DATA` as a
// fallback, and that name holds whichever plugin's SessionStart hook ran last —
// which is how agy job logs ended up under codex-inline/state/... Any Bash
// context that never sourced the session env file re-entered the collision.
test("CLAUDE_PLUGIN_DATA no longer decides where state lands", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "answer" } });
  const decoyOnly = { ...fake.env };
  delete decoyOnly.AGY_COMPANION_DATA_DIR;
  const cwd = makeTempGitRepo();

  const result = runCompanion(["status", "--json", "--all"], { env: decoyOnly, cwd });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.stateSource, "tmpdir-fallback");
  assert.ok(!report.stateDir.startsWith(fake.decoyDir), `state must not land in ${fake.decoyDir}`);
  assert.equal(fs.readdirSync(fake.decoyDir).length, 0);

  // And the fallback announces itself on stderr, never on stdout: the slash
  // commands require Claude to relay stdout verbatim.
  assert.match(result.stderr, /AGY_COMPANION_DATA_DIR is unset/);
  assert.match(result.stderr, /may not be visible to other Claude sessions/);
  assert.doesNotMatch(result.stdout, /is unset/);
});

test("the namespaced dir is reported as the source when it is set", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd: makeTempGitRepo() });
  const report = JSON.parse(result.stdout);
  assert.equal(report.stateSource, "plugin-data");
  assert.ok(report.stateDir.startsWith(fake.stateDir));
  assert.ok(report.workspaceRoot);
  assert.equal(result.stderr.trim(), "", "a resolved store must not warn");
});

// A store stamped by another plugin must never be read or written: reading it
// reports their jobs as ours, writing it corrupts their records.
test("a state file owned by another plugin is refused with a fixable message", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });

  const stateDir = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).stateDir;
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ version: 1, owner: "codex-plugin-cc", config: {}, jobs: [{ id: "not-ours" }] }, null, 2)
  );

  const result = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /belongs to codex-plugin-cc, not agy-plugin-cc/);
  assert.match(result.stderr, /AGY_COMPANION_DATA_DIR/);
  assert.doesNotMatch(result.stderr, /at Object\./, "a configuration problem must not print a stack trace");
  assert.equal(
    JSON.parse(fs.readFileSync(stateFile, "utf8")).owner,
    "codex-plugin-cc",
    "the other plugin's file must be left untouched"
  );
});

test("a state file written before the owner stamp is adopted, not refused", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "answer" } });
  const cwd = makeTempGitRepo();
  const stateDir = JSON.parse(runCompanion(["status", "--json", "--all"], { env: fake.env, cwd }).stdout).stateDir;
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [{ id: "legacy", kind: "task", status: "completed" }] }, null, 2)
  );

  const listed = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).jobs[0].id, "legacy");

  runCompanion(["task", "--write", "do the thing"], { env: fake.env, cwd });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).owner, "agy-plugin-cc");
});

// One bare "No job found with id X" cost about two hours in 2026-07 because it
// could not distinguish a typo from the wrong workspace or the wrong store.
test("a missing job id reports where it looked and what is there", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "answer" } });
  const cwd = makeTempGitRepo();
  runCompanion(["task", "--write", "do the thing"], { env: fake.env, cwd });

  for (const command of [["status", "task-nope"], ["result", "task-nope"], ["cancel", "task-nope"]]) {
    const result = runCompanion(command, { env: fake.env, cwd });
    assert.equal(result.status, 1, `${command[0]}: ${result.stderr}`);
    assert.match(result.stdout, /No job found with id task-nope\./, command[0]);
    assert.match(result.stdout, /Workspace root: /, command[0]);
    assert.match(result.stdout, new RegExp(`Job store: ${fake.stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), command[0]);
    assert.match(result.stdout, /\(plugin-data\)/, command[0]);
    assert.match(result.stdout, /Most recent jobs in this store:/, command[0]);
    assert.match(result.stdout, /\| task \| completed/, command[0]);
    assert.doesNotMatch(result.stdout, /do the thing/, "prompt previews must not leak into error paths");
  }
});

test("an empty store says so instead of listing nothing", () => {
  const fake = makeFakeEnv();
  const result = runCompanion(["status", "task-nope"], { env: fake.env, cwd: makeTempDir("agy-empty-ws") });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /This store holds no jobs at all/);
});

// X5/PC9: the caller must be able to answer "which copy of the plugin is this,
// and where is its job store" without `find`ing the filesystem.
test("setup and --help name the running copy and its job store", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  const report = JSON.parse(runCompanion(["setup", "--json"], { env: fake.env, cwd }).stdout);
  assert.match(report.pluginVersion, /^\d+\.\d+\.\d+$/);
  assert.match(report.companionPath, /scripts\/agy-companion\.mjs$/);
  assert.ok(report.stateDir.startsWith(fake.stateDir));

  const help = runCompanion(["--help"], { env: fake.env, cwd });
  assert.match(help.stdout, new RegExp(`agy-companion ${report.pluginVersion.replace(/\./g, "\\.")}`));
  assert.match(help.stdout, /Running from: .*agy-companion\.mjs/);
  assert.match(help.stdout, /Job store:/);
});

// The SessionStart hook must publish that path, so nobody has to guess it.
test("SessionStart exports the companion entry point", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  const envFile = path.join(makeTempDir("agy-env-file"), "env.sh");
  fs.writeFileSync(envFile, "");

  const hook = path.join(REPO_ROOT, "plugins", "agy", "scripts", "session-lifecycle-hook.mjs");
  const result = spawnSync(process.execPath, [hook, "SessionStart"], {
    cwd,
    env: { ...fake.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: fake.stateDir },
    input: JSON.stringify({ session_id: "s1", cwd }),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);

  const exported = fs.readFileSync(envFile, "utf8");
  assert.match(exported, /export AGY_COMPANION_BIN='.*scripts\/agy-companion\.mjs'/);
  assert.match(exported, /export AGY_COMPANION_DATA_DIR=/);
});

// X10: 0.1-era plugins wrote job state into the user's own repository. One such
// directory was still there a month after they asked for it to be ignored, and
// a sibling project's lint run failed on it.
test("setup reports a leftover 0.1-era state directory without deleting it", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();
  const leftover = path.join(cwd, ".agy-plugin-codex");
  fs.mkdirSync(path.join(leftover, "jobs"), { recursive: true });

  const report = JSON.parse(runCompanion(["setup", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(report.legacyStateDirs.length, 1);
  assert.match(report.legacyStateDirs[0], /\.agy-plugin-codex$/);

  const human = runCompanion(["setup"], { env: fake.env, cwd });
  assert.match(human.stdout, /Leftover 0\.1-era directory/);
  assert.match(human.stdout, /safe to delete/);
  assert.equal(fs.existsSync(leftover), true, "setup must never delete it");
});
