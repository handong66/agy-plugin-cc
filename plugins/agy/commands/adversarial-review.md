---
description: Run an agy review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref|A..B>] [--base <ref> --head <ref>] [--paths <globs>] [--scope auto|working-tree|branch] [--threat-model "<boundary>"] [--rubric-file <path>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial agy review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return agy's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.
- `--threat-model "<boundary>"` states what the system is actually exposed to (for example `single-user local application, no network exposure`). Preserve it for the forwarded companion call. Without it the reviewer assumes a single-user local application. Findings outside the stated boundary come back labelled `out-of-model` in the finding body: they are advisory, the reviewer is instructed not to let one produce `needs-attention`, and you must never let one interrupt work the user already has in flight. The label is the reviewer's own, in prose — nothing in the runtime checks it or overrides the verdict — so if the verdict and the labels disagree, read the findings and say so rather than trusting the verdict line.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly, except for the two execution flags.
- `--wait` and `--background` are Claude Code execution flags. Use them to pick the flow above, then remove them from the string you pass to the companion; call what is left `COMPANION_ARGS`.
- The companion always runs in the foreground and now **rejects** `--background` with a non-zero exit, so forwarding it fails the run outright. Claude Code's `Bash(..., run_in_background: true)` is what actually detaches it.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- `/agy:adversarial-review` uses the same review target selection as `/agy:review`.
- It supports working-tree review, branch review, and `--base <ref>`; `--head <ref>` moves the other end of the range and needs `--base` alongside it. `--base X --head Y` diffs `X...Y` (from the merge base); write `--base X..Y` for the literal two-dot range.
- `--threat-model "<boundary>"` is accepted here only. Plain `/agy:review` rejects it, because only this prompt has a slot for it.
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `/agy:review`, it can still take extra focus text after the flags.

Foreground flow:
- Run with a generous timeout (reviews can take several minutes):
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review "COMPANION_ARGS"`,
  description: "agy adversarial review",
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
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review "COMPANION_ARGS"`,
  description: "agy adversarial review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "agy adversarial review started in the background. Check `/agy:status` for progress."
