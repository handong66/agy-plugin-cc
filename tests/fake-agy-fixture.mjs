#!/usr/bin/env node
// Emulates the slice of the agy CLI surface the companion runtime touches, so
// the suite runs without a real agy install, a Google sign-in, or model calls.
//
// The shapes below are copied from real agy 1.1.15 output captured on macOS;
// see .local/sdd/AGY-RUNTIME-CONTRACT.md for the captures they were taken from.
//
// Behaviour is steered by env vars:
//   AGY_FAKE_MODE            success (default) | review-json | fail | silent
//                              | empty-text | narration | hang | run-error
//                              | run-error-with-text
//   AGY_FAKE_TEXT            final answer text for success mode
//   AGY_FAKE_STATUS          overrides the result status (SUCCESS | ERROR)
//   AGY_FAKE_ERROR           the result document's `error` string
//   AGY_FAKE_STDERR          written to stderr before the run exits
//   AGY_FAKE_ARGS_FILE       when set, argv is dumped there as JSON
//   AGY_FAKE_OBSERVED_MODEL  model id reported on the init event — the only
//                              place a real run says what actually answered
//   AGY_FAKE_STRUCTURED      JSON string returned as `structured_output`, the
//                              way a real --json-schema run returns it
//   AGY_FAKE_SKILL           name of an interactive skill this run loads first
//   AGY_FAKE_SKILL_READ      a path this run reads as an ordinary file
//   AGY_FAKE_ORPHAN_RACE     relabels this run's own job record as
//                              failed/orphaned just before exiting, standing in
//                              for a concurrent reader reconciling it

import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const mode = process.env.AGY_FAKE_MODE ?? "success";
const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";

function flagValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

// Any reader — `status --all`, the Stop hook, the caller's own `status --wait`
// poll — reconciles a `running` record whose pid is gone. This reproduces that
// write from inside the run, deterministically.
async function simulateConcurrentReconcile() {
  if (!process.env.AGY_FAKE_ORPHAN_RACE) {
    return;
  }
  const stateModule = new URL("../plugins/agy/scripts/lib/state.mjs", import.meta.url);
  const { listJobs, upsertJob } = await import(stateModule.href);
  const cwd = process.cwd();
  for (const job of listJobs(cwd, { reconcile: false })) {
    if (job.status !== "running" && job.status !== "queued") {
      continue;
    }
    upsertJob(cwd, {
      id: job.id,
      status: "failed",
      failureClass: "orphaned",
      endedAt: new Date().toISOString(),
      summary: "process exited without writing a result (companion was killed or the machine restarted)"
    });
  }
}

if (args[0] === "--version") {
  process.stdout.write("9.9.9-fake\n");
  process.exit(0);
}

// agy has no `auth` subcommand; readiness is probed through `models`, which
// only resolves when the CLI is signed in.
if (args[0] === "models" || args[0] === "agents" || args[0] === "agent") {
  if (args[0] === "models") {
    process.stdout.write("fake-model-one\tFake Model One\nfake-model-two\tFake Model Two\n");
  }
  process.exit(0);
}

const isPrintRun = args.includes("-p") || args.includes("--print") || args.includes("--prompt");
if (!isPrintRun) {
  process.stderr.write(`fake agy: unsupported invocation: ${args.join(" ")}\n`);
  process.exit(64);
}

if (process.env.AGY_FAKE_ARGS_FILE) {
  fs.writeFileSync(process.env.AGY_FAKE_ARGS_FILE, JSON.stringify(args, null, 2));
}
if (process.env.AGY_FAKE_STDERR) {
  process.stderr.write(`${process.env.AGY_FAKE_STDERR}\n`);
}

const streaming = flagValue("--output-format") === "stream-json";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitInit() {
  if (!streaming) {
    return;
  }
  emit({
    event: "init",
    conversation_id: CONVERSATION_ID,
    init: {
      model: process.env.AGY_FAKE_OBSERVED_MODEL ?? "fake-model-one",
      cwd: process.cwd(),
      tools: ["read_file", "write_file", "run_command"]
    }
  });
  emit({
    event: "step_update",
    step_update: { conversation_id: CONVERSATION_ID, step_index: 0, state: "DONE", step_type: "user_input" }
  });
}

// A "tool call" in agy's stream is a step that is neither the prompt nor a
// checkpoint. The companion counts these to tell a one-line answer that
// followed real work from one that followed none.
function emitWork(count) {
  if (!streaming) {
    return;
  }
  for (let index = 0; index < count; index += 1) {
    emit({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: index + 1,
        state: "DONE",
        step_type: "tool_use",
        duration_seconds: 0.4
      }
    });
  }
}

function emitResult({ status = "SUCCESS", response = "", error = null, structured = null }) {
  const usage = {
    input_tokens: 1000,
    output_tokens: response.length,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 1000 + response.length
  };
  const result = {
    conversation_id: CONVERSATION_ID,
    status,
    response,
    duration_seconds: 1.5,
    num_turns: 1,
    usage
  };
  if (error) {
    result.error = error;
  }
  if (structured) {
    result.structured_output = structured;
    result.json_schema = {};
  }
  if (streaming) {
    if (response) {
      emit({
        event: "step_update",
        step_update: {
          conversation_id: CONVERSATION_ID,
          step_index: 99,
          state: "DONE",
          step_type: "agent_response",
          text_delta: response,
          duration_seconds: 1.1,
          usage
        }
      });
    }
    emit({ event: "result", result });
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

function structuredFromEnv() {
  if (!process.env.AGY_FAKE_STRUCTURED) {
    return null;
  }
  try {
    return JSON.parse(process.env.AGY_FAKE_STRUCTURED);
  } catch {
    return null;
  }
}

// A process-level failure: agy could not start the run at all. stdout carries
// the document anyway, and — measured — stderr stays empty while the whole
// explanation sits in `error`.
if (mode === "fail") {
  const error =
    process.env.AGY_FAKE_ERROR ??
    'invalid model selection (--model "no-such-model"): model no-such-model is not recognized as a known model';
  process.stdout.write(
    `${JSON.stringify({ conversation_id: "", status: "ERROR", response: "", error, duration_seconds: 0.1, num_turns: 0, usage: {} })}\n`
  );
  await simulateConcurrentReconcile();
  process.exit(1);
}

if (mode === "silent") {
  await simulateConcurrentReconcile();
  process.exit(0);
}

// A run that never returns. agy's own --print-timeout does not bound the
// process tree it spawned, so only the companion's deadline can end this.
if (mode === "hang") {
  emitInit();
  if (process.env.AGY_FAKE_TEXT && streaming) {
    emit({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: process.env.AGY_FAKE_TEXT
      }
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 120_000));
  process.exit(0);
}

emitInit();

if (process.env.AGY_FAKE_SKILL) {
  emitWork(1);
}
if (process.env.AGY_FAKE_SKILL_READ) {
  try {
    fs.readFileSync(process.env.AGY_FAKE_SKILL_READ, "utf8");
  } catch {
    // The read is the point; whether the file exists is the test's business.
  }
  emitWork(1);
}

if (mode === "empty-text") {
  emitResult({ status: "SUCCESS", response: "" });
  await simulateConcurrentReconcile();
  process.exit(0);
}

// Two minutes of tool calls and one line of narration: the run did work but
// never produced the deliverable.
if (mode === "narration") {
  emitWork(3);
  emitResult({ status: "SUCCESS", response: "Parent contracts read. Now the source files." });
  await simulateConcurrentReconcile();
  process.exit(0);
}

// The measured shape that makes exit code and status disagree: the agent
// answered at length, then tripped a permission boundary on a follow-up call.
if (mode === "run-error-with-text") {
  emitWork(2);
  emitResult({
    status: "ERROR",
    response: process.env.AGY_FAKE_TEXT ?? "Here is what I found before I was stopped.",
    error:
      process.env.AGY_FAKE_ERROR ??
      'permission check failed for read_file "/Users/x/.gemini/antigravity-cli/note.txt": Permission denied for read_file(/Users/x/.gemini/antigravity-cli/note.txt). Matches hardcoded system protection boundary rule.'
  });
  await simulateConcurrentReconcile();
  process.exit(1);
}

// A headless run that forgot --dangerously-skip-permissions: every tool call is
// auto-denied and nothing happens.
if (mode === "run-error") {
  emitResult({
    status: "ERROR",
    response: "",
    error:
      process.env.AGY_FAKE_ERROR ??
      'permission check failed for command "cat a.txt": user denied permission to run command:\ncat a.txt'
  });
  await simulateConcurrentReconcile();
  process.exit(1);
}

if (mode === "review-json") {
  const structured = structuredFromEnv() ?? {
    verdict: "request_changes",
    summary: "One blocking issue in the retry path.",
    findings: [
      {
        severity: "high",
        file: "src/retry.mjs",
        line: 42,
        title: "Retry loop never backs off",
        detail: "The delay is recomputed but never awaited, so all retries fire immediately.",
        confidence: "high"
      }
    ]
  };
  emitWork(3);
  emitResult({
    status: process.env.AGY_FAKE_STATUS ?? "SUCCESS",
    response: JSON.stringify(structured),
    structured
  });
  await simulateConcurrentReconcile();
  process.exit(0);
}

emitWork(process.env.AGY_FAKE_SKILL || process.env.AGY_FAKE_SKILL_READ ? 0 : 2);
emitResult({
  status: process.env.AGY_FAKE_STATUS ?? "SUCCESS",
  response:
    process.env.AGY_FAKE_TEXT ??
    "Reviewed the change. The retry helper is correct and the tests cover the backoff path adequately.",
  error: process.env.AGY_FAKE_ERROR ?? null,
  structured: structuredFromEnv()
});
await simulateConcurrentReconcile();
process.exit(0);
