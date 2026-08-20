import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MIN_ANSWER_CHARS,
  buildAgyArgs,
  classifyOutcome,
  composePrompt,
  extractStructuredJson,
  parseAgyOutput,
  stripAnsi
} from "../plugins/agy/scripts/lib/agycli.mjs";

const CONVERSATION = "11111111-2222-3333-4444-555555555555";

test("stripAnsi removes escape sequences but keeps bracketed text", () => {
  const esc = String.fromCharCode(27);
  assert.equal(stripAnsi(`${esc}[0mhello ${esc}[32m[tool] read${esc}[0m`), "hello [tool] read");
});

test("buildAgyArgs requires a workspace and maps read-only runs to no mode flag", () => {
  const args = buildAgyArgs({ prompt: "task text", workspace: "/tmp/ws", readOnly: true });
  assert.deepEqual(args.slice(0, 4), ["-p", "task text", "--output-format", "stream-json"]);
  assert.ok(args.includes("--add-dir"), "--add-dir is the only thing that sets the workspace");
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/ws");
  assert.ok(args.includes("--dangerously-skip-permissions"));
  // Read-only is a property of *which directory this is* (a disposable mirror),
  // never of a mode flag — --mode plan refuses reads too and is never used.
  assert.equal(args.includes("--mode"), false, "read-only runs never pass a mode flag");
  assert.equal(args.at(-1), "--disable-slash-commands", "the prompt must never be reinterpreted");
  assert.throws(() => buildAgyArgs({ prompt: "x" }), /workspace/);
});

test("buildAgyArgs maps write runs to --mode accept-edits with model/effort/conversation", () => {
  const args = buildAgyArgs({
    prompt: "-starts with dash",
    workspace: "/repo",
    model: "gemini-3.7-flash-low",
    effort: "high",
    resumeConversationId: CONVERSATION
  });
  assert.equal(args[args.indexOf("--mode") + 1], "accept-edits");
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.7-flash-low");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--conversation") + 1], CONVERSATION);
  assert.equal(args[1], "-starts with dash");
  assert.ok(!args.includes("--variant"), "the vector speaks agy's own flag name");
});

test("buildAgyArgs canonicalises the --variant alias onto --effort and drops invalid levels", () => {
  const aliased = buildAgyArgs({ prompt: "x", workspace: "/w", variant: "low" });
  assert.equal(aliased[aliased.indexOf("--effort") + 1], "low");
  assert.ok(!aliased.includes("--variant"));
  const invalid = buildAgyArgs({ prompt: "x", workspace: "/w", effort: "max" });
  assert.ok(!invalid.includes("--effort"), "an effort agy does not accept is not put on the command line");
});

test("composePrompt folds rules and schema into the prompt", () => {
  const prompt = composePrompt({ prompt: "review this", rules: "no side effects", jsonSchema: { type: "object" } });
  assert.match(prompt, /<system_rules>\nno side effects\n<\/system_rules>/);
  assert.match(prompt, /<output_schema>/);
  assert.match(prompt, /"type": "object"/);
  assert.ok(prompt.indexOf("no side effects") < prompt.indexOf("review this"));
});

test("parseAgyOutput reads the model and final text off the streamed events (real capture)", () => {
  // Events shaped exactly like the agy 1.1.15 captures in
  // docs/AGY-RUNTIME-CONTRACT.md §5.
  const stdout = [
    JSON.stringify({
      event: "init",
      conversation_id: CONVERSATION,
      init: { model: "gemini-3.7-flash-low", cwd: "/tmp", tools: ["read_file", "write_file", "run_command"] }
    }),
    JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: CONVERSATION, step_index: 0, state: "DONE", step_type: "user_input" }
    }),
    JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: CONVERSATION, step_index: 1, state: "DONE", step_type: "tool_use" }
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION,
        step_index: 2,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "OK\n",
        usage: {}
      }
    }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: CONVERSATION,
        status: "SUCCESS",
        response: "final text",
        duration_seconds: 2.9,
        num_turns: 1,
        usage: {}
      }
    })
  ].join("\n");
  const parsed = parseAgyOutput(stdout);
  assert.equal(parsed.text, "final text");
  assert.equal(parsed.conversationId, CONVERSATION);
  assert.equal(parsed.status, "SUCCESS");
  assert.equal(parsed.stopReason, "stop");
  assert.equal(parsed.observedModel, "gemini-3.7-flash-low");
  assert.equal(parsed.toolEventCount, 1);
});

test("parseAgyOutput parses the plain json form and reports no model", () => {
  const parsed = parseAgyOutput(
    JSON.stringify({
      conversation_id: CONVERSATION,
      status: "SUCCESS",
      response: "plain",
      duration_seconds: 2.8,
      num_turns: 1,
      usage: {}
    })
  );
  assert.equal(parsed.text, "plain");
  assert.equal(parsed.observedModel, null, "only the init event names the model");
  assert.equal(parsed.status, "SUCCESS");
  assert.equal(parsed.stopReason, "stop");
});

test("parseAgyOutput keeps the text of a run killed before its result event", () => {
  const parsed = parseAgyOutput(
    [
      JSON.stringify({ event: "init", init: { model: "gemini-3.7-flash-low" } }),
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "part one " }
      }),
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "part two" }
      })
    ].join("\n")
  );
  assert.equal(parsed.text, "part one part two");
  assert.equal(parsed.status, null);
  assert.equal(parsed.stopReason, null);
  assert.equal(parsed.observedModel, "gemini-3.7-flash-low");
});

test("parseAgyOutput returns null when no events are present", () => {
  assert.equal(parseAgyOutput(""), null);
  assert.equal(parseAgyOutput("plain text output"), null);
});

test("parseAgyOutput counts tool steps once and surfaces the error field", () => {
  const stdout = [
    JSON.stringify({ event: "init", conversation_id: CONVERSATION, init: { model: "m" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "user_input" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "tool_use" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "tool_use" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "checkpoint" } }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: CONVERSATION,
        status: "ERROR",
        response: "found it before being stopped",
        error: "permission check failed for read_file",
        usage: {}
      }
    })
  ].join("\n");
  const parsed = parseAgyOutput(stdout);
  assert.equal(parsed.toolEventCount, 2);
  assert.equal(parsed.status, "ERROR");
  assert.equal(parsed.errorText, "permission check failed for read_file");
  assert.equal(parsed.stopReason, "error");
});

test("parseAgyOutput exposes native structured output", () => {
  const parsed = parseAgyOutput(
    JSON.stringify({
      conversation_id: CONVERSATION,
      status: "SUCCESS",
      response: "x",
      structured_output: { verdict: "approve" },
      json_schema: {},
      usage: {}
    })
  );
  assert.deepEqual(parsed.structuredOutput, { verdict: "approve" });
});

test("classifyOutcome reports failed for spawn errors, bad exits, and unparsable streams", () => {
  assert.equal(
    classifyOutcome({ exitCode: null, spawnError: "ENOENT", parsed: null }).state,
    "failed"
  );
  assert.equal(classifyOutcome({ exitCode: 1, parsed: { text: "boom" } }).state, "failed");
  assert.equal(classifyOutcome({ exitCode: 0, parsed: null }).state, "failed");
});

test("classifyOutcome reads agy's status before its exit code", () => {
  // Measured (agy 1.1.15): a run that answered at length and then tripped a
  // permission boundary reported status ERROR alongside a substantial response.
  const partial = classifyOutcome({ exitCode: 1, parsed: { text: "Here is what I found.", status: "ERROR" } });
  assert.equal(partial.state, "incomplete");
  assert.equal(partial.reason, "run-error-with-partial-output");

  // An ERROR with no text is a failure, not an empty success.
  const empty = classifyOutcome({ exitCode: 1, parsed: { text: "", status: "ERROR", errorText: "denied" } });
  assert.equal(empty.state, "failed");
  assert.equal(empty.reason, "run-error");
});

test("classifyOutcome marks empty answers incomplete instead of completed", () => {
  const result = classifyOutcome({ exitCode: 0, parsed: { text: "   \n  ", stopReason: "stop" } });
  assert.equal(result.state, "incomplete");
  assert.equal(result.reason, "empty-text");
  assert.equal(result.textChars, 0);
});

test("classifyOutcome downgrades known-bad stop reasons but only warns on unknown ones", () => {
  const answer = "x".repeat(DEFAULT_MIN_ANSWER_CHARS + 10);
  const toolCalls = classifyOutcome({
    exitCode: 0,
    parsed: { text: answer, stopReason: "tool-calls" }
  });
  assert.equal(toolCalls.state, "incomplete");
  assert.equal(toolCalls.reason, "stop-reason");
  assert.equal(toolCalls.stopReason, "tool-calls");

  assert.equal(classifyOutcome({ exitCode: 0, parsed: { text: answer, stopReason: "length" } }).state, "incomplete");

  // agy may add vocabulary; unknown values must never flip the verdict.
  const unknown = classifyOutcome({
    exitCode: 0,
    parsed: { text: answer, stopReason: "brand-new-reason" }
  });
  assert.equal(unknown.state, "completed");
  assert.equal(unknown.warnings.length, 1);
  assert.match(unknown.warnings[0], /brand-new-reason/);

  assert.equal(classifyOutcome({ exitCode: 0, parsed: { text: answer, stopReason: "end_turn" } }).state, "completed");
  assert.equal(classifyOutcome({ exitCode: 0, parsed: { text: answer, stopReason: null } }).warnings.length, 0);
});

test("classifyOutcome treats narration after tool calls as incomplete", () => {
  const narration = { text: "Parent contracts read. Now the source files.", stopReason: "stop" };
  const bigPrompt = 7107;

  const narrated = classifyOutcome({
    exitCode: 0,
    parsed: narration,
    toolEventCount: 4,
    promptChars: bigPrompt
  });
  assert.equal(narrated.state, "incomplete");
  assert.equal(narrated.reason, "narration");

  // Guardrails: the heuristic must not fire without tool calls, on small
  // prompts, or when a structured answer was produced.
  assert.equal(
    classifyOutcome({ exitCode: 0, parsed: { text: "ALLOW: no issues", stopReason: "stop" }, promptChars: bigPrompt }).state,
    "completed"
  );
  assert.equal(
    classifyOutcome({ exitCode: 0, parsed: narration, toolEventCount: 4, promptChars: 120 }).state,
    "completed"
  );
  assert.equal(
    classifyOutcome({
      exitCode: 0,
      parsed: { text: '{"verdict":"approve"}', stopReason: "stop" },
      toolEventCount: 4,
      promptChars: bigPrompt,
      hasStructuredOutput: true
    }).state,
    "completed"
  );
});

test("classifyOutcome honours AGY_COMPANION_MIN_ANSWER_CHARS", () => {
  const parsed = { text: "x".repeat(50), stopReason: "stop" };
  const args = { exitCode: 0, parsed, toolEventCount: 2, promptChars: 5000 };
  assert.equal(classifyOutcome({ ...args, minAnswerChars: 10 }).state, "completed");
  assert.equal(classifyOutcome({ ...args, env: { AGY_COMPANION_MIN_ANSWER_CHARS: "10" } }).state, "completed");
  assert.equal(classifyOutcome({ ...args, env: { AGY_COMPANION_MIN_ANSWER_CHARS: "400" } }).state, "incomplete");
});

test("extractStructuredJson handles bare, fenced, and prose-wrapped JSON", () => {
  assert.deepEqual(extractStructuredJson('{"verdict":"approve"}'), { verdict: "approve" });
  assert.deepEqual(extractStructuredJson('Here you go:\n```json\n{"verdict":"approve"}\n```'), {
    verdict: "approve"
  });
  assert.deepEqual(extractStructuredJson('prefix {"verdict":"approve"} suffix'), { verdict: "approve" });
  assert.equal(extractStructuredJson("no json here"), null);
  assert.equal(extractStructuredJson('["array","not","object"]'), null);
});
