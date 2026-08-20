import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { resolveRunSelection } from "../plugins/agy/scripts/lib/agycli.mjs";
import { makeFakeEnv, makeTempGitRepo, runCompanion } from "./helpers.mjs";

// The model is OBSERVED or it is UNKNOWN — never predicted. agy has no
// user-facing model configuration: it resolves its own model server-side and
// names it in each run's init event. The opencode runtime's config scraping,
// its per-agent model resolution and its `Model (expected)` /
// `modelCertainty: "expected"` machinery are gone, and so are the tests that
// pinned them. This file tests the successor guarantee: a run reports the
// model that answered, or reports none.

test("resolveRunSelection only validates and passes through; it never guesses", () => {
  const flagged = resolveRunSelection({ model: "gemini-3.7-flash-low" });
  assert.equal(flagged.model, "gemini-3.7-flash-low");
  assert.equal(flagged.source, "flag");
  assert.equal(flagged.certainty, "actual");

  const bare = resolveRunSelection({});
  assert.equal(bare.model, null);
  assert.equal(bare.source, "agy-default");
  assert.equal(bare.certainty, "unknown");
  assert.deepEqual(bare.warnings, []);
  assert.equal("agent" in bare, false, "agy has no named agents, so there is no agent field");
  assert.equal("variant" in bare, false, "the dial is effort, not variant");
});

test("resolveRunSelection validates effort and passes readOnly through", () => {
  assert.equal(resolveRunSelection({ effort: "high" }).effort, "high");
  assert.equal(resolveRunSelection({ effort: "MEDIUM" }).effort, "medium");
  const bad = resolveRunSelection({ effort: "max" });
  assert.equal(bad.effort, null);
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /low, medium, high/);
  assert.equal(resolveRunSelection({ readOnly: true }).readOnly, true);
  assert.equal(resolveRunSelection({ readOnly: false }).readOnly, false);
});

test("a run reports the model its init event named, and never a guess", () => {
  const fake = makeFakeEnv({ extra: { AGY_FAKE_OBSERVED_MODEL: "gemini-3.7-flash-low" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--", "look at the diff"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Model: gemini-3.7-flash-low/);
  assert.doesNotMatch(result.stdout, /Model \(expected\)/);

  const jobId = result.stdout.match(/Job: (task-[\w-]+)/)[1];
  const stored = JSON.parse(runCompanion(["status", jobId, "--json"], { env: fake.env, cwd }).stdout).job;
  assert.equal(stored.model, "gemini-3.7-flash-low");
  assert.equal(stored.modelSource, "init-event");
  assert.equal(stored.modelCertainty, "actual");
});

test("task --json and review --json carry the model fields, observed not guessed", () => {
  const REVIEW = {
    verdict: "needs-attention",
    summary: "One blocking issue in the retry path.",
    findings: [],
    next_steps: ["Await the backoff delay."]
  };
  const fake = makeFakeEnv({
    mode: "review-json",
    extra: {
      AGY_FAKE_OBSERVED_MODEL: "gemini-3.6-flash-high",
      AGY_FAKE_STRUCTURED: JSON.stringify(REVIEW)
    }
  });
  const cwd = makeTempGitRepo();

  const task = JSON.parse(runCompanion(["task", "--json", "--", "look at the diff"], { env: fake.env, cwd }).stdout);
  assert.equal(task.model, "gemini-3.6-flash-high");
  assert.equal(task.modelSource, "init-event");
  assert.equal(task.modelCertainty, "actual");
  assert.equal("agent" in task, false, "the document must not carry the deleted agent field");
  assert.equal("variant" in task, false, "the document must not carry the deleted variant field");

  const review = JSON.parse(runCompanion(["review", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(review.model, "gemini-3.6-flash-high");
  assert.equal(review.modelCertainty, "actual");
  assert.match(review.jobId, /^review-/);
  const stored = JSON.parse(
    runCompanion(["status", review.jobId, "--json"], { env: fake.env, cwd }).stdout
  ).job;
  assert.equal(stored.id, review.jobId, "the id in the document must address the stored job");
});

test("the empty review document carries the model keys as null, not missing", () => {
  const fake = makeFakeEnv({ mode: "review-json" });
  const cwd = makeTempGitRepo();
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "--quiet", "-m", "clean"], { cwd });

  const empty = JSON.parse(runCompanion(["review", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(empty.outputState, "empty");
  // No run happened, so every model field a run would fill is null — the keys
  // are still present so a consumer never has to shape-check the document.
  for (const key of ["jobId", "model", "modelSource", "modelCertainty"]) {
    assert.ok(key in empty, `${key} must be present on the empty document too`);
    assert.equal(empty[key], null, `${key} must be null when no run happened`);
  }
});

// The same contract on the job store: "which model actually reviewed this" is
// answerable from the record, never from the caller's memory or a config file.
test("--effort reaches agy's command line and the job record, and --variant aliases it", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--json", "--effort", "high", "--", "dial it up"], {
    env: fake.env,
    cwd
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.effort, "high");
  const runArgs = JSON.parse(fs.readFileSync(fake.argsFile, "utf8"));
  assert.equal(runArgs[runArgs.indexOf("--effort") + 1], "high");

  const aliased = runCompanion(["task", "--json", "--variant", "low", "--", "old spelling"], {
    env: fake.env,
    cwd
  });
  assert.equal(JSON.parse(aliased.stdout).effort, "low");
  const aliasedArgs = JSON.parse(fs.readFileSync(fake.argsFile, "utf8"));
  assert.equal(aliasedArgs[aliasedArgs.indexOf("--effort") + 1], "low");
});

test("setup reports the models the account can reach, never a default it cannot know", () => {
  const fake = makeFakeEnv();
  const setup = JSON.parse(runCompanion(["setup", "--json"], { env: fake.env, cwd: makeTempGitRepo() }).stdout);
  assert.equal(setup.defaultModel, null, "agy resolves its own default server-side; nothing is knowable pre-run");
  assert.equal(setup.readOnlyModel, null, "read-only runs have no separate agent, so no separate model");
  assert.deepEqual(setup.modelConfigFiles, [], "there is no config file to scrape");
  assert.ok(setup.availableModels.includes("fake-model-one"));
});

test("the single-job status and result documents carry a top-level jobId", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  const task = JSON.parse(runCompanion(["task", "--json", "--", "do the work"], { env: fake.env, cwd }).stdout);
  assert.match(task.jobId, /^task-/);

  const status = JSON.parse(runCompanion(["status", task.jobId, "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(status.jobId, task.jobId, "status --json must name the job it describes at the top level");
  assert.equal(status.jobId, status.job.id, "and it must agree with the record it wraps");

  const result = JSON.parse(runCompanion(["result", task.jobId, "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(result.jobId, task.jobId, "result --json must name the job it returns");
  assert.equal(result.jobId, result.job.id);

  // The bare `result --json` (no id) resolves the newest finished job, and the
  // id it settled on is exactly what the caller cannot otherwise know.
  const newest = JSON.parse(runCompanion(["result", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(newest.jobId, task.jobId);
});
