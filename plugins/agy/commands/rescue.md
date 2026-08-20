---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the agy rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <provider/model>] [--variant <level>] [what agy should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the raw user request as the prompt.
`agy:agy-rescue` is a subagent, not a skill — do not call `Skill(agy:agy-rescue)` (no such skill) or `Skill(agy:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be agy's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `agy:agy-rescue` subagent in the background.
- If the request includes `--wait`, run the `agy:agy-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--variant` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting agy, check for a resumable rescue session from this Claude session by running:

```bash
node "${AGY_COMPANION_BIN:-${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs}" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current agy session or start a new one.
- The two choices must be:
  - `Continue current agy session`
  - `Start a new agy session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current agy session (Recommended)` first.
- Otherwise put `Start a new agy session (Recommended)` first.
- If the user chooses continue, add `--resume-session <agyConversationId>` before routing to the subagent, using the exact `agyConversationId` the helper just reported (the same one you showed the user). Naming it removes the guesswork: `--resume` alone re-runs the selection heuristic, which can land on a different job than the one that was approved.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${AGY_COMPANION_BIN:-${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs}" task ...` and return that command's stdout as-is.
- Return the agy companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, call `/agy:cancel`, summarize output, or do work of its own. Independent work stays banned: it must never write its own answer, retry with a different prompt, or touch the repository.
- Retrieving its own result is not follow-up work, and it is the one exception. If the `Bash` call fails, is killed by a timeout, or was detached and so returned nothing, the subagent may fetch **the job it started and no other**, within the bounds `skills/agy-cli-runtime/SKILL.md` sets: at most one `status <id> --wait --timeout-ms <ms>` (or at most three plain `status <id>`) plus at most one `result <id>`. With still no output it returns the single line `AGY_RESCUE_FAILED: <reason> | job=<id> | log=<path>`. Silence is the one answer it may not give: 6 of 13 recorded dispatches returned nothing while their job had already completed.
- Leave `--variant` unset unless the user explicitly asks for a specific reasoning effort (agy calls this a model variant, e.g. `high`, `max`, `minimal`).
- Leave the model unset unless the user explicitly asks for one. Models are passed as `provider/model` exactly as `agy models` lists them.
- Leave `--resume`, `--resume-session <id>` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that agy is missing or has no usable providers, stop and tell the user to run `/agy:setup`.
- If the user did not supply a request, ask what agy should investigate or fix.
