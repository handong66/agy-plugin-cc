import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { extractClaudeMessages, buildHandoffTranscript } from "../plugins/agy/scripts/lib/claude-transcript.mjs";
import { makeTempDir } from "./helpers.mjs";

function writeTranscript(entries) {
  const file = path.join(makeTempDir("agy-transcript"), "session.jsonl");
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return file;
}

test("extractClaudeMessages keeps conversation text and drops tool/harness noise", () => {
  const file = writeTranscript([
    { type: "user", message: { content: "fix the login bug" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Looking now." }, { type: "tool_use", name: "Bash" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "..." }] } },
    { type: "user", isMeta: true, message: { content: "meta noise" } },
    { type: "assistant", isSidechain: true, message: { content: "sidechain noise" } },
    { type: "user", message: { content: "<system-reminder>injected</system-reminder>" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Fixed it." }] } }
  ]);
  const messages = extractClaudeMessages(file);
  assert.deepEqual(
    messages,
    [
      { role: "user", text: "fix the login bug" },
      { role: "assistant", text: "Looking now." },
      { role: "assistant", text: "Fixed it." }
    ]
  );
});

test("buildHandoffTranscript keeps the newest messages within budget", () => {
  const messages = [
    { role: "user", text: "a".repeat(50) },
    { role: "assistant", text: "b".repeat(50) },
    { role: "user", text: "final question" }
  ];
  const transcript = buildHandoffTranscript(messages, 80);
  assert.match(transcript, /^\[Earlier conversation truncated\.\]/);
  assert.match(transcript, /final question/);
  assert.ok(!transcript.includes("a".repeat(50)));

  const untruncated = buildHandoffTranscript(messages, 10_000);
  assert.ok(!untruncated.includes("truncated"));
  assert.ok(untruncated.indexOf("User:") < untruncated.indexOf("final question"));
});
