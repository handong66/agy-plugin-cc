import assert from "node:assert/strict";
import { test } from "node:test";

import { makeTempDir } from "./helpers.mjs";

// The suite owns both env vars so it never touches a real data directory, and
// so an installed plugin's SessionStart export cannot leak in.
process.env.AGY_COMPANION_DATA_DIR = makeTempDir("agy-state-test");
process.env.CLAUDE_PLUGIN_DATA = makeTempDir("agy-state-decoy");
const { upsertJob, findJob, listJobs, setConfig, getConfig, resolveStateDir, resolveStateLocation } =
  await import("../plugins/agy/scripts/lib/state.mjs");

const cwd = makeTempDir("agy-state-workspace");

test("state dir lands under the namespaced data dir", () => {
  const location = resolveStateLocation(cwd);
  assert.ok(location.dir.startsWith(process.env.AGY_COMPANION_DATA_DIR));
  assert.equal(location.source, "plugin-data");
});

test("upsertJob inserts then patches without losing fields", () => {
  upsertJob(cwd, { id: "task-1", kind: "task", status: "running", promptPreview: "hello" });
  upsertJob(cwd, { id: "task-1", status: "completed", agyConversationId: "ses_1" });
  const job = findJob(cwd, "task-1");
  assert.equal(job.status, "completed");
  assert.equal(job.promptPreview, "hello");
  assert.equal(job.agyConversationId, "ses_1");
  assert.ok(job.createdAt);
  assert.ok(job.updatedAt);
});

test("listJobs returns newest-first and prunes past the cap", () => {
  for (let index = 0; index < 60; index += 1) {
    upsertJob(cwd, { id: `bulk-${index}`, kind: "task", status: "completed" });
  }
  const jobs = listJobs(cwd);
  assert.ok(jobs.length <= 50);
  assert.equal(jobs[0].id, "bulk-59");
});

test("config round-trips", () => {
  assert.equal(Boolean(getConfig(cwd).stopReviewGate), false);
  setConfig(cwd, "stopReviewGate", true);
  assert.equal(getConfig(cwd).stopReviewGate, true);
  setConfig(cwd, "stopReviewGate", false);
});

// CLAUDE_PLUGIN_DATA is shared: it holds whichever plugin's SessionStart hook
// ran last in this shell, so it is not consulted at all any more.
test("a clobbered CLAUDE_PLUGIN_DATA is ignored, not used as a fallback", () => {
  const namespaced = process.env.AGY_COMPANION_DATA_DIR;
  delete process.env.AGY_COMPANION_DATA_DIR;
  try {
    const location = resolveStateLocation(cwd);
    assert.equal(location.source, "tmpdir-fallback");
    assert.ok(!location.dir.startsWith(process.env.CLAUDE_PLUGIN_DATA));
  } finally {
    process.env.AGY_COMPANION_DATA_DIR = namespaced;
  }
  assert.ok(resolveStateDir(cwd).startsWith(namespaced));
});
