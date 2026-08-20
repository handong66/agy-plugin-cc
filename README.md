# agy plugin for Claude Code

Use Google's [Antigravity CLI](https://antigravity.google) (`agy`) from inside Claude Code for code reviews or to delegate tasks — a port of the [opencode plugin for Claude Code](https://github.com/handong66/opencode-plugin-cc), which is itself a port of the official [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc).

This lets Claude Code hand work to Gemini 3.x, Claude Sonnet/Opus 4.6, or GPT-OSS — whichever model your Antigravity account can reach.

## What You Get

- `/agy:review` — a read-only agy code review of local git changes, a commit range, or a file set, with structured findings
- `/agy:adversarial-review` — a steerable challenge review that questions the design and its assumptions, bounded by a threat model you state
- `/agy:rescue` — delegate investigation, debugging, or a full implementation task to agy (write-capable by default, resumable)
- `/agy:transfer` — hand this Claude Code session off into a resumable agy conversation
- `/agy:status`, `/agy:result`, `/agy:cancel` — manage background jobs
- `/agy:setup` — readiness check, plus an optional stop-time review gate where agy reviews every Claude turn that edited code

## Requirements

- **Antigravity CLI** on your PATH (`agy --version` to check). Built and tested against 1.1.15.
- **A Google account signed in to agy.** Run `agy` once and complete the browser sign-in. Runs count against that account's usage.
- **Node.js 20 or later**
- **git** — read-only reviews are built from git's file list and will not run outside a repository.
- macOS 12+ or Linux. agy does not ship an x86 macOS build.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add handong66/agy-plugin-cc
```

or from a local checkout:

```bash
/plugin marketplace add /path/to/agy-plugin-cc
```

Install the plugin:

```bash
/plugin install agy@agy-plugin-cc
```

Reload plugins (`/reload-plugins`), then run:

```bash
/agy:setup
```

`/agy:setup` tells you whether agy is ready and which models the account can reach. If agy is missing:

```bash
brew install --cask antigravity-cli
```

## Usage

```bash
# Read-only review of uncommitted changes (structured verdict + findings)
/agy:review

# Review a commit range, or just part of one; trailing text steers the focus
# `--base <ref>` (and `--base <ref> --head <ref>`) diff from the merge base, i.e.
# `<base>...<head>` — the branch's own work, without changes it merely inherited.
# Write `--base A..B` when you want the literal two-dot range instead.
/agy:review --base main
/agy:review --base 71dcdc5..HEAD --paths docs,src check the migration order

# Challenge the design, with the system's actual exposure stated up front
/agy:adversarial-review --threat-model "single-user local tool, no network exposure" is the retry logic safe under concurrent writers?

# Delegate a task (write-capable by default)
/agy:rescue figure out why the login test is flaky and fix it

# Choose a model or reasoning effort explicitly
/agy:rescue --model claude-sonnet-4-6 --effort high refactor the cache layer

# Continue the previous agy conversation
/agy:rescue --resume apply the top fix

# Long jobs: Claude Code detaches them, the companion always runs in the foreground
/agy:rescue --background port the parser to TypeScript
/agy:status                 # every job, with elapsed time
/agy:status <id> --wait     # block until this one finishes
/agy:result <id>            # the stored output, verbatim
/agy:result <id> --json     # the same thing for a script
/agy:cancel <id>

# Hand this session off to agy (costs one agy model turn)
/agy:transfer
```

Models come from `agy models`; at the time of writing that is `gemini-3.7-flash-{high,medium,low}`, `gemini-3.6-flash-*`, `gemini-3.5-flash-*`, `gemini-3.1-pro-{high,low}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking` and `gpt-oss-120b-medium`. `/agy:setup` lists what your own account returns.

Every run prints its job id *before* agy starts, so a detached run can be polled while it is still going, and every finished run prints the agy conversation id and `agy --conversation <id>` to continue it inside agy.

**The model line reports what actually ran, or nothing.** agy has no user-facing model configuration — it resolves its own default server-side and names the model it used in each run's `init` event. So this plugin either observed the model or did not, and never prints a guess. `--json` carries `model`, `modelSource`, `modelCertainty` (`actual` or `unknown`) and `effort`.

Exit codes: `0` a real answer, `1` the run failed, `2` the run finished without producing one.

## What a read-only review actually guarantees

This is the part worth reading before you trust `/agy:review`.

**agy has no read-only mode.** Measured against agy 1.1.15: in headless mode, without `--dangerously-skip-permissions`, *every* tool call is auto-denied and the run ends `status: "ERROR"` having done nothing — not just writes, but reads and shell commands too. `--sandbox` does not change this. `--mode plan` does not either: it refuses reads and commands as well as writes, operates out of `~/.gemini/antigravity-cli/scratch` instead of your repository, and writes a plan artifact while waiting for an approval that never arrives in a headless run. A reviewer that can read your code can also write it, and no flag separates the two.

**So isolation is done by workspace.** agy ignores the process working directory entirely — without `--add-dir` it operates in `~/.gemini/antigravity-cli` and cannot see your repository at all. `--add-dir` is therefore the only thing that decides what a run can touch, and a read-only review uses it: the plugin builds a disposable copy of your working tree in the temporary directory, hands agy *that*, and never tells it your repository's path.

Concretely:

- **What is guaranteed:** the review cannot modify your working tree, your uncommitted changes, your index, or your branches. The copy contains no `.git` at all, so there are no shared refs, objects or hooks. This is an isolation guarantee, not a sandbox.
- **What is not:** agy runs with `--dangerously-skip-permissions`, so within your user account it can reach paths outside the copy. It also writes its own state under `~/.gemini/antigravity-cli` on every run regardless. Isolation protects your repository; it does not confine the process.
- **What the copy contains:** every tracked and untracked-but-not-ignored file, in its *working-tree* state — so your dirty changes are what gets reviewed, which is the usual point. Files staged as deleted are left out.
- **What the copy leaves out:** ignored files (`node_modules`, `.env`, build outputs), submodule contents, files that collide only by case on a case-insensitive filesystem, and symlinks pointing outside the tree — those last are dropped rather than reproduced, because a symlink copied verbatim would be a writable door back into the real repository. Everything left out is named in a `mirror_incomplete` warning. **The reviewer therefore cannot run your build or test suite.** Treat a verdict as static review of the diff plus whatever it could read.
- **What is checked afterwards:** your repository's `git status` and `HEAD` are fingerprinted before and after every read-only run. They must match, because agy was never told where your repository is. If they ever differ, a `tree_changed_during_readonly_run` warning fires — the isolation argument would be wrong and you should be told loudly rather than handed a clean verdict.
- **Path rewriting:** findings cite paths inside the copy, which is deleted when the run ends. Those are rewritten back to your repository's paths before rendering.

Write-capable runs (`/agy:rescue`) get your real repository and `--mode accept-edits`. That is the point of them; none of the above applies.

### Stop-time review gate

`/agy:setup --enable-review-gate` makes agy review every Claude turn that edited code before Claude is allowed to stop, blocking with concrete findings when something still needs fixing. It runs a full agy turn on every stop — enable it only while actively monitoring a session, and disable it with `/agy:setup --disable-review-gate`.

Three deliberate limits keep it from trapping you in a session you cannot leave:

- **It fails open.** Only an explicit `BLOCK:` verdict blocks, read from the review's own payload rather than from its exit status. If the review itself cannot complete, the stop is allowed and the reason is printed on stderr. Run `/agy:review --wait` by hand when you see that.
- **It stands down after two consecutive blocks** in one session and tells you to fix the findings or disable it.
- **It skips the review entirely** when the working tree is clean and HEAD has not moved since the last stop, instead of paying for a model turn to be told there is nothing to review.

## How it works

All commands go through one helper runtime, `plugins/agy/scripts/agy-companion.mjs`, which wraps headless `agy -p --output-format stream-json`:

- **Jobs**: every run is tracked in per-workspace state under this plugin's own data directory (`AGY_COMPANION_DATA_DIR`, never the shared `CLAUDE_PLUGIN_DATA`), so status/result/cancel work across foreground, background and Claude sessions. Writes are serialised and atomic; a record whose process is gone is relabelled instead of counting up forever; session-end hooks terminate still-running jobs.
- **Three outcomes, not two**: exiting 0 is not a verdict, and neither is exiting 1. agy reports its own `status`, and the two do not always agree in the direction the exit code suggests — a run that answered at length and then tripped a permission boundary reports `status: "ERROR"` alongside a substantial answer. That is `incomplete` with its partial output preserved, not a pass and not a bare failure.
- **Failures are classified from the run document.** agy leaves stderr empty on the failures that matter and puts the whole explanation in the document's `error` field — an unrecognised `--model` exits 1 with nothing on stderr at all. The classifier reads `error` and stderr, and never the model's own answer.
- **Structured reviews**: reviews pass their JSON schema to agy's `--json-schema` and read the validated object out of `structured_output`. Scraping a JSON block out of the final text is kept only as a fallback, because a model that also emits the object inline tends to pad the prose copy with keys the schema does not have.
- **Transfer**: agy cannot import Claude transcripts natively, so `transfer` distills the Claude session transcript into a handoff prompt and seeds a fresh agy conversation with it.

The measured agy behaviours this runtime is built on — with the probe commands that produced them — are written down in [`docs/AGY-RUNTIME-CONTRACT.md`](docs/AGY-RUNTIME-CONTRACT.md).

## Development

```bash
npm test
```

Tests use `node:test` and a fake `agy` fixture on PATH — no real model calls, no Google account needed. Changes to the runtime contract are recorded in [plugins/agy/CHANGELOG.md](plugins/agy/CHANGELOG.md).

## License

Apache-2.0. This project is a derivative work modeled on the [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc) (Copyright OpenAI, Apache-2.0) by way of the [opencode plugin for Claude Code](https://github.com/handong66/opencode-plugin-cc); see [NOTICE](NOTICE). Not affiliated with Google, OpenAI, or Anomaly Innovations.
