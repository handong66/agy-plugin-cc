# Changelog

All notable changes to the agy companion runtime's contract are recorded here.

## 0.1.0 — 2026-08-19

First release. A port of the [opencode plugin for Claude
Code](https://github.com/handong66/opencode-plugin-cc) to Google's Antigravity
CLI (`agy`), keeping that project's command surface, three-outcome run
classification and per-workspace job store, and replacing everything that
touched the opencode CLI.

The runtime differences below are not stylistic: each one was measured against
agy 1.1.15 before it was written, and the captures are in
`docs/AGY-RUNTIME-CONTRACT.md`.

- **Read-only reviews are isolated by workspace, not by a mode flag.** agy has
  no read-only permission mode. Measured: without
  `--dangerously-skip-permissions` every tool call in a headless run is
  auto-denied and the run ends `status: "ERROR"` having done nothing, and
  neither `--sandbox` nor `--mode plan` changes that. So a run that can read the
  code can also write it. What *does* decide what a run can touch is `--add-dir`,
  because agy ignores the process working directory entirely. `review`,
  `adversarial-review` and read-only `task` runs are therefore given a throwaway
  copy of the working tree, built from git's own file list, and are never told
  the real repository's path. The guarantee is a filesystem guarantee rather than
  a promise about model behaviour. Symlinks that point outside the tree are
  dropped instead of copied — reproduced verbatim they would be a writable door
  back into the real repository — and files that collide only by case are
  reported rather than silently collapsed onto one another by a case-insensitive
  filesystem. Every file left out is named in a `mirror_incomplete` warning, so a
  review says what it could not see instead of reviewing less than it claims to.
- **`--mode plan` is deliberately unused.** It looks like the natural analogue of
  opencode's read-only `plan` agent and is not one. Measured: in plan mode agy
  refuses reads and shell commands as well as writes, resolves its workspace to
  `~/.gemini/antigravity-cli/scratch` rather than the repository, and writes a
  plan artifact while waiting for an approval that never arrives in a headless
  run. A reviewer that reads nothing is not a reviewer.
- **The real repository's path is not handed to a read-only run at all.** agy
  echoes the spawning process's working directory in its `init` event even when
  its agent operates somewhere else, so read-only runs are spawned from the
  mirror. The real tree's `git status` and `HEAD` are fingerprinted before and
  after every read-only run; they must match, and a `tree_changed_during_readonly_run`
  warning fires loudly if they ever do not.
- **The model is observed, never predicted.** agy has no user-facing model
  configuration and reports the model it used in each run's `init` event. The
  opencode runtime's config scraping, its `agent.plan.model` resolution and the
  `Model (expected)` / `modelCertainty: "expected"` machinery are all gone. A run
  either reports the model that answered or reports none; `setup` lists the
  models the account can reach rather than guessing a default.
- **Structured review output comes from agy, not from scraping prose.** Reviews
  pass their JSON schema to `--json-schema` and read the validated object out of
  the run document's `structured_output` field. The old path — find a JSON block
  in the final text, then hand-validate it — is kept only as a fallback for runs
  that return no structured output, because a model that emits the object inline
  as well tends to pad the prose copy with keys the schema does not have.
- **A run's verdict is read from its status, not from its exit code.** Measured:
  a run that answered at length and then tripped a permission boundary reported
  `status: "ERROR"` alongside a substantial `response`. That is `incomplete` with
  its partial answer preserved, not a clean pass and not a bare failure. An
  `ERROR` with no text is a failure.
- **Failures are classified from the run document, not from stderr.** Measured:
  an unrecognised `--model` exits 1 with an *empty* stderr and the entire
  explanation inside the document's `error` field. The opencode runtime read only
  stderr, which for agy would have classified every real failure as "no
  recognised reason". The classifier now reads `error` and stderr, and never the
  model's own answer.
- **`permission_auto_denied` is a first-class warning.** It is the single most
  likely failure of a misconfigured run and it is silent in the sense that agy
  still returns a well-formed document — the emptiness is in `response`.
- **Sessions are conversations.** Resume is `--conversation <id>`;
  `agy --continue` continues the most recent one. Job records and `--json`
  documents carry `agyConversationId`.
- **Flag validation is inherited and kept.** `--threat-model` is refused by plain `review` rather than accepted and dropped — only the adversarial prompt has a slot for it — an unknown flag before the free text fails the command instead of landing in the prompt, and `--scope` is validated against `auto|working-tree|branch`.
- **`--variant` is `--effort`** (`low` | `medium` | `high`), agy's own name for
  the dial, and `--variant` is kept as an alias.
