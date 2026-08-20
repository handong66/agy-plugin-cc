import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

import { REPO_ROOT, makeTempDir } from "./helpers.mjs";

const STATE_MODULE = path.join(REPO_ROOT, "plugins", "agy", "scripts", "lib", "state.mjs");

process.env.AGY_COMPANION_DATA_DIR = makeTempDir("agy-staterace-data");
const { resolveJobsDir, resolveStateDir, resolveStateFile, listJobs, upsertJob, writeJobFile } =
  await import("../plugins/agy/scripts/lib/state.mjs");

// P-STATERACE 2: `saveState` overwrote state.json in place, so a reader could
// see a torn file — and `loadState`'s silent `catch { return defaultState() }`
// turns a torn read into "the job list is empty". A rename swaps a complete
// file in atomically, which an already-open descriptor proves: it still sees
// the old inode instead of a truncated one.
test("state.json is replaced by rename, never truncated in place", () => {
  const cwd = makeTempDir("agy-staterace-atomic");
  upsertJob(cwd, { id: "first", kind: "task", status: "completed" });

  const stateFile = resolveStateFile(cwd);
  const before = fs.readFileSync(stateFile, "utf8");
  const fd = fs.openSync(stateFile, "r");
  try {
    upsertJob(cwd, { id: "second", kind: "task", status: "completed" });
    const throughOldHandle = fs.readFileSync(fd, "utf8");
    assert.equal(
      throughOldHandle,
      before,
      "an in-place overwrite would have changed what the open handle sees"
    );
  } finally {
    fs.closeSync(fd);
  }

  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.length, 2);
  const leftovers = fs.readdirSync(resolveStateDir(cwd)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "the temp file must not survive the write");
});

// P-STATERACE 1: concurrency is the normal case here — one `status --all` table
// routinely lists several in-flight jobs — and a writer holding a stale snapshot
// used to unlink its neighbours' payload and log files while the write stream
// kept writing into the unlinked inode.
//
// The record half is the same race one level up: with the write atomic but the
// surrounding read-modify-write unguarded, 3 of these 8 records kept their final
// status (7 of 8 with the re-merge, still not all). A record that loses is
// invisible to `findJob`, so `result <id>` denies a run whose payload is on
// disk — hence the lock, and hence this asserting all N.
test("concurrent writers never destroy each other's records, payloads or logs", async () => {
  const cwd = makeTempDir("agy-staterace-concurrent");
  const writerCount = 8;

  const writer = (index) => `
    const fs = (await import("node:fs")).default;
    const { upsertJob, writeJobFile, resolveJobLogFile } = await import(${JSON.stringify(STATE_MODULE)});
    const cwd = ${JSON.stringify(cwd)};
    const id = "job-" + ${index};
    const logFile = resolveJobLogFile(cwd, id);
    fs.writeFileSync(logFile, "log for " + id + "\\n");
    upsertJob(cwd, { id, kind: "task", status: "running", cwd, logFile, promptPreview: id });
    await new Promise((resolve) => setTimeout(resolve, 50 * (${index} % 4)));
    writeJobFile(cwd, id, { kind: "task", rawOutput: "answer " + id, rendered: "answer " + id });
    upsertJob(cwd, { id, status: "completed", summary: "answer " + id });
  `;

  await Promise.all(
    Array.from({ length: writerCount }, (unused, index) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", writer(index)], {
          env: process.env,
          stdio: ["ignore", "ignore", "pipe"]
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      })
    )
  );

  const jobsDir = resolveJobsDir(cwd);
  for (let index = 0; index < writerCount; index += 1) {
    assert.ok(fs.existsSync(path.join(jobsDir, `job-${index}.json`)), `payload for job-${index} survived`);
    assert.ok(fs.existsSync(path.join(jobsDir, `job-${index}.log`)), `log for job-${index} survived`);
    assert.match(
      JSON.parse(fs.readFileSync(path.join(jobsDir, `job-${index}.json`), "utf8")).rawOutput,
      new RegExp(`answer job-${index}`),
      `payload for job-${index} is intact`
    );
  }

  // Every record survives the concurrency with the status its own writer wrote
  // last — no dropped id (the store would deny a job whose payload is right
  // there) and no lost update back to the `running` snapshot a racing writer
  // had merged from.
  const jobs = listJobs(cwd, { reconcile: false });
  assert.equal(jobs.length, writerCount, "every writer's record must survive");
  for (let index = 0; index < writerCount; index += 1) {
    const job = jobs.find((candidate) => candidate.id === `job-${index}`);
    assert.ok(job, `job-${index} is still in the store`);
    assert.equal(job.status, "completed", `job-${index} kept its final status`);
    assert.equal(job.summary, `answer job-${index}`, "no record may carry another job's fields");
  }
});

// The lock is advisory and must never become the reason a job cannot be
// recorded: a lock file left behind by a killed writer is broken, not waited on
// forever.
test("a stale lock file left by a dead writer is broken instead of blocking", () => {
  const cwd = makeTempDir("agy-staterace-stalelock");
  upsertJob(cwd, { id: "before", kind: "task", status: "completed" });

  const lockFile = path.join(resolveStateDir(cwd), "state.lock");
  fs.writeFileSync(lockFile, "999999\n");
  // Older than the 5s staleness window, i.e. the holder is gone.
  const ancient = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, ancient, ancient);

  const startedAt = Date.now();
  upsertJob(cwd, { id: "after", kind: "task", status: "completed" });
  assert.ok(Date.now() - startedAt < 5_000, "a stale lock must not be waited out");

  const ids = listJobs(cwd, { reconcile: false }).map((job) => job.id).sort();
  assert.deepEqual(ids, ["after", "before"]);
  assert.equal(fs.existsSync(lockFile), false, "the lock is released after the write");
});

// The staleness window is a fallback, not the primary test: a lock whose writer
// is *gone* is abandoned the moment we can see that, whatever its mtime says.
// Waiting the window out was a real cost — `task`/`review` upsert a job record
// before spawning, so a writer killed mid-write made the next run pay 5s before
// it could even start.
test("a lock whose writer is gone is broken at once, not waited out", () => {
  const cwd = makeTempDir("agy-staterace-deadpid");
  upsertJob(cwd, { id: "before", kind: "task", status: "completed" });

  // A pid that is definitively gone: a process that has already exited.
  const corpse = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(corpse.status, 0, "the probe process must have run and exited");
  const lockFile = path.join(resolveStateDir(cwd), "state.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: corpse.pid, token: "abandoned" }));

  // Fresh mtime: only the pid says this lock is dead.
  const startedAt = Date.now();
  upsertJob(cwd, { id: "after", kind: "task", status: "completed" });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 2_000, `a dead writer's lock must not be waited out (took ${elapsed}ms)`);

  const ids = listJobs(cwd, { reconcile: false }).map((job) => job.id).sort();
  assert.deepEqual(ids, ["after", "before"]);
  assert.equal(fs.existsSync(lockFile), false, "the lock is released after the write");
});

// The other direction, and the one that mattered: the holder was never checked
// at all, so a critical section starved for longer than the window had its lock
// broken under it — and its own `finally` then deleted the *successor's* lock,
// putting two writers back into the unguarded read-modify-write with nothing to
// show for it.
test("a live writer's lock is never stolen, however old it looks", () => {
  const cwd = makeTempDir("agy-staterace-livelock");
  upsertJob(cwd, { id: "before", kind: "task", status: "completed" });

  const lockFile = path.join(resolveStateDir(cwd), "state.lock");
  // This test process is alive by definition, and the lock looks ancient.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "held-by-a-live-writer" }));
  const ancient = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, ancient, ancient);

  const writer = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { upsertJob } = await import(${JSON.stringify(STATE_MODULE)});
       upsertJob(${JSON.stringify(cwd)}, { id: "after", kind: "task", status: "completed" });`
    ],
    {
      encoding: "utf8",
      // The waiter gives up quickly here; the point is what it does *not* do
      // while waiting, not how long it is prepared to wait.
      env: { ...process.env, AGY_COMPANION_LOCK_TIMEOUT_MS: "250" }
    }
  );
  assert.equal(writer.status, 0, writer.stderr);

  // Degraded, not failed: the record is written even though the lock was never
  // acquired. That has always been the contract.
  const ids = listJobs(cwd, { reconcile: false }).map((job) => job.id).sort();
  assert.deepEqual(ids, ["after", "before"]);

  // And the live holder still owns its lock.
  assert.equal(fs.existsSync(lockFile), true, "a live holder's lock must survive");
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "held-by-a-live-writer");
});

// A payload is read back by `result`, whose parse failure is equally silent.
test("job payloads are written atomically too", () => {
  const cwd = makeTempDir("agy-staterace-payload");
  writeJobFile(cwd, "payload-job", { kind: "task", rawOutput: "first" });
  const jobFile = path.join(resolveJobsDir(cwd), "payload-job.json");
  const before = fs.readFileSync(jobFile, "utf8");
  const fd = fs.openSync(jobFile, "r");
  try {
    writeJobFile(cwd, "payload-job", { kind: "task", rawOutput: "second" });
    assert.equal(fs.readFileSync(fd, "utf8"), before);
  } finally {
    fs.closeSync(fd);
  }
  assert.match(fs.readFileSync(jobFile, "utf8"), /second/);
});
