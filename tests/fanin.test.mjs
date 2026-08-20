import assert from "node:assert/strict";
import { test } from "node:test";

import { makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";

// PC8: the agy seat was empty in 16 of 19 recorded three-way aggregations
// because there was no way to fence on it in one call. `status --all --json`
// now answers "how long has each run been going" and "is its answer usable".
test("status --all --json carries elapsedMs and resultComplete per job", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_TEXT: "a real answer" } });
  const cwd = makeTempGitRepo();

  runCompanion(["task", "--", "first"], { env: fake.env, cwd });
  const emptyFake = { ...fake, env: { ...fake.env, AGY_FAKE_MODE: "empty-text" } };
  runCompanion(["task", "--", "second"], { env: emptyFake.env, cwd });

  const report = JSON.parse(runCompanion(["status", "--all", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(report.jobs.length, 2);
  for (const job of report.jobs) {
    assert.equal(typeof job.elapsedMs, "number", JSON.stringify(job));
    assert.ok(job.elapsedMs >= 0);
  }
  const byStatus = Object.fromEntries(report.jobs.map((job) => [job.status, job]));
  assert.equal(byStatus.completed.resultComplete, true);
  assert.equal(byStatus.incomplete.resultComplete, false);

  // The single-job form answers the same question without a second call.
  const single = JSON.parse(
    runCompanion(["status", byStatus.incomplete.id, "--json"], { env: fake.env, cwd }).stdout
  );
  assert.equal(single.resultComplete, false);
  assert.equal(typeof single.job.elapsedMs, "number");
});
