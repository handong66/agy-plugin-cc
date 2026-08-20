---
description: Run an agy code review against local git state
argument-hint: '[--wait|--background] [--base <ref|A..B>] [--base <ref> --head <ref>] [--paths <globs>] [--scope auto|working-tree|branch] [--rubric-file <path>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an agy review through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return agy's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly, except for the two execution flags.
- `--wait` and `--background` are Claude Code execution flags. Use them to pick the flow above, then remove them from the string you pass to the companion; call what is left `COMPANION_ARGS`.
- The companion always runs in the foreground and now **rejects** `--background` with a non-zero exit, so forwarding it fails the run outright. Claude Code's `Bash(..., run_in_background: true)` is what actually detaches it.
- Do not add extra review instructions or rewrite the user's intent.
- Target selection: `--base <ref>` reviews `<ref>...HEAD`; `--base A..B` and `--base A...B` are accepted as written; `--head <ref>` moves the other end and therefore needs `--base` as well (on its own it is rejected, not quietly turned into a working-tree review); `--paths <glob,...>` (alias `--files`) limits the review to those pathspecs. Preserve whichever the user gave.
- `--base X --head Y` diffs `X...Y` — from the merge base, so the review sees what `Y` added rather than everything `X` gained meanwhile. That is what a branch review wants; a caller who means the literal two-dot range writes `--base X..Y`.
- Free text is now a focus instruction for the reviewer, not an error. Pass it through unchanged.
- `--rubric-file <path>` supplies the user's own severity vocabulary (blocker/major/nit, P0/P1, …). The JSON output shape does not change; the reviewer maps their terms onto it.
- `/agy:review` still does not support staged-only or unstaged-only review; `--scope` accepts only `auto`, `working-tree` and `branch`, and anything else is rejected with the list.
- If the user wants the change challenged rather than checked, `/agy:adversarial-review` is the stronger framing (and it takes `--threat-model`).
- If the helper prints a `review_input_truncated` warning, relay it: the reviewer did not see the whole diff, so "no findings" covers only the part it read.

Foreground flow:
- Run with a generous timeout (reviews can take several minutes):
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review "COMPANION_ARGS"`,
  description: "agy review",
  timeout: 600000
})
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review "COMPANION_ARGS"`,
  description: "agy review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "agy review started in the background. Check `/agy:status` for progress."
