import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { terminateProcessTree } from "./process.mjs";

const STDERR_TAIL_CHARS = 4000;
const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

// Stop reasons that mean "the model finished its turn on purpose".
export const CLEAN_STOP_REASONS = new Set(["stop", "end_turn", "end-turn", "endturn", "complete"]);
// Known reasons for a run ending before a final answer existed. Deliberately a
// blacklist: agy may add vocabulary, and an unknown value must never flip
// a real answer into `incomplete` (it only raises a warning).
export const INCOMPLETE_STOP_REASONS = new Set([
  "tool-calls",
  "tool_calls",
  "toolcalls",
  "length",
  "max-tokens",
  "max_tokens",
  "max-turns",
  "max_turns",
  "aborted",
  "abort",
  "cancelled",
  "canceled",
  "error",
  "content-filter",
  "content_filter",
  "permission-denied",
  "permission_denied"
]);
// Below this many characters a final answer looks like narration rather than an
// answer — but only when the run did work (tool calls) for a prompt big enough
// that a one-liner cannot plausibly be the deliverable.
export const DEFAULT_MIN_ANSWER_CHARS = 200;
export const NARRATION_PROMPT_CHARS = 1000;
export const MIN_ANSWER_CHARS_ENV = "AGY_COMPANION_MIN_ANSWER_CHARS";

function resolveMinAnswerChars(minAnswerChars, env) {
  if (minAnswerChars !== null && minAnswerChars !== undefined && minAnswerChars !== "") {
    const explicit = Number(minAnswerChars);
    if (Number.isFinite(explicit) && explicit >= 0) {
      return explicit;
    }
  }
  const fromEnv = Number(env?.[MIN_ANSWER_CHARS_ENV]);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_MIN_ANSWER_CHARS;
}

// Three-state verdict for one agy run. `exitCode === 0` on its own proves
// nothing: agy exits 0 after auto-rejecting a permission request, after
// running out of tool budget, and after emitting a single line of narration.
export function classifyOutcome({
  exitCode,
  spawnError = null,
  parsed,
  toolEventCount = 0,
  promptChars = 0,
  hasStructuredOutput = false,
  structuredOutputInvalid = false,
  minAnswerChars = null,
  env = process.env
} = {}) {
  const stopReason = parsed?.stopReason ?? null;
  const text = String(parsed?.text ?? "").trim();
  const base = {
    stopReason,
    textChars: text.length,
    toolEventCount: Number(toolEventCount) || 0,
    warnings: []
  };

  if (spawnError || !parsed) {
    return {
      ...base,
      state: "failed",
      reason: spawnError ? "spawn-error" : "no-output"
    };
  }

  // agy states its own verdict in `status`, and the two signals do not always
  // agree in the direction the exit code suggests. Measured: a run that answered
  // at length and then tripped a permission boundary on a follow-up tool call
  // reported `status: "ERROR"` with a substantial `response`. Throwing that
  // answer away would be worse than reporting it as what it is — partial.
  if (parsed.status === "ERROR") {
    return text.length > 0
      ? { ...base, state: "incomplete", reason: "run-error-with-partial-output" }
      : { ...base, state: "failed", reason: "run-error" };
  }

  if (exitCode !== 0) {
    return { ...base, state: "failed", reason: "exit-code" };
  }

  if (text.length === 0) {
    return { ...base, state: "incomplete", reason: "empty-text" };
  }

  // The review-kind twin of the empty-answer case: the run talked, but what it
  // produced is not the deliverable the schema asked for. Falling back to the
  // raw output is right; calling it `completed` is not.
  if (structuredOutputInvalid) {
    return { ...base, state: "incomplete", reason: "schema-mismatch" };
  }

  if (stopReason) {
    const normalized = String(stopReason).trim().toLowerCase();
    if (INCOMPLETE_STOP_REASONS.has(normalized)) {
      return { ...base, state: "incomplete", reason: "stop-reason" };
    }
    if (!CLEAN_STOP_REASONS.has(normalized)) {
      base.warnings.push(
        `agy reported an unrecognised stopReason "${stopReason}"; treating the run as complete. Report it if the answer looks truncated.`
      );
    }
  }

  const threshold = resolveMinAnswerChars(minAnswerChars, env);
  if (
    !hasStructuredOutput &&
    base.toolEventCount > 0 &&
    promptChars >= NARRATION_PROMPT_CHARS &&
    text.length < threshold
  ) {
    return { ...base, state: "incomplete", reason: "narration" };
  }

  return { ...base, state: "completed", reason: null };
}

// What to do next, per failure class. The classification never changes the
// pass/fail verdict — a misread stderr tail must only ever cost a wrong
// suggestion — so these are printed *above* the untouched stderr block.
export const FAILURE_CLASS_GUIDANCE = {
  model_unauthorized:
    "This Google account is not authorised for the requested model. Choose one \`agy models\` lists for you, or drop --model and let agy pick. Retrying the same model will fail the same way.",
  model_not_found:
    "agy does not recognise that model id. \`agy models\` lists the ids it accepts (e.g. \`gemini-3.7-flash-low\`, \`claude-sonnet-4-6\`); agy's own list is in the error below.",
  quota_exhausted:
    "The provider balance or quota is exhausted. Top it up or switch provider — this is not a plugin or prompt problem, and retrying will not help.",
  auth_required:
    "agy is not signed in. Run \`agy\` once in a terminal and complete the Google sign-in, then /agy:setup to confirm before re-running.",
  provider_error:
    "The provider returned a server-side error, which is worth retrying once. If it repeats, switch provider rather than rewording the prompt.",
  rate_limited:
    "The provider is rate-limiting or is overloaded. This one is transient: wait and re-run the same request unchanged — the model, the prompt and the plugin are not the problem. If it repeats immediately, the account's own rate ceiling is the limit, not this run.",
  agy_failed:
    "agy exited non-zero without a recognised reason. The run document's \`error\` field is the evidence; if it is empty too, re-run with a narrower task."
};

// Ordered, because a provider often states two things on one line: the class
// that decides what the caller should *do* wins. Billing before throughput
// (waiting does not refill a balance), and every HTTP code has to travel with
// context — a bare 403 is what git says about a private remote.
const FAILURE_CLASS_PATTERNS = [
  [
    "model_unauthorized",
    /\b403\b[^\n]{0,160}\bmodels?\b|\bmodels?\b[^\n]{0,160}\b403\b|not authori[sz]ed to access the requested model|unauthori[sz]ed to (?:use|access) (?:the )?model|(?:does not|doesn't|do not) have access to (?:the )?model/i
  ],
  [
    "quota_exhausted",
    /\b402\b|insufficient (?:credit|balance|funds|quota)|credit balance is too low|quota (?:exceeded|exhausted)|exceeded your (?:current |monthly |daily )?quota|out of credits|billing hard limit/i
  ],
  ["auth_required", /\b401\b|no credentials|not authenticated|unauthenticated|authentication required|auth login/i],
  ["rate_limited", /\b429\b|rate[ _-]?limit|too many requests|overloaded|slow down/i],
  // agy's own hint names an id (`Did you mean: aihubmix/gpt-5?`). Bare
  // "did you mean" is ordinary English — a model asking "Did you mean to run
  // the tests first?" is not a missing-model error.
  [
    "model_not_found",
    /model not found|unknown model|no such model id|is not recognized as a known model|invalid model selection|did you mean:?\s*["'`]?[\w.-]+\/[\w.:-]+/i
  ],
  ["provider_error", /unexpected server error|internal server error|\b5\d\d\s+(?:error|status)/i]
];

// Classifies *why* a run failed, from the evidence a headless run leaves behind.
// Returns null for a run that did not fail: the caller keeps `failureClass` free
// for the companion's own labels (`timeout`, `interrupted`, `orphaned`).
//
// Only stderr is evidence. The model's own answer used to be part of the
// haystack, so a run that failed *after* writing a sentence containing "HTTP
// 403" or "did you mean …" was labelled from its own prose rather than from
// what the provider said.
export function classifyFailure({ exitCode = null, spawnError = null, stderrTail = "", errorText = null } = {}) {
  if (!spawnError && exitCode === 0 && !errorText) {
    return null;
  }
  if (spawnError) {
    return "agy_failed";
  }
  // agy puts its failure reason in the run document on stdout, not on stderr —
  // measured: an unrecognised --model exits 1 with an empty stderr and the whole
  // explanation inside `error`. Reading only stderr classified every real agy
  // failure as "no recognised reason".
  const haystack = `${String(stderrTail ?? "")}\n${String(errorText ?? "")}`;
  for (const [failureClass, pattern] of FAILURE_CLASS_PATTERNS) {
    if (pattern.test(haystack)) {
      return failureClass;
    }
  }
  return "agy_failed";
}

// A headless agy run has no interactive approver, so every permission prompt
// resolves to *denied*. The run then ends `status: "ERROR"` having done nothing.
// Measured (agy 1.1.15):
//   permission check failed for command "cat a.txt": user denied permission to
//   run command:\ncat a.txt
// This is the single most likely failure mode of a run that forgot
// `--dangerously-skip-permissions`, and it is silent in the sense that agy
// still writes a well-formed JSON document — the emptiness is in `response`.
const PERMISSION_DENIED_PATTERN =
  /permission check failed for (?:command|tool call|)?\s*["`']?([\w-]+)?["`']?\s*(?:\(([^)]*)\))?[^:]*:\s*user denied permission/gi;
// agy protects some of its own paths regardless of the skip-permissions flag.
// Measured: reading back a file it had just written under
// ~/.gemini/antigravity-cli/ failed with this.
const PROTECTED_BOUNDARY_PATTERN =
  /Permission denied for (\w+)\(([^)]*)\)\.\s*Matches hardcoded system protection boundary rule/gi;

// Reads the denial evidence out of an agy run. Unlike the opencode runtime this
// was ported from, the evidence is in the run's own `error` field rather than on
// stderr, so callers pass the error text in alongside the stderr tail.
export function detectPermissionWarnings(stderrTail, { cwd = null, errorText = null } = {}) {
  const warnings = [];
  const seen = new Set();
  const haystack = `${String(stderrTail ?? "")}\n${String(errorText ?? "")}`;

  for (const match of haystack.matchAll(PERMISSION_DENIED_PATTERN)) {
    const target = (match[1] ?? match[2] ?? "a tool call").trim();
    const key = `denied:${target}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    warnings.push({
      class: "permission_auto_denied",
      permission: target,
      path: null,
      message:
        `permission_auto_denied: agy asked for permission to run \`${target}\` and, having no interactive approver, ` +
        "denied itself. The run did no work. Headless agy needs --dangerously-skip-permissions for any tool use at all; " +
        "neither --sandbox nor --mode plan is a substitute."
    });
  }

  for (const match of haystack.matchAll(PROTECTED_BOUNDARY_PATTERN)) {
    const tool = match[1];
    const target = match[2].trim();
    const key = `boundary:${tool}:${target}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    warnings.push({
      class: "protected_path_blocked",
      permission: tool,
      path: target,
      message:
        `protected_path_blocked: agy refused ${tool} on ${target} — it sits behind agy's own hardcoded protection ` +
        "boundary, which --dangerously-skip-permissions does not lift. Anything that needed it was skipped."
    });
  }

  // Not a denial, but the same shape of silent uselessness: a run that was never
  // pointed at the repository. agy ignores the process cwd entirely.
  if (cwd && /does not exist in the (?:current working directory|workspace)/i.test(haystack)) {
    warnings.push({
      class: "workspace_not_targeted",
      permission: null,
      path: cwd,
      message:
        `workspace_not_targeted: agy reported files missing from ${cwd}. agy does not inherit the process working ` +
        "directory — without --add-dir it operates in ~/.gemini/antigravity-cli and sees none of the repository."
    });
  }

  return warnings;
}

export function getAgyAvailability() {
  const version = spawnSync("agy", ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (version.error || version.status !== 0) {
    return {
      available: false,
      authenticated: false,
      usable: false,
      detail: "The `agy` binary was not found on PATH. Install it with `brew install --cask antigravity-cli`."
    };
  }

  // agy has no `auth list`. Sign-in state is held in the OS keyring and the only
  // cheap observable proof that it is usable is that the model list resolves —
  // that call goes to Google's backend and fails when the account is not signed
  // in. Anything stronger would cost a model turn.
  const models = spawnSync("agy", ["models"], { encoding: "utf8", timeout: 45_000 });
  const modelText = stripAnsi(String(models.stdout ?? "")).trim();
  const modelIds = modelText
    .split("\n")
    .map((line) => line.split("\t")[0]?.trim())
    .filter((id) => id && !/^Fetching/i.test(id));
  const usable = models.status === 0 && modelIds.length > 0;

  return {
    available: true,
    version: stripAnsi(String(version.stdout ?? "")).trim(),
    // agy signs in with a Google account; there is no per-provider credential
    // list to count, so "authenticated" and "usable" are the same observation.
    authenticated: usable,
    credentialCount: null,
    usable,
    models: modelIds,
    detail: usable
      ? null
      : "agy is installed but could not list models, which usually means it is not signed in. Run `agy` once and complete the Google sign-in, then re-run /agy:setup."
  };
}

// agy resolves its own model and reports it in the run's `init` event, so there
// is nothing to predict from config the way the opencode runtime had to. This
// only validates and passes through what the caller asked for; the model that
// actually answered is read off the run afterwards.
export const EFFORT_LEVELS = new Set(["low", "medium", "high"]);

export function resolveRunSelection({ model = null, effort = null, readOnly = false } = {}) {
  const warnings = [];
  let effectiveEffort = effort;
  if (effort && !EFFORT_LEVELS.has(String(effort).toLowerCase())) {
    warnings.push(
      `Ignoring --effort "${effort}": agy accepts ${[...EFFORT_LEVELS].join(", ")}. Letting agy choose.`
    );
    effectiveEffort = null;
  }
  return {
    model: model ?? null,
    effort: effectiveEffort ? String(effectiveEffort).toLowerCase() : null,
    readOnly,
    // `--model` is the one value this plugin puts on the command line. Without
    // it the model is genuinely unknown until the run's init event names it —
    // which is "unknown", not "expected". This runtime never guesses.
    source: model ? "flag" : "agy-default",
    certainty: model ? "actual" : "unknown",
    warnings
  };
}

// Folds companion-level concerns into the prompt. Unlike the opencode runtime,
// the JSON schema does NOT go in here: agy takes it as a real flag
// (`--json-schema`) and returns the validated object in `structured_output`.
// The schema is still restated in the prompt, because a model that has been told
// what shape to produce produces it more reliably than one that has only been
// constrained after the fact.
export function composePrompt({ prompt, rules = null, jsonSchema = null }) {
  const blocks = [];
  if (rules) {
    blocks.push(`<system_rules>\n${rules}\n</system_rules>`);
  }
  blocks.push(prompt);
  if (jsonSchema) {
    blocks.push(
      [
        "<output_schema>",
        "Your final answer must be a single JSON object that validates against this JSON Schema.",
        JSON.stringify(jsonSchema, null, 2),
        "</output_schema>"
      ].join("\n")
    );
  }
  return blocks.join("\n\n");
}

// The flag vector for one agy run.
//
// Two flags here are load-bearing in a way that is not obvious and is easy to
// "simplify" away later, so both are justified at the call site:
//
//   --add-dir <workspace>
//     agy does NOT use the process working directory. Measured: launched from a
//     repository without --add-dir, agy reported its working directory as
//     ~/.gemini/antigravity-cli, could not see the repository's files, and
//     created a file in its own state directory. --add-dir is the only thing
//     that decides what the run can see, which is also why read-only runs get a
//     throwaway mirror here rather than a mode flag.
//
//   --dangerously-skip-permissions
//     Without it every tool call is auto-denied and the run ends having done
//     nothing (see PERMISSION_DENIED_PATTERN). --sandbox does not help, and
//     --mode plan does not either. Read capability and write capability are not
//     separable at agy's CLI, so isolation is done by choosing the workspace.
//
// --mode plan is deliberately NOT used for read-only runs. Measured: plan mode
// refuses reads and shell commands too, resolves its workspace to
// ~/.gemini/antigravity-cli/scratch, and writes a plan artifact while waiting
// for an approval that never arrives in headless mode. A reviewer that reads
// nothing is not a reviewer.
export function buildAgyArgs({
  prompt,
  workspace,
  model = null,
  effort = null,
  resumeConversationId = null,
  readOnly = false,
  jsonSchema = null,
  jsonSchemaFile = null,
  rules = null,
  outputFormat = "stream-json",
  printTimeout = null,
  logFile = null
}) {
  const args = ["-p", composePrompt({ prompt, rules, jsonSchema })];
  args.push("--output-format", outputFormat);

  if (!workspace) {
    throw new Error(
      "buildAgyArgs requires a workspace: agy ignores the process working directory, so a run without --add-dir cannot see the repository."
    );
  }
  args.push("--add-dir", workspace);

  // Read-only is a property of *which directory this is*, not of a mode flag.
  // The caller hands a throwaway mirror for read-only runs and the real
  // repository for write runs; agy is given the same permissions either way
  // because it has no way to grant one without the other.
  args.push("--dangerously-skip-permissions");
  if (!readOnly) {
    args.push("--mode", "accept-edits");
  }

  if (resumeConversationId) {
    args.push("--conversation", resumeConversationId);
  }
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", String(effort).toLowerCase());
  }
  if (jsonSchemaFile) {
    args.push("--json-schema", jsonSchemaFile);
  }
  if (printTimeout) {
    args.push("--print-timeout", printTimeout);
  }
  if (logFile) {
    args.push("--log-file", logFile);
  }
  // The prompt is user text and may legitimately start with a slash. Without
  // this, agy reinterprets it as one of its own slash commands.
  args.push("--disable-slash-commands");

  return args;
}
// Parses what an agy run wrote to stdout.
//
// Two shapes, both handled here because the companion picks the format per run:
//
//   --output-format json        one JSON object, the whole document:
//     {"conversation_id":"<uuid>","status":"SUCCESS","response":"<final text>",
//      "duration_seconds":2.9,"num_turns":1,"usage":{...}}
//     On failure: status "ERROR" plus an "error" string.
//
//   --output-format stream-json NDJSON, one event per line:
//     {"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…","tools":[…]}}
//     {"event":"step_update","step_update":{…,"step_type":"agent_response","text_delta":"…"}}
//     {"event":"result","result":{ …the object above… }}
//
// stream-json is preferred by the companion because only its `init` event names
// the model that actually ran. agy resolves its own model and there is no config
// file to predict it from, so a run parsed from the plain `json` form reports
// `observedModel: null` and the renderer must say the model is unknown rather
// than inventing an expectation.
export function parseAgyOutput(stdout, { cwd = null } = {}) {
  const raw = stripAnsi(String(stdout ?? "")).trim();
  if (!raw) {
    return null;
  }

  let result = null;
  let observedModel = null;
  let reportedCwd = null;
  let toolEventCount = 0;
  const textParts = [];
  let sawAnyEvent = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // The plain `json` form: a bare result object with no "event" envelope.
    if (!event.event && typeof event.status === "string" && "conversation_id" in event) {
      result = event;
      sawAnyEvent = true;
      continue;
    }

    sawAnyEvent = true;
    switch (event.event) {
      case "init":
        observedModel = event.init?.model ?? null;
        // Recorded but deliberately NOT trusted as proof of workspace
        // targeting: measured, init.cwd reports the shell's cwd even on runs
        // whose agent actually operated in ~/.gemini/antigravity-cli.
        reportedCwd = event.init?.cwd ?? null;
        break;
      case "step_update": {
        const step = event.step_update ?? {};
        if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
          textParts.push(step.text_delta);
        } else if (step.step_type && step.step_type !== "user_input" && step.step_type !== "checkpoint") {
          // Anything that is neither the prompt nor a bookkeeping checkpoint is
          // the run doing work. `classifyOutcome` uses this to tell a one-line
          // answer that followed real work from one that followed none.
          toolEventCount += 1;
        }
        break;
      }
      case "result":
        result = event.result ?? null;
        break;
      default:
        break;
    }
  }

  if (!sawAnyEvent) {
    return null;
  }

  // The result object is authoritative for the final text; the streamed deltas
  // are the fallback for a run that was killed before it emitted one.
  const text = String(result?.response ?? textParts.join("") ?? "").trim();
  const status = result?.status ?? null;
  const errorText = result?.error ?? null;

  return {
    text,
    conversationId: result?.conversation_id ?? null,
    status,
    errorText,
    // agy has no stopReason vocabulary of its own. Its status is the nearest
    // equivalent, mapped onto the vocabulary classifyOutcome already speaks so
    // an ERROR run cannot be read as a finished turn.
    stopReason: status === "SUCCESS" ? "stop" : status === "ERROR" ? "error" : status ? String(status).toLowerCase() : null,
    observedModel,
    reportedCwd,
    toolEventCount,
    skillsLoaded: [],
    // Native structured output. Present only when the run was given
    // --json-schema, and already validated by agy against that schema.
    structuredOutput: result?.structured_output ?? null,
    usage: result?.usage ?? null,
    durationSeconds: result?.duration_seconds ?? null,
    numTurns: result?.num_turns ?? null,
    cwd
  };
}
export function extractStructuredJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return null;
  }

  const candidates = [raw];
  for (const match of raw.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)) {
    candidates.push(match[1]);
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Enough of JSON Schema to hold `schemas/review-output.schema.json` to its
// word, with no dependency: type, required, enum, minLength, minimum/maximum,
// properties and items. `additionalProperties` is deliberately not enforced —
// an extra key is not a reason to throw away an otherwise well-formed review,
// and the renderer only reads the keys it knows.
export function validateAgainstSchema(value, schema, pointer = "") {
  const errors = [];
  const at = pointer || "(root)";
  if (!schema || typeof schema !== "object") {
    return errors;
  }

  const type = schema.type;
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return [`${at}: expected an object`];
    }
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === null || value[key] === undefined) {
        errors.push(`${at}: missing required key "${key}"`);
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value && value[key] !== null && value[key] !== undefined) {
        errors.push(...validateAgainstSchema(value[key], subSchema, pointer ? `${pointer}.${key}` : key));
      }
    }
    return errors;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      return [`${at}: expected an array`];
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateAgainstSchema(item, schema.items, `${pointer}[${index}]`));
      });
    }
    return errors;
  }

  if (type === "string") {
    if (typeof value !== "string") {
      return [`${at}: expected a string`];
    }
    if (Number.isFinite(schema.minLength) && value.trim().length < schema.minLength) {
      errors.push(`${at}: must not be empty`);
    }
  } else if (type === "integer" || type === "number") {
    if (typeof value !== "number" || Number.isNaN(value) || (type === "integer" && !Number.isInteger(value))) {
      return [`${at}: expected ${type === "integer" ? "an integer" : "a number"}`];
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push(`${at}: must be >= ${schema.minimum}`);
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push(`${at}: must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${at}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
  }
  return errors;
}
// One human-readable line per agy stream event, for the job log.
function describeEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  switch (event.event) {
    case "init":
      return `[init] model=${event.init?.model ?? "?"} tools=${event.init?.tools?.length ?? 0}`;
    case "step_update": {
      const step = event.step_update ?? {};
      if (step.step_type === "agent_response" && step.text_delta) {
        const preview = String(step.text_delta).split(/\r?\n/, 1)[0].slice(0, 100);
        return preview ? `[text] ${preview}` : null;
      }
      return `[step] ${step.step_type ?? "?"} (${step.state ?? "?"})`;
    }
    case "result":
      return `[result] ${event.result?.status ?? "?"} in ${event.result?.duration_seconds ?? "?"}s`;
    default:
      return null;
  }
}

// Runs one headless agy turn. The child is detached into its own process group
// so `cancel` and session teardown can terminate the whole tree.
//
// agy does have a deadline flag of its own (`--print-timeout`, default 5m0s),
// but `timeoutMs` is still enforced here: --print-timeout bounds agy's wait for
// the print to complete, not the lifetime of the process tree it spawned, and a
// companion that cannot outlive its child cannot record what the child produced.
export function runAgy(
  options,
  { cwd, logFile = null, onSpawn = null, onExit = null, timeoutMs = null } = {}
) {
  // agy takes the schema as a real flag pointing at a file, and returns the
  // validated object in `structured_output` — so the schema is written to disk
  // for the run rather than only described in the prompt.
  let schemaFile = null;
  if (options.jsonSchema && !options.jsonSchemaFile) {
    schemaFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "agy-schema-")),
      "review-output.schema.json"
    );
    fs.writeFileSync(schemaFile, JSON.stringify(options.jsonSchema));
    options = { ...options, jsonSchemaFile: schemaFile };
  }
  const cleanupSchema = () => {
    if (!schemaFile) {
      return;
    }
    try {
      fs.rmSync(path.dirname(schemaFile), { recursive: true, force: true });
    } catch {
      // Temp litter, never a reason to fail a run that produced an answer.
    }
  };

  const args = buildAgyArgs(options);
  const startedAt = Date.now();
  const logStream = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null;

  return new Promise((resolve) => {
    // Spawned from the workspace, not from the caller's cwd. agy echoes the
    // spawning process's working directory in its init event regardless of
    // where its agent actually operates, so spawning a read-only run from the
    // real repository would hand it the one path the isolation depends on it
    // never being told.
    const child = spawn("agy", args, {
      cwd: options.workspace ?? cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let lineBuffer = "";
    let stderrTail = "";

    if (onSpawn) {
      // The buffered stream is handed over as accessors, not a copy: a
      // companion killed mid-run has to be able to store whatever agy had
      // produced by then, from inside a synchronous signal handler.
      onSpawn(child, { getStdout: () => stdout, getStderrTail: () => stripAnsi(stderrTail) });
    }

    let timedOut = false;
    const deadline =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            // Signals the whole group: the child is detached, so its own
            // children would otherwise survive the kill.
            terminateProcessTree(child.pid ?? Number.NaN);
          }, timeoutMs)
        : null;
    const clearDeadline = () => {
      if (deadline) {
        clearTimeout(deadline);
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      lineBuffer += text;
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const note = describeEventLine(lineBuffer.slice(0, newlineIndex));
        if (note) {
          logStream?.write(`${note}\n`);
        }
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        newlineIndex = lineBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      logStream?.write(text);
    });

    child.on("error", (error) => {
      clearDeadline();
      cleanupSchema();
      logStream?.end();
      resolve({
        exitCode: null,
        spawnError: error.message,
        parsed: null,
        stdout: "",
        stderrTail,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });

    child.on("close", (code) => {
      clearDeadline();
      cleanupSchema();
      logStream?.end();
      // Announced before parsing: from here on the pid is dead but the job
      // record is still `running`, and parsing a large stream is not instant.
      // A throwing hook must not strand the promise.
      try {
        onExit?.(code);
      } catch {
        // Bookkeeping only; the run's verdict does not depend on it.
      }
      const stream = parseAgyOutput(stdout, { cwd });

      // Structured output has two sources and they are not equal. agy validated
      // `structured_output` against the schema itself, so it is believed. The
      // text fallback exists for runs where the field is absent — and a parsed
      // object is still not a review, so it is validated before being believed.
      let structuredOutput = null;
      let structuredOutputErrors = [];
      let structuredOutputSource = null;
      if (stream && options.jsonSchema) {
        if (stream.structuredOutput && typeof stream.structuredOutput === "object") {
          structuredOutput = stream.structuredOutput;
          structuredOutputSource = "agy";
          // Re-validated even though agy already did: the schema this plugin
          // renders from is the one it wrote, and a mismatch here means the two
          // disagree, which is worth surfacing rather than trusting blindly.
          structuredOutputErrors = validateAgainstSchema(structuredOutput, options.jsonSchema);
          if (structuredOutputErrors.length > 0) {
            structuredOutput = null;
          }
        } else {
          const candidate = extractStructuredJson(stream.text);
          if (candidate) {
            structuredOutputErrors = validateAgainstSchema(candidate, options.jsonSchema);
            structuredOutput = structuredOutputErrors.length === 0 ? candidate : null;
            structuredOutputSource = structuredOutput ? "text" : null;
          } else {
            structuredOutputErrors = ["(root): the final answer contained no JSON object"];
          }
        }
      }

      const parsed = stream
        ? {
            text: stream.text,
            conversationId: stream.conversationId,
            status: stream.status,
            errorText: stream.errorText,
            stopReason: stream.stopReason,
            // Read off the run's own init event. agy has no user-facing model
            // config, so when this is null the model is genuinely unknown —
            // never a prediction dressed up as an observation.
            observedModel: stream.observedModel ?? null,
            reportedCwd: stream.reportedCwd ?? null,
            toolEventCount: stream.toolEventCount,
            skillsLoaded: stream.skillsLoaded ?? [],
            usage: stream.usage ?? null,
            structuredOutput,
            structuredOutputErrors,
            structuredOutputSource,
            expectedStructuredOutput: Boolean(options.jsonSchema)
          }
        : null;
      resolve({
        // A kill leaves `code === null` (signal), which classifies as failed. A
        // child that still managed to exit 0 inside the kill window produced a
        // real answer, and throwing it away would be worse than reporting it.
        exitCode: code,
        spawnError: null,
        parsed,
        stdout,
        stderrTail: stripAnsi(stderrTail),
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
  });
}
