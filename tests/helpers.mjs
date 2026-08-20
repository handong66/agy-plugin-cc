import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TESTS_DIR, "..");
export const COMPANION = path.join(REPO_ROOT, "plugins", "agy", "scripts", "agy-companion.mjs");
const FIXTURE = path.join(TESTS_DIR, "fake-agy-fixture.mjs");

export function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

// Builds an isolated environment whose PATH resolves `agy` to the fake
// fixture and whose plugin state lands in a throwaway directory. Mirrors a
// real session env where CLAUDE_PLUGIN_DATA was clobbered by another plugin's
// hook: state must land in the namespaced dir, never the decoy.
export function makeFakeEnv({ mode = "success", extra = {} } = {}) {
  const binDir = makeTempDir("agy-fake-bin");
  const stateDir = makeTempDir("agy-fake-state");
  const decoyDir = makeTempDir("agy-foreign-plugin-data");
  const shim = path.join(binDir, "agy");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return {
    binDir,
    stateDir,
    decoyDir,
    argsFile: path.join(binDir, "last-run-args.json"),
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      AGY_COMPANION_DATA_DIR: stateDir,
      CLAUDE_PLUGIN_DATA: decoyDir,
      AGY_FAKE_MODE: mode,
      AGY_FAKE_ARGS_FILE: path.join(binDir, "last-run-args.json"),
      ...extra
    }
  };
}

export function runCompanion(args, { env, cwd }) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000
  });
}

export function readRunArgs(fake) {
  return JSON.parse(fs.readFileSync(fake.argsFile, "utf8"));
}

// A throwaway git repo with one untracked file, enough for a working-tree review.
export function makeTempGitRepo() {
  const dir = makeTempDir("agy-fake-repo");
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "--quiet"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "app.mjs"), "export const value = 42;\n");
  return dir;
}
