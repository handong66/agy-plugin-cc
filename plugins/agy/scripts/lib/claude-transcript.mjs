import fs from "node:fs";

const MAX_HANDOFF_CHARS = 60_000;

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function isHarnessNoise(text) {
  return (
    text.startsWith("<system-reminder>") ||
    text.startsWith("<command-name>") ||
    text.startsWith("<local-command") ||
    text.startsWith("Caveat:")
  );
}

// Pulls the user/assistant conversation text out of a Claude Code session
// transcript (.jsonl), skipping tool traffic, sidechains, and harness noise.
export function extractClaudeMessages(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.isSidechain || entry.isMeta) {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") {
      continue;
    }
    const text = textFromContent(entry.message?.content).trim();
    if (!text || isHarnessNoise(text)) {
      continue;
    }
    messages.push({ role: entry.type, text });
  }
  return messages;
}

// Renders the newest messages that fit the budget, oldest-first, with a
// truncation marker when earlier conversation had to be dropped.
export function buildHandoffTranscript(messages, maxChars = MAX_HANDOFF_CHARS) {
  const kept = [];
  let used = 0;
  let truncated = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const label = message.role === "user" ? "User" : "Assistant";
    const block = `${label}:\n${message.text}`;
    if (used + block.length > maxChars && kept.length > 0) {
      truncated = true;
      break;
    }
    kept.unshift(block);
    used += block.length + 2;
  }
  const header = truncated ? "[Earlier conversation truncated.]\n\n" : "";
  return `${header}${kept.join("\n\n")}`;
}
