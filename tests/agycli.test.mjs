import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MIN_ANSWER_CHARS,
  buildAgyArgs,
  classifyOutcome,
  composePrompt,
  extractStructuredJson,
  parseEventStream,
  stripAnsi
} from "../plugins/agy/scripts/lib/agycli.mjs";

test("stripAnsi removes escape sequences but keeps bracketed text", () => {
  const esc = String.fromCharCode(27);
  assert.equal(stripAnsi(`${esc}[0mhello ${esc}[32m[tool] read${esc}[0m`), "hello [tool] read");
});

test("buildAgyArgs maps read-only runs to the plan agent", () => {
  const args = buildAgyArgs({ prompt: "task text", readOnly: true, autoApprove: true });
  assert.deepEqual(args.slice(0, 3), ["run", "--format", "json"]);
  assert.ok(args.includes("--agent"));
  assert.equal(args[args.indexOf("--agent") + 1], "plan");
  assert.ok(!args.includes("--auto"), "read-only must never auto-approve");
  assert.equal(args.at(-1), "task text");
  assert.equal(args.at(-2), "--", "prompt must be positional after --");
});

test("buildAgyArgs maps write runs to --auto with model/variant/session", () => {
  const args = buildAgyArgs({
    prompt: "-starts with dash",
    model: "anthropic/claude-sonnet-4-5",
    variant: "high",
    resumeSessionId: "ses_abc",
    autoApprove: true
  });
  assert.ok(args.includes("--auto"));
  assert.ok(!args.includes("--agent"));
  assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5");
  assert.equal(args[args.indexOf("--variant") + 1], "high");
  assert.equal(args[args.indexOf("--session") + 1], "ses_abc");
  assert.equal(args.at(-1), "-starts with dash");
});

test("composePrompt folds rules and schema into the prompt", () => {
  const prompt = composePrompt({ prompt: "review this", rules: "no side effects", jsonSchema: { type: "object" } });
  assert.match(prompt, /<system_rules>\nno side effects\n<\/system_rules>/);
  assert.match(prompt, /<output_schema>/);
  assert.match(prompt, /"type": "object"/);
  assert.ok(prompt.indexOf("no side effects") < prompt.indexOf("review this"));
});

test("parseEventStream extracts session, stop reason, and final text (real capture)", () => {
  // Events captured verbatim from `agy run --format json` v1.17.15.
  const stdout = [
    '{"type":"step_start","timestamp":1783782739399,"sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","part":{"id":"prt_f51bc8dc1001F7quBZjUh5NX1q","messageID":"msg_f51bc8394001T1sMV4MyES1bck","sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","type":"step-start"}}',
    '{"type":"text","timestamp":1783782740298,"sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","part":{"id":"prt_f51bc9125001NwZTcZQOnFqnPO","messageID":"msg_f51bc8394001T1sMV4MyES1bck","sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","type":"text","text":"OK","time":{"start":1783782740261,"end":1783782740280}}}',
    '{"type":"step_finish","timestamp":1783782740298,"sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","part":{"id":"prt_f51bc913d001waIh3fCLg7Sgpr","reason":"stop","messageID":"msg_f51bc8394001T1sMV4MyES1bck","sessionID":"ses_0ae437d23ffeJtaD6ceMAAJlCK","type":"step-finish","tokens":{"total":8100,"input":8087,"output":2,"reasoning":11,"cache":{"write":0,"read":0}},"cost":0}}'
  ].join("\n");
  const parsed = parseEventStream(stdout);
  assert.equal(parsed.text, "OK");
  assert.equal(parsed.sessionId, "ses_0ae437d23ffeJtaD6ceMAAJlCK");
  assert.equal(parsed.stopReason, "stop");
});

test("parseEventStream keeps the last payload per part and the newest message", () => {
  const line = (messageID, partId, text) =>
    JSON.stringify({ type: "text", sessionID: "ses_x", part: { id: partId, messageID, sessionID: "ses_x", type: "text", text } });
  const stdout = [
    line("msg_1", "prt_a", "old answer"),
    line("msg_2", "prt_b", "new"),
    line("msg_2", "prt_b", "new answer, streamed"),
    "not json",
    ""
  ].join("\n");
  const parsed = parseEventStream(stdout);
  assert.equal(parsed.text, "new answer, streamed");
});

test("parseEventStream returns null when no events are present", () => {
  assert.equal(parseEventStream(""), null);
  assert.equal(parseEventStream("plain text output"), null);
});

test("parseEventStream counts tool calls once per tool part", () => {
  const stdout = [
    JSON.stringify({ type: "step_start", sessionID: "ses_x", part: { id: "prt_s", messageID: "m1", type: "step-start" } }),
    JSON.stringify({ type: "tool", sessionID: "ses_x", part: { id: "prt_t1", messageID: "m1", tool: "read", state: { status: "running" } } }),
    JSON.stringify({ type: "tool", sessionID: "ses_x", part: { id: "prt_t1", messageID: "m1", tool: "read", state: { status: "completed" } } }),
    JSON.stringify({ type: "tool", sessionID: "ses_x", part: { id: "prt_t2", messageID: "m1", tool: "grep", state: { status: "completed" } } }),
    JSON.stringify({ type: "text", sessionID: "ses_x", part: { id: "prt_x1", messageID: "m1", type: "text", text: "reading" } })
  ].join("\n");
  assert.equal(parseEventStream(stdout).toolEventCount, 2);
  assert.equal(parseEventStream(JSON.stringify({ type: "step_start", part: { id: "p" } })).toolEventCount, 0);
});

test("classifyOutcome reports failed for spawn errors, bad exits, and unparsable streams", () => {
  assert.equal(
    classifyOutcome({ exitCode: null, spawnError: "ENOENT", parsed: null }).state,
    "failed"
  );
  assert.equal(classifyOutcome({ exitCode: 1, parsed: { text: "boom" } }).state, "failed");
  assert.equal(classifyOutcome({ exitCode: 0, parsed: null }).state, "failed");
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
