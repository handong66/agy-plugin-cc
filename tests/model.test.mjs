import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  parseJsonc,
  readAgyModelConfig,
  resolveRunSelection
} from "../plugins/agy/scripts/lib/agycli.mjs";
import { makeFakeEnv, makeTempDir, makeTempGitRepo, runCompanion } from "./helpers.mjs";

// PC5: the config that matters here is JSONC with per-agent models, and the old
// reader took the *first* `"model": "..."` in the file — which in such a config
// is whichever one happens to be written first.
function makeAgyHome(configText, { extension = "jsonc" } = {}) {
  const home = makeTempDir("agy-fake-home");
  const dir = path.join(home, ".config", "agy");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agy.${extension}`), configText);
  return home;
}

const CONFIG = `{
  // The plan agent is what this plugin's read-only runs use.
  "agent": {
    "plan": { "model": "deepseek/deepseek-v4-flash", "variant": "max" },
    "build": { "model": "anthropic/claude-sonnet-4-5" }
  },
  /* the account default, written after the agents */
  "model": "anthropic/claude-opus-4-1",
}`;

test("the agy config is read as JSONC, per key rather than by first match", () => {
  assert.deepEqual(parseJsonc('{ "a": 1, /* c */ "b": "//not a comment", }'), {
    a: 1,
    b: "//not a comment"
  });

  const home = makeAgyHome(CONFIG);
  const config = readAgyModelConfig({ homeDir: home, cwd: makeTempDir("agy-no-project-config") });
  assert.equal(config.model, "anthropic/claude-opus-4-1");
  assert.equal(config.agentModels.plan, "deepseek/deepseek-v4-flash");
  assert.equal(config.agentModels.build, "anthropic/claude-sonnet-4-5");
  assert.equal(config.agentVariants.plan, "max");
});

test("a read-only run reports the agent's model, and warns that it is not the default", () => {
  const config = readAgyModelConfig({
    homeDir: makeAgyHome(CONFIG),
    cwd: makeTempDir("agy-no-project-config")
  });

  const readOnly = resolveRunSelection({ readOnly: true, config });
  assert.equal(readOnly.model, "deepseek/deepseek-v4-flash");
  assert.equal(readOnly.agent, "plan");
  assert.equal(readOnly.variant, "max");
  assert.equal(readOnly.warnings[0].class, "read_only_model_override");
  assert.match(readOnly.warnings[0].message, /deepseek\/deepseek-v4-flash/);
  assert.match(readOnly.warnings[0].message, /anthropic\/claude-opus-4-1/);

  // An explicit --model is the caller's decision, so there is nothing to warn about.
  const explicit = resolveRunSelection({ model: "anthropic/claude-opus-4-1", readOnly: true, config });
  assert.equal(explicit.model, "anthropic/claude-opus-4-1");
  assert.equal(explicit.source, "flag");
  assert.deepEqual(explicit.warnings, []);

  // A write run uses the build agent.
  assert.equal(resolveRunSelection({ readOnly: false, config }).model, "anthropic/claude-sonnet-4-5");
});

test("the job record and the rendered footer name the model, labelled as inferred", () => {
  const home = makeAgyHome(CONFIG);
  const fake = makeFakeEnv({ extra: { HOME: home } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--", "look at the diff"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Nothing observed this model: it was read out of a config file, so the line
  // says so rather than asserting which model reviewed the user's work.
  assert.match(result.stdout, /Model \(expected\): deepseek\/deepseek-v4-flash \(agent plan, variant max\)/);
  assert.match(result.stderr, /read_only_model_override/);

  const jobId = result.stdout.match(/Job: (task-[\w-]+)/)[1];
  const detail = runCompanion(["status", jobId], { env: fake.env, cwd });
  assert.match(detail.stdout, /Model \(expected\): deepseek\/deepseek-v4-flash \(agent plan, variant max\)/);

  const stored = JSON.parse(runCompanion(["status", jobId, "--json"], { env: fake.env, cwd }).stdout).job;
  assert.equal(stored.model, "deepseek/deepseek-v4-flash");
  assert.equal(stored.agent, "plan");
  assert.equal(stored.requestedModel, null);
  assert.equal(stored.modelSource, "config:agent.plan.model");
  assert.equal(stored.modelCertainty, "expected");

  // An explicit --model is on agy's command line, so it is not a guess.
  const explicit = runCompanion(["task", "--model", "anthropic/claude-opus-4-1", "--", "again"], {
    env: fake.env,
    cwd
  });
  assert.match(explicit.stdout, /Model: anthropic\/claude-opus-4-1 \(agent plan, variant max\)/);
  assert.doesNotMatch(explicit.stdout, /Model \(expected\)/);

  const setup = JSON.parse(runCompanion(["setup", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(setup.defaultModel, "anthropic/claude-opus-4-1");
  assert.equal(setup.readOnlyModel, "deepseek/deepseek-v4-flash");
});

// X4: the README promises "`--json` carries `model`, `modelSource` and
// `modelCertainty` for callers that need to branch on it". `status --json` did;
// the documents `task --json` and `review --json` print did not, so a caller
// following the release note read undefined and took the other branch.
test("task --json and review --json carry the model fields the README promises", () => {
  const home = makeAgyHome(CONFIG);
  const fake = makeFakeEnv({ extra: { HOME: home } });
  const cwd = makeTempGitRepo();

  const task = JSON.parse(
    runCompanion(["task", "--json", "--", "look at the diff"], { env: fake.env, cwd }).stdout
  );
  assert.equal(task.model, "deepseek/deepseek-v4-flash");
  assert.equal(task.modelSource, "config:agent.plan.model");
  assert.equal(task.modelCertainty, "expected", "nothing observed it, so it is a prediction");
  assert.equal(task.agent, "plan");
  assert.equal(task.variant, "max");

  // An observation replaces the prediction here too, which is the branch the
  // release note tells callers to take.
  const observed = makeFakeEnv({ extra: { HOME: home, AGY_FAKE_OBSERVED_MODEL: "openai/gpt-5-codex" } });
  const observedTask = JSON.parse(
    runCompanion(["task", "--json", "--", "again"], { env: observed.env, cwd }).stdout
  );
  assert.equal(observedTask.model, "openai/gpt-5-codex");
  assert.equal(observedTask.modelSource, "event-stream");
  assert.equal(observedTask.modelCertainty, "actual");

  const reviewEnv = makeFakeEnv({ mode: "review-json", extra: { HOME: home } });
  const review = JSON.parse(runCompanion(["review", "--json"], { env: reviewEnv.env, cwd }).stdout);
  assert.equal(review.model, "deepseek/deepseek-v4-flash");
  assert.equal(review.modelSource, "config:agent.plan.model");
  assert.equal(review.modelCertainty, "expected");
  assert.equal(review.agent, "plan", "read-only reviews run on the plan agent");
  assert.equal(review.variant, "max");
  // And the handle: `task --json` always carried it, `review --json` did not.
  assert.match(review.jobId, /^review-/);
  const stored = JSON.parse(
    runCompanion(["status", review.jobId, "--json"], { env: reviewEnv.env, cwd }).stdout
  ).job;
  assert.equal(stored.id, review.jobId, "the id in the document must address the stored job");

  // The empty-target document keeps the same key set, so a consumer never has
  // to shape-check before reading.
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "--quiet", "-m", "clean"], { cwd });
  const empty = JSON.parse(runCompanion(["review", "--json"], { env: reviewEnv.env, cwd }).stdout);
  assert.equal(empty.outputState, "empty");
  for (const key of ["jobId", "model", "modelSource", "modelCertainty", "agent", "variant"]) {
    assert.ok(key in empty, `${key} must be present on the empty document too`);
    assert.equal(empty[key], null, `${key} must be null when no run happened`);
  }
});

// The other half of the same README sentence: "every one of those documents
// also carries `jobId`". `task --json` and `review --json` do; `status <id>
// --json` and `result <id> --json` shipped `{job, hasResult, resultComplete}`
// and `{job, payload}`, so a caller that read `doc.jobId` uniformly across the
// four documents got `undefined` on exactly the two that address a stored run.
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

// PC5 asked for the model that actually ran. Deriving it from `~/.config` alone
// makes a confident claim about a model that never ran in any repository with
// its own `agy.json` — which agy applies over the global file.
test("a project-level agy config wins over the global one", () => {
  const home = makeAgyHome(CONFIG);
  const fake = makeFakeEnv({ extra: { HOME: home } });
  const cwd = makeTempGitRepo();
  fs.writeFileSync(
    path.join(cwd, "agy.json"),
    JSON.stringify({ agent: { plan: { model: "zai/glm-5", variant: "high" } } })
  );

  const config = readAgyModelConfig({ homeDir: home, cwd });
  assert.equal(config.agentModels.plan, "zai/glm-5");
  assert.equal(config.agentVariants.plan, "high");
  // Keys the project file does not set still come from the global one.
  assert.equal(config.model, "anthropic/claude-opus-4-1");
  assert.equal(config.projectFile, path.join(cwd, "agy.json"));
  assert.equal(config.files.length, 2);

  const result = runCompanion(["task", "--", "look at the diff"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Model \(expected\): zai\/glm-5 \(agent plan, variant high\)/);
  assert.doesNotMatch(result.stdout, /deepseek-v4-flash/);

  const setup = JSON.parse(runCompanion(["setup", "--json"], { env: fake.env, cwd }).stdout);
  assert.equal(setup.readOnlyModel, "zai/glm-5");
  // The subprocess sees the realpath of cwd (/private/var/... on macOS), so
  // compare the tail rather than the absolute string.
  assert.ok(
    setup.modelConfigFiles.at(-1).endsWith(path.join(path.basename(cwd), "agy.json")),
    `project config should be the last layer, got ${setup.modelConfigFiles.at(-1)}`
  );
});

// When the run itself names the model, that is an observation and it replaces
// every inference — including one made from a config file this plugin cannot
// see (environment overrides, an agy-side default change).
test("a model reported by the run itself replaces the inferred one", () => {
  const home = makeAgyHome(CONFIG);
  const fake = makeFakeEnv({ extra: { HOME: home, AGY_FAKE_OBSERVED_MODEL: "openai/gpt-5-codex" } });
  const cwd = makeTempGitRepo();

  const result = runCompanion(["task", "--", "look at the diff"], { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Model: openai\/gpt-5-codex \(agent plan, variant max\)/);
  assert.doesNotMatch(result.stdout, /Model \(expected\)/);
  // The footer reports the observation, not the config guess. (The pre-run
  // warning above it still names the configured agent model, which is what it
  // is about — and it now says "expected to run on", not "its model is".)
  const footer = result.stdout.split("\n---\n").at(-1);
  assert.doesNotMatch(footer, /deepseek-v4-flash/);

  const jobId = result.stdout.match(/Job: (task-[\w-]+)/)[1];
  const stored = JSON.parse(runCompanion(["status", jobId, "--json"], { env: fake.env, cwd }).stdout).job;
  assert.equal(stored.model, "openai/gpt-5-codex");
  assert.equal(stored.modelSource, "event-stream");
  assert.equal(stored.modelCertainty, "actual");
});
