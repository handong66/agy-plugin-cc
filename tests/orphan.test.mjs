import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { COMPANION, makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJobs(fake, cwd) {
  const status = runCompanion(["status", "--json", "--all"], { env: fake.env, cwd });
  return JSON.parse(status.stdout || "{}").jobs ?? [];
}

async function waitForRunningJob(fake, cwd, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = readJobs(fake, cwd).find((candidate) => candidate.status === "running" && candidate.childPid);
    if (job) {
      return job;
    }
    await sleep(250);
  }
  throw new Error("no running job with a child pid appeared");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// P-ORPHAN: the companion had no SIGTERM/SIGINT/SIGHUP handler at all, so a
// Bash timeout (3 recorded `Exit code 143`) left the detached agy child
// running — 2026-07-17T14:51:30 needed `kill -9` on two pids by hand — and the
// job record frozen at `running` with nothing stored.
test("a terminated companion kills its child, labels the job, and keeps partial output", async () => {
  const fake = makeFakeEnv({
    mode: "hang",
    extra: { AGY_FAKE_TEXT: "halfway through the investigation" }
  });
  const cwd = makeTempGitRepo();

  const companion = spawn(process.execPath, [COMPANION, "task", "--write", "investigate the thing"], {
    cwd,
    env: fake.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = new Promise((resolve) => companion.on("exit", (code, signal) => resolve({ code, signal })));

  const running = await waitForRunningJob(fake, cwd);
  const childPid = running.childPid;
  assert.ok(isAlive(childPid), "the fake agy child should be running");

  // Give the child a moment to emit its partial text before the kill.
  await sleep(500);
  companion.kill("SIGTERM");
  const outcome = await exited;

  // The signal is re-raised with its default disposition, so the exit status
  // stays honest (143 = SIGTERM) instead of being masked by the handler.
  assert.equal(outcome.signal, "SIGTERM", `expected death by SIGTERM, got ${JSON.stringify(outcome)}`);

  await sleep(500);
  assert.equal(isAlive(childPid), false, "the detached agy child must not outlive the companion");

  const job = readJobs(fake, cwd).find((candidate) => candidate.id === running.id);
  assert.equal(job.status, "failed");
  assert.equal(job.failureClass, "interrupted");
  assert.match(job.summary, /terminated/);

  const stored = runCompanion(["result", running.id], { env: fake.env, cwd });
  assert.match(stored.stdout, /halfway through the investigation/, "buffered output must survive the kill");
  assert.match(stored.stdout, /failed \(interrupted\)/);

  const detail = runCompanion(["status", running.id], { env: fake.env, cwd }).stdout;
  assert.match(detail, /Status: failed \(interrupted\)/);
});

// The handler shares its job store with `cancel` and the SessionEnd hook, so it
// must never rewrite a record that already reached a terminal state.
test("the signal handler leaves an already-cancelled job alone", async () => {
  const fake = makeFakeEnv({ mode: "hang" });
  const cwd = makeTempGitRepo();

  const companion = spawn(process.execPath, [COMPANION, "task", "--write", "investigate the thing"], {
    cwd,
    env: fake.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = new Promise((resolve) => companion.on("exit", (code, signal) => resolve({ code, signal })));

  const running = await waitForRunningJob(fake, cwd);
  const cancelled = runCompanion(["cancel", running.id], { env: fake.env, cwd });
  assert.equal(cancelled.status, 0, cancelled.stderr);

  companion.kill("SIGTERM");
  await exited;
  await sleep(300);

  // Either the cancel wins the race for the terminal write or the companion's
  // own "the child died" verdict does; both are terminal, and the signal
  // handler must leave whichever landed exactly as it is.
  const job = readJobs(fake, cwd).find((candidate) => candidate.id === running.id);
  assert.ok(["cancelled", "failed"].includes(job.status), `unexpected status ${job.status}`);
  assert.notEqual(job.failureClass, "interrupted", "a terminal record must not be relabelled");
});
