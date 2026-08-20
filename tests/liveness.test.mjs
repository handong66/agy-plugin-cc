import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

import { REPO_ROOT, makeTempDir } from "./helpers.mjs";

const STATE_MODULE = path.join(REPO_ROOT, "plugins", "agy", "scripts", "lib", "state.mjs");

process.env.AGY_COMPANION_DATA_DIR = makeTempDir("agy-liveness-data");
delete process.env.CLAUDE_PLUGIN_DATA;
const {
  ORPHAN_GRACE_MS,
  findJob,
  listJobs,
  loadState,
  reconcileJobs,
  resolveJobFile,
  saveState,
  upsertJob,
  writeJobFile
} = await import("../plugins/agy/scripts/lib/state.mjs");

// A pid that has certainly exited: run a node process to completion and reuse
// its pid. Nothing else in this test's lifetime can claim it that fast.
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  return child.pid;
}

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

test("reconcileJobs marks running jobs whose process is gone as failed (orphaned)", () => {
  const jobs = [
    { id: "live", status: "running", childPid: process.pid, createdAt: iso(-3_600_000), updatedAt: iso(-3_600_000) },
    { id: "dead", status: "running", childPid: deadPid(), createdAt: iso(-60_000), updatedAt: iso(-30_000) },
    { id: "done", status: "completed", childPid: deadPid(), durationMs: 1000, updatedAt: iso(-30_000) }
  ];
  const { jobs: reconciled, changed } = reconcileJobs(jobs);
  assert.equal(changed, true);

  const byId = Object.fromEntries(reconciled.map((job) => [job.id, job]));
  assert.equal(byId.live.status, "running", "a live child must keep running, however long it has been going");
  assert.equal(byId.done.status, "completed", "terminal records are never rewritten");

  assert.equal(byId.dead.status, "failed");
  assert.equal(byId.dead.failureClass, "orphaned");
  assert.ok(byId.dead.endedAt, "orphaned jobs get an end timestamp");
  assert.match(byId.dead.summary, /process exited without writing a result/);
  // Elapsed must freeze at the last sign of life, not keep growing (the 201m
  // row from 2026-07-17T18:09:29 is what this prevents).
  assert.ok(byId.dead.durationMs > 0 && byId.dead.durationMs <= 60_000, `froze at ${byId.dead.durationMs}ms`);
});

test("reconcileJobs uses the grace window for records that never recorded a pid", () => {
  const fresh = [{ id: "spawning", status: "running", createdAt: iso(-1000), updatedAt: iso(-1000) }];
  assert.equal(reconcileJobs(fresh).changed, false, "the spawn gap must not be mistaken for death");

  const stale = [
    {
      id: "stalled",
      status: "queued",
      createdAt: iso(-(ORPHAN_GRACE_MS + 60_000)),
      updatedAt: iso(-(ORPHAN_GRACE_MS + 60_000))
    }
  ];
  const { jobs, changed } = reconcileJobs(stale);
  assert.equal(changed, true);
  assert.equal(jobs[0].status, "failed");
  assert.equal(jobs[0].failureClass, "orphaned");
});

test("reconcileJobs reports no change when every record is consistent", () => {
  const jobs = [{ id: "a", status: "completed" }, { id: "b", status: "running", childPid: process.pid }];
  const result = reconcileJobs(jobs);
  assert.equal(result.changed, false);
  assert.deepEqual(result.jobs, jobs);
});

test("listJobs and findJob reconcile and persist the correction once", () => {
  const cwd = makeTempDir("agy-liveness-workspace");
  upsertJob(cwd, { id: "task-orphan", kind: "task", status: "running", childPid: deadPid(), logFile: "/tmp/nope.log" });
  upsertJob(cwd, { id: "task-done", kind: "task", status: "completed", durationMs: 5 });

  const listed = listJobs(cwd).find((job) => job.id === "task-orphan");
  assert.equal(listed.status, "failed");
  assert.equal(listed.failureClass, "orphaned");

  // Persisted, so status/result/cancel and the hooks all agree without redoing
  // the liveness probe.
  const raw = loadState(cwd).jobs.find((job) => job.id === "task-orphan");
  assert.equal(raw.status, "failed");
  assert.equal(raw.failureClass, "orphaned");

  assert.equal(findJob(cwd, "task-orphan").status, "failed");
  assert.equal(findJob(cwd, "task-done").status, "completed");

  // Opting out is what the in-flight job's own writer uses so it never
  // relabels itself between the child exiting and the terminal write.
  upsertJob(cwd, { id: "task-inflight", kind: "task", status: "running", childPid: deadPid() });
  assert.equal(findJob(cwd, "task-inflight", { reconcile: false }).status, "running");
  assert.equal(listJobs(cwd, { reconcile: false }).find((job) => job.id === "task-inflight").status, "running");
});

// P-STATERACE precondition for the reconcile writes: `saveState` used to derive
// its "these jobs are gone, unlink their payload and log" set from the caller's
// stale snapshot, so any concurrent writer could delete a live job's files.
test("concurrent writers never unlink each other's payloads", async () => {
  const cwd = makeTempDir("agy-liveness-concurrent");
  const script = `
    const { upsertJob, writeJobFile } = await import(${JSON.stringify(STATE_MODULE)});
    const id = process.argv[1];
    upsertJob(${JSON.stringify(cwd)}, { id, kind: "task", status: "completed", durationMs: 1 });
    writeJobFile(${JSON.stringify(cwd)}, id, { kind: "task", rawOutput: id });
  `;
  const ids = Array.from({ length: 8 }, (_, index) => `race-${index}`);
  const exits = await Promise.all(
    ids.map(
      (id) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script, id], {
            env: process.env,
            stdio: ["ignore", "ignore", "pipe"]
          });
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.on("close", (code) => resolve({ id, code, stderr }));
        })
    )
  );
  for (const exit of exits) {
    assert.equal(exit.code, 0, `${exit.id}: ${exit.stderr}`);
  }

  for (const id of ids) {
    assert.ok(fs.existsSync(resolveJobFile(cwd, id)), `payload for ${id} was unlinked by a concurrent write`);
  }
  // NOTE: records can still be lost here — the read-modify-write remains
  // lock-free, and the exclusive lock is a later item. What must never happen
  // is a writer deleting another live job's stored output.
});

test("saveState never unlinks jobs it did not know about", () => {
  const cwd = makeTempDir("agy-liveness-stale");
  upsertJob(cwd, { id: "older", kind: "task", status: "completed", durationMs: 1 });
  writeJobFile(cwd, "older", { kind: "task", rawOutput: "older" });

  // What a companion holds while its own run is in flight.
  const stale = loadState(cwd);

  // Meanwhile another companion in the same workspace records a job.
  upsertJob(cwd, { id: "sibling", kind: "task", status: "running", childPid: process.pid });
  const siblingLog = path.join(makeTempDir("agy-liveness-log"), "sibling.log");
  fs.writeFileSync(siblingLog, "streaming\n");
  upsertJob(cwd, { id: "sibling", logFile: siblingLog });
  writeJobFile(cwd, "sibling", { kind: "task", rawOutput: "sibling" });

  // The stale writer commits its own update.
  stale.jobs.unshift({ id: "mine", kind: "task", status: "completed", durationMs: 2, updatedAt: new Date().toISOString() });
  saveState(cwd, stale);

  const ids = new Set(listJobs(cwd, { reconcile: false }).map((job) => job.id));
  assert.ok(ids.has("sibling"), "the concurrent job's record must survive a stale write");
  assert.ok(ids.has("mine"));
  assert.ok(ids.has("older"));
  assert.ok(fs.existsSync(resolveJobFile(cwd, "sibling")), "the concurrent job's payload must survive");
  assert.ok(fs.existsSync(siblingLog), "the concurrent job's log must survive (its run is still writing to it)");
});

test("writeJobFile and the job store stay inside the namespaced data dir", () => {
  const cwd = makeTempDir("agy-liveness-owner");
  const file = writeJobFile(cwd, "owner-check", { kind: "task", rawOutput: "x" });
  assert.ok(
    file.startsWith(process.env.AGY_COMPANION_DATA_DIR),
    `tests must never write into a real plugin data dir (${file})`
  );
});
