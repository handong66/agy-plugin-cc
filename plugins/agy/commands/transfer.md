---
description: Hand off the current Claude Code session into a resumable agy session
argument-hint: "[--source <claude-jsonl>] [--model <model-id>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the agy conversation ID and the `agy --conversation <conversation-id>` command.

Note for the user if they ask how it works: agy cannot import Claude transcripts natively, so the transfer distills this session's conversation into a handoff prompt and seeds a fresh agy session with it. That costs one agy model turn.
