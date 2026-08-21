---
name: agy-cli-runtime
description: Internal helper contract for calling the agy-companion runtime from Claude Code
user-invocable: false
---

# agy Runtime

Use this skill only inside the `agy:agy-rescue` subagent.

Primary helper:
- `node "${AGY_COMPANION_BIN:-${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs}" task [flags] -- <prompt>`
- or, for any prompt containing quotes, backticks, angle brackets, pipes or newlines: `task [flags] --prompt-file <path>`

Prompt form rules:
- Everything after `--` is passed to agy byte for byte. Everything *before* it is tokenized, which drops quote characters, swallows text after an apostrophe, and folds newlines into spaces.
- Never put the prompt before `--`. That older form silently corrupted multi-line and quoted review contracts.
- When the prompt contains characters the shell also interprets (`"`, `'`, `` ` ``, `<`, `>`, `|`, `*`, `[`, `]`), write it to a file first and pass `--prompt-file <path>`. That is the only form that survives both the shell and the companion. `--prompt-stdin` is the equivalent for piped input.

Invocation template (always set the Bash timeout explicitly):

```
Bash({
  command: 'node "${AGY_COMPANION_BIN:-${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs}" task --write -- <prompt>',
  timeout: 600000,
  description: "Delegate the rescue request to agy"
})
```

For a long or open-ended rescue, detach instead of waiting:

```
Bash({
  command: 'node "${AGY_COMPANION_BIN:-${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs}" task --write --prompt-file /path/to/prompt.md',
  run_in_background: true,
  description: "Delegate the rescue request to agy in the background"
})
```

Entry point rules:
- Always reach the companion through `${AGY_COMPANION_BIN:-${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs}`. `AGY_COMPANION_BIN` is exported by this plugin's SessionStart hook and points at the copy that is actually installed; `${CLAUDE_PLUGIN_ROOT}` is the fallback when the session env file was not sourced.
- Never write a versioned absolute cache path (`~/.claude/plugins/.../agy/0.1.0/scripts/...`), never guess a path, and never `find | head -1` for one. A caller that did all three ran a stale copy of this plugin for 3.5 hours, and its job state went to another plugin's directory the whole time.
- `/agy:setup --json` reports `pluginVersion` and `companionPath` if you need to confirm which copy answered.

Timeout rules:
- agy runs can take longer than two minutes, so the Claude Code default of 120000 ms cuts them off mid-run with `Exit code 143`. The measured floors on this runtime are small — a read-only review in ~12s, a write-capable fix in ~14s, both on `gemini-3.7-flash-low` in a one-file repository — but they are floors from toy repositories, not a budget for real work, and no pro-tier model has been timed. Leave a generous deadline: it costs nothing when the run is quick, because `--wait` returns the moment the job is terminal. The full table is in `docs/AGY-RUNTIME-CONTRACT.md` section 9; do not cite a figure that is not in it.
- Always pass `timeout: 600000` on a foreground `task` call. Never rely on the default.
- `timeout` and `run_in_background` are Claude Code `Bash` parameters. They are never companion flags and must not appear in the companion command line.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct agy CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, or `cancel` from `agy:agy-rescue`. `status` and `result` are allowed only under the recovery rules below, and only for the job this subagent just submitted.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `agy-prompting` skill to rewrite the user's request into a tighter agy prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--variant` unset unless the user explicitly requests a specific reasoning effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one, as `provider/model` exactly as `agy models` lists it.
- Default to a write-capable agy run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass the `provider/model` value through to `task`.
- If the forwarded request includes `--effort` (or the legacy `--variant`), pass it through to `task` (it maps to agy's `--effort low|medium|high`).
- If the forwarded request includes `--resume-session <ses_id>`, strip both tokens from the task text and pass `--resume-session <ses_id>` to `task` unchanged. This continues exactly that session; use it in preference to `--resume-last` whenever an id is given.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`. `--resume-last` continues the newest resumable *task* session in this repository — completed, incomplete or failed, never a cancelled or orphaned one — and the companion prints which one it picked.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable agy work in `agy:agy-rescue` unless the user explicitly asks for read-only behavior.
- Write-capable runs are given the real repository with `--mode accept-edits --dangerously-skip-permissions`; the user opted into delegation by invoking rescue.
- Read-only runs are NOT given the repository at all. They get a disposable copy of the working tree, because agy has no read-only permission mode — a run that can read the code can also write it, so isolation is done by choosing which directory agy is handed. Any edit such a run makes is discarded with the copy and reported as a `readonly_run_wrote_files` warning: never relay such a run's "I fixed it" as though a file changed.
- Read-only runs use agy's built-in `plan` agent, which cannot edit files.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.

Failure and recovery — the only follow-up work this subagent may do:
- Never write your own answer, never analyse the problem yourself, never retry with a different prompt, and never change the repository. Those bans are absolute and are not relaxed by any failure.
- Keep the job handle. The first line of `task` stdout is `Job: <id> (task, running) — poll with /agy:status <id>` (with `--json` it is a JSON line on stderr), printed before the run starts, so it exists even when the run is later killed.
- If the `Bash` call fails, is killed by a timeout, or was detached and therefore returned no answer, you may retrieve the result of **that job id and no other**: at most one `status <id> --wait --timeout-ms <ms>`, or at most three plain `status <id>` calls, plus at most one `result <id>`. Return that stdout verbatim.
- If there is still no agy output, return exactly one line and nothing else:
  `AGY_RESCUE_FAILED: <reason> | job=<id or unknown> | log=<log path or unknown>`
- Never return an empty response. Silence is indistinguishable from a silent success, and it throws away the handle the caller needs to recover the run — 6 of 13 recorded rescue dispatches came back with no agy answer at all while the job itself had completed.
