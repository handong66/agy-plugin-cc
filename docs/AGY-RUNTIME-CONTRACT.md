# agy runtime contract — measured, not assumed

Every claim below was produced by running `agy` on this machine (macOS 26.6.2, arm64,
agy 1.1.15) and reading the output. Probe commands are given so each one can be re-run.
Nothing here is inferred from documentation.

## 1. Invocation

    agy -p "<prompt>" --add-dir "<repo-root>" --dangerously-skip-permissions --output-format json

Both flags are load-bearing. Dropping either one produces a broken run, for two
independent reasons documented below.

## 2. `--add-dir` is MANDATORY. agy does not use the process cwd.

This is the single most surprising fact about the runtime and the one most likely to be
assumed away.

Probe (default mode, no `--add-dir`, cwd was a git repo containing `calc.py`):

    agy -p 'read calc.py ... report the absolute path of your working directory' \
        --dangerously-skip-permissions --output-format json

Response:

    "The file calc.py does not exist in the current working directory."
    "### 3. Absolute Working Directory Path
     /Users/domo/.gemini/antigravity-cli"

The agent operated in `~/.gemini/antigravity-cli`, not in the shell's cwd, and it
*created a file there*. A run launched from a repo without `--add-dir` cannot see the
repo at all.

Probe (same prompt, `--add-dir "$PWD"` added):

    "return a - b   # BUG: subtracts"
    "### Workspace Directory Absolute Path
     /private/tmp/.../rotest"

Correct file, correct workspace. `--add-dir` is the only way to point agy at a repo.

Note a discrepancy worth remembering: the `stream-json` `init` event reports
`"cwd": "<the shell's cwd>"` even in runs where the agent's actual workspace is
`~/.gemini/antigravity-cli`. The `init.cwd` field is NOT a reliable statement of where
the agent will operate. Do not use it to verify workspace targeting.

## 3. Without `--dangerously-skip-permissions`, every tool call is auto-denied.

Probe:

    agy -p 'Run: cat a.txt and report the exact contents.' --output-format json

    {"status":"ERROR","response":"",
     "error":"permission check failed for command \"cat a.txt\": user denied permission
              to run command:\ncat a.txt", ...}

Headless mode has no interactive approver, so a permission prompt resolves to *denied*
and the run ends `ERROR` having done nothing.

This is not fixable by softer flags. Both were tested and both still auto-deny:

  - `--sandbox`     → same `permission check failed ... user denied permission`
  - `--mode plan`   → same

There is no allowlist to pre-approve commands. `~/.gemini/antigravity-cli/settings.json`
holds only `colorScheme` and `trustedWorkspaces`, and having the repo's ancestor in
`trustedWorkspaces` (it was: `/Users/domo`) does not grant tool permission.

Consequence: an agy run that is allowed to READ is, by the same flag, allowed to WRITE.
Read capability and write capability are not separable at the CLI. This drives the
isolation design in §6.

## 4. `--mode plan` is not a read-only reviewer. It is a plan generator.

It is tempting to map opencode's read-only `plan` *agent* onto agy's `--mode plan`.
That mapping is wrong on two counts.

Probe (`--mode plan --dangerously-skip-permissions`, asked to write two files and run `ls`):

    "- (1) Create plan-mode-wrote-this.txt: Refused / deferred pending user approval of the plan.
     - (2) Overwrite target.txt:            Refused / deferred pending user approval of the plan.
     - (3) Run ls -la .:                    Refused / deferred pending user approval of the plan."

Filesystem afterwards: no new file, `target.txt` unchanged, `git status --porcelain` empty.

So plan mode does block writes — but it blocks *reads and shell commands too*. It
executes nothing and instead writes a plan artifact to
`~/.gemini/antigravity-cli/brain/<conversation_id>/plan.md`, then waits for an approval
that never comes in headless mode.

Probe (`--mode plan`, pure read task, `calc.py` present in cwd):

    "I checked the current directory (/Users/domo/.gemini/antigravity-cli/scratch as well
     as the parent workspace), but the file calc.py does not exist"

Plan mode also resolves its workspace to `~/.gemini/antigravity-cli/scratch`.

Verdict: `--mode plan` cannot be used to implement a read-only review. A reviewer that
cannot read the diff is not a reviewer. Read-only must come from workspace isolation
instead — see §6.

## 5. Output shapes

`--output-format json` writes exactly one JSON object to stdout:

    {"conversation_id":"<uuid>",
     "status":"SUCCESS",
     "response":"<final assistant text>",
     "duration_seconds":2.898334,
     "num_turns":1,
     "usage":{"input_tokens":13741,"output_tokens":2,"thinking_tokens":0,
              "cache_read_tokens":0,"total_tokens":13743}}

On failure, `status` is `"ERROR"` and an `error` string is present:

    {"conversation_id":"...","status":"ERROR","response":"","error":"<message>", ...}

`status` and a non-empty `response` are independent. A run was observed with
`status:"ERROR"` *and* a substantial `response` — the agent answered, then tripped a
permission boundary on a follow-up tool call. Outcome classification must therefore
consider both fields, never `status` alone.

`--output-format stream-json` writes NDJSON:

    {"event":"init","conversation_id":"...","init":{"model":"gemini-3.7-flash-low","cwd":"...","tools":[...]}}
    {"event":"step_update","step_update":{"conversation_id":"...","step_index":0,"state":"DONE","step_type":"user_input"}}
    {"event":"step_update","step_update":{...,"step_type":"agent_response","text_delta":"OK\n","usage":{...}}}
    {"event":"result","result":{ <identical to the --output-format json object> }}

`step_type` values seen: `user_input`, `checkpoint`, `agent_response`.

The `init` event carries the resolved `model` id. The model behind an answer is
therefore OBSERVED, never inferred. The source plugin's config-scraping and
`modelCertainty` / `Model (expected)` machinery has no reason to exist here.

## 6. Read-only reviews: workspace isolation, not a mode flag

Given §3 (read implies write) and §4 (plan mode reads nothing), the only honest way to
offer a read-only review is to make writes land somewhere that does not matter:

run agy with `--add-dir <throwaway git worktree>` instead of the live repo.

`--add-dir` makes this nearly free, since pointing agy at a different directory is
already the normal way to target a workspace. The guarantee is a filesystem guarantee,
not a promise about model behaviour: the live working tree is never passed to agy, so
no amount of model misbehaviour can modify it.

What this does and does not guarantee:
  - Guarantees: the user's working tree and index are untouched.
  - Does not guarantee: agy cannot write outside any workspace at all. It already writes
    to `~/.gemini/antigravity-cli/` (conversations, brain artifacts) on every run, and
    `--dangerously-skip-permissions` is a blanket approval. Isolation protects the repo,
    not the whole filesystem. Documentation must say this plainly.

There is one boundary agy enforces on its own, observed incidentally: reading back a
file it had just written under `~/.gemini/antigravity-cli/` failed with
`Permission denied for read_file(...). Matches hardcoded system protection boundary rule.`
So some internal paths are protected regardless of the skip-permissions flag. This is
agy's own rule, not something to rely on.

## 7. `--json-schema` gives native structured output

    agy -p '<prompt>' --json-schema <path-or-json-string> --output-format json

The result object gains two fields:

    "structured_output": {"reason":"...","verdict":"pass"},
    "json_schema": { <the schema that was passed> }

`structured_output` is the parsed, schema-conforming object. This replaces the source
plugin's "find a JSON block in the final text, then hand-validate it" path as the
primary mechanism.

Two caveats measured on the same run:
  - The model ALSO emitted the JSON inline at the end of `response`, and padded the
    object with keys not in the schema (`toolAction`, `toolSummary`) in the prose copy,
    while `structured_output` itself was clean. Parse `structured_output`; do not scrape
    `response`.
  - Per `--help`, with `--output-format stream-json` the schema applies "only to the
    final result".

The text-scraping validator is still worth keeping as a fallback for runs where
`structured_output` is absent.

## 8. Flags and subcommands that matter

    --add-dir <dir>              repeatable; the ONLY way to set the workspace (§2)
    --dangerously-skip-permissions   required for any tool use at all (§3)
    --output-format text|json|stream-json
    --print-timeout <dur>        e.g. 150s; default 5m0s
    --model <id>                 see `agy models`
    --effort low|medium|high     the analogue of opencode's --variant
    --mode accept-edits|plan     default is neither (§4)
    --conversation <id>          resume a specific conversation
    -c / --continue              resume the most recent conversation
    --json-schema <path|json>    native structured output (§7)
    --disable-slash-commands     stop the prompt being reinterpreted as a slash command
    --agent <name>               `agy agents` returns EMPTY here; no named agents exist
    --project <id> / --new-project
    --log-file <path>
    --sandbox                    does NOT grant tool permission (§3)
    --input-format text|stream-json

`agy --version` prints a bare version string: `1.1.15`.

Models available from `agy models`:
    gemini-3.7-flash-{high,medium,low}
    gemini-3.6-flash-{high,medium,low}
    gemini-3.5-flash-{high,medium,low}
    gemini-3.1-pro-{high,low}
    claude-sonnet-4-6
    claude-opus-4-6-thinking
    gpt-oss-120b-medium

State lives in `~/.gemini/antigravity-cli/` (`conversations/`, `brain/`, `presence/`,
`settings.json`).

## 9. Measured wall time

This section is the single source of truth for every timing figure this project
publishes. `README.md`, `status --help` and `skills/agy-cli-runtime/SKILL.md` may
only cite numbers that appear here; `tests/docs.test.mjs` enforces that, so a
figure cannot be introduced in one layer and drift away from the others.

Every row was produced on this machine against agy 1.1.15/1.1.16, on
`gemini-3.7-flash-low`, in repositories of one or two files. Run-level figures
come from the run document's `duration_seconds`; job-level figures come from the
companion's own `elapsedMs`.

| What was run | Time |
|---|---|
| Invalid `--model`, rejected before any model turn | ~0.1s |
| `agy --version` alone | ~0.2s |
| Readiness probe: `agy --version` + `agy models` | ~3s, ~3s, ~4s (three runs) |
| Trivial prompt, no tools (`--output-format json`) | ~3s |
| Trivial prompt, no tools (`--output-format stream-json`) | ~2s |
| Tool call auto-denied for want of `--dangerously-skip-permissions` | ~3s, ~7s (two runs) |
| Single-file read with `--add-dir` | ~4s |
| `--conversation` resume, recalling a token from the previous turn | ~7s |
| Write-capable task, one-line acknowledgement | ~10s |
| `--mode plan`, refusing a read | ~10s |
| Read-only review of a one-file dirty working tree | ~12s |
| Read-only task attempting a fix (writes land in the discarded copy) | ~12s |
| Write-capable task fixing a bug in one file | ~14s, ~16s (two runs) |
| `--mode plan`, producing a plan artifact | ~17s |
| `--json-schema` run under `--mode plan` | ~26s |
| Multi-step run with no `--add-dir`, ending on a protected-path boundary | ~48s |

**These are floors, and a floor is not a budget.** Every row above is a toy
repository on the cheapest model. Nothing here says what a review of a few
hundred changed lines costs, and nothing here says what
`gemini-3.1-pro-high` or `claude-opus-4-6-thinking` cost — both of which should
be expected to be slower by a wide margin.

**There is no latency corpus for this runtime.** A corpus would be enough
recorded runs, across real repositories, diff sizes and model tiers, to compute a
median and a p90 from. The project this one was ported from published exactly
that (`median ~3 minutes, p90 near 5.5 minutes`, over 19 recorded runs) and those
figures were deleted rather than restated here, because they measured a different
CLI. No median or p90 is published for agy until one is measured.

What this means in practice, and why it is worth measuring later: two deadlines
in this plugin are currently reasoned guesses rather than observations — the
companion's own `--timeout-ms` default of 900000, and the `timeout: 600000` the
rescue templates put on Claude Code's Bash calls. Claude Code's own default is
120000, which is the number that actually truncates runs (`Exit code 143`). Until
the corpus exists the plugin errs long, because `--wait` returns the moment a job
is terminal: a deadline that is too long costs nothing, while one that is too
short destroys work that was going fine.

To build the corpus: run reviews across several real repositories at varying diff
sizes and model tiers, then read `status --all --json` and take the quantiles of
`elapsedMs`.
