---
name: agy-result-handling
description: Internal guidance for presenting agy helper output back to the user
user-invocable: false
---

# agy Result Handling

When the helper returns agy output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If agy marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If agy made edits, say so explicitly and list the touched files when the helper provides them.
- Preserve the agy session ID and the `agy -s <session-id>` command so the user can continue the session inside agy.
- For `agy:agy-rescue`, do not turn a failed or incomplete agy run into a Claude-side implementation attempt. Report the failure and stop.
- For `agy:agy-rescue`, if agy was never successfully invoked, do not generate a substitute answer at all.
- A single line of the form `AGY_RESCUE_FAILED: <reason> | job=<id> | log=<path>` means the rescue subagent got no agy answer. Report the reason and the job id to the user as-is; do not answer in agy's place. If the id is real, `/agy:status <id>` and `/agy:result <id>` may still hold the run's output.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed agy run, relay its `Next step (<failureClass>)` line and the stderr tail it printed, then stop instead of guessing.

Failure classes (`failureClass` on the job record and in `--json`; also rendered as `failed (<class>)`):
- `model_unauthorized` — the account may not use that model. Not retryable as-is: pick a granted model or drop `--model`.
- `model_not_found` — unknown model id, usually provider-prefix casing. agy's own `Did you mean:` hint is in the stderr tail.
- `quota_exhausted` — provider balance or quota is gone. **Not** a plugin or prompt problem and **not** retryable; say so and let the user re-route to another provider rather than re-running.
- `auth_required` — no usable credentials. Send the user to `/agy:setup` and `!agy auth login`; never improvise an alternate auth flow.
- `rate_limited` — 429 / rate limit / provider overloaded. Transient, and the class most worth retrying: wait and re-run the same request unchanged rather than rewording it or switching model.
- `provider_error` — server-side error. Worth one retry; if it repeats, switch provider.
- `agy_failed` — nothing recognisable. Report the stderr tail as-is.
- `timeout` / `interrupted` / `orphaned` are the companion's own labels (deadline hit, companion killed, process gone), not provider verdicts.
- A class is a reading aid derived from the run's **stderr** — never from agy's own answer. It never changes whether the run passed or failed, so never present it as more certain than the stderr it came from.

Evidence behind a review verdict:
- `review` / `adversarial-review` report `evidenceLevel` (`none` | `thin` | `substantive`) next to the verdict and in `--json`. It is derived from how many tool calls the run made.
- `evidenceLevel: none` means the reviewer looked at nothing beyond the diff that was inlined into its prompt. Present such a verdict as what it is: an opinion on the diff text. An `approve` with no evidence is **no signal** — do not count it as a passing vote, and never report it to the user as "agy approved the change" without that qualification.
- The helper prints a `no_evidence_review` warning in that case. Pass it on rather than dropping it.
- The same judgement is machine-readable as `resultComplete` in `--json` and in the stored payload: it is `false` for a zero-evidence review and for any run that did not finish, `true` only when the run completed *and* the verdict has evidence behind it. Key off that field rather than re-deriving it; `outputState` still describes the run itself, so a zero-evidence review is `outputState: "completed"` with `resultComplete: false`.

Feeding output to a script:
- Use `/agy:result <id> --json` (whole payload) or `--structured-only` (just the review JSON object; exits 1 with the reason when the run produced none, and when the run is `incomplete` — an unfinished run has no verdict even if the JSON it emitted validates). Both are exact.
- Never slice the rendered text with `head -c` / `tail -c`. It breaks multi-byte characters and any JSON inside the payload — two recorded corruptions came from doing that while `--json` was available.
- There is no output cap and no truncation flag, deliberately. This helper's contract is that its output is relayed verbatim; adding a lossy limit would contradict it. If the output is too large for a caller, narrow the channel (`--json`, `--structured-only`, a specific field), not the content.
- With `--json`, stdout is one JSON document and nothing else whenever the command got as far as addressing a run — including a run that failed (exit 1) and one that produced no answer (exit 2), and including a review target with nothing in it (exit 0). Everything a run says on the way — the job handle, which session `--resume-last` picked, the notice that there was none — goes to stderr.
- The exception is a request rejected *before* that point: unparseable flags (`--timeout-ms` with no value), a review target that cannot be resolved (`--scope staged`, `--base nosuchref`), an unknown job id, `task` with no prompt. Those print a plain-text error on stdout and exit 1. So stdout that does not parse means "the request was wrong", never "the run answered oddly" — report the text rather than retrying.
- A review whose target has no changes returns `outputState: "empty"` (`isEmpty: true`, `outputStateReason: "nothing-to-review"`, `review: null`, exit code 0). It is not a verdict and not a failure: report that there was nothing to review rather than presenting it as an approval, and do not re-run it hoping for a different answer.

Threat-model labels on adversarial reviews:
- `/agy:adversarial-review --threat-model "<boundary>"` states what the system is exposed to. Without it the reviewer assumes a single-user local application with no network exposure.
- Findings the reviewer labels `out-of-model` are **advisory**. Never present them as blocking, never let one halt work that is already in progress (a test run, a verification pass, a deploy), and never turn one into a `needs-attention` verdict on your own.
- That rule lives in the prompt, not in the runtime: the label is prose inside the finding body, the output schema has no field for it, and the helper never rewrites a verdict. So a `needs-attention` whose only findings are out-of-model is possible — when you see one, report the mismatch instead of relaying the verdict.
- If an out-of-model finding looks genuinely important, mention it once, after the in-model findings, and let the user decide.

Job handles:
- The first line of `task`/`review` stdout is the handle, printed before agy starts: `Job: <id> (<kind>, running) — poll with /agy:status <id>`. With `--json` the same handle is a JSON line on stderr (`{"jobId":…,"logFile":…,"pollWith":…}`) so stdout stays one JSON document.
- Keep that id. It is the only handle for a run that was detached with `Bash(run_in_background: true)`, and it works while the run is still in flight: `status <id> --wait --timeout-ms <ms>` blocks until the job reaches a terminal state and `result <id> --wait` does the same and then prints the output. Never hand-roll a polling loop over the log file.

Waiting on a job (which call to use, and what its fields mean):
- `status <id> --wait --timeout-ms <ms>` blocks until the job reaches a terminal state, including a job whose process died, and returns the moment it does. Prefer it to a `sleep`/poll loop, which cannot return early and cannot see a dead job.
- `status --all --json` reports every job's `elapsedMs` and `resultComplete` in one call, so a barrier over several jobs does not need one call per job.
- `resultComplete: false` on a finished job means "do not count this as an answer" (no final output, or a review with no evidence). Treat it as a missing seat, not as a vote.
- How long to wait, and how to schedule around it, is not a contract fact and is not decided here: `status --help` and the plugin README carry the measured wall times to budget against.

Incomplete runs (`outputState: incomplete`, job status `incomplete`, exit code 2):
- The helper prints `agy stopped before producing a final answer (...)` when agy exited cleanly without an answer: no text at all, a stop reason that is not a finished turn (for example `tool-calls`), or one line of narration after a batch of tool calls.
- Do NOT present the partial text as agy's answer, and do NOT summarize it as if it were one. It is work-in-progress.
- Do NOT substitute your own answer for the missing one. Say that agy did not produce a final answer, show the partial output as partial, and pass on the reason (`stopReason`) and the stderr lines the helper printed.
- Offer the recovery command the helper prints (`/agy:rescue --resume ...`) so the same agy session can be asked for the final answer only.
- Exit code 2 means incomplete, exit code 1 means the run failed; never read either as success.
- If the helper reports that setup or authentication is required, direct the user to `/agy:setup` and do not improvise alternate auth flows.
