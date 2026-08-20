---
description: Check whether the local agy CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json $ARGUMENTS
```

Output rules:
- Present the final setup output to the user.
- If the result says the agy CLI is unavailable, tell the user to install agy so the `agy` binary is on PATH (`npm i -g antigravity-cli`, `brew install anomalyco/tap/agy`, or `curl -fsSL https://antigravity.google/install | bash` — see https://antigravity.google/docs for details), then rerun `/agy:setup`. Do not attempt to install it yourself.
- agy signs in with a Google account and has no per-provider credential list. If it cannot list models, preserve the guidance to run `agy` once in a terminal and complete the sign-in.
- Preserve the read-only paragraph verbatim. It is the only place the user is told that reviews run with `--dangerously-skip-permissions` inside a disposable copy — an isolation guarantee for the repository, not a sandbox for the process.
- If the user toggled the review gate, confirm its new state explicitly.
- When enabling the review gate, warn the user: the gate runs an agy review on every stop and can create a long-running Claude/agy loop that drains usage limits quickly. It should only stay enabled while they actively monitor the session.
- When enabling the review gate, also state its limits plainly, because they are deliberate trade-offs and not bugs:
  - It **fails open**. If the review itself cannot complete (it could not be started, the deadline passed, there is no document to parse, no output, or an answer in an unrecognised format), the stop is allowed and the reason is printed on stderr. Only an explicit `BLOCK:` verdict blocks — and that verdict is read from the review's payload, so a reviewer that inspected the repo before deciding still blocks even though such a run reports itself as incomplete. A gate whose failure mode is "the user cannot end the session" is worse than one that occasionally misses a review — run `/agy:review --wait` by hand when you see that message.
  - It **stands down after two consecutive blocks** in one session and says so, instead of holding the session hostage. Fix the findings or disable the gate with `/agy:setup --disable-review-gate`.
  - It **skips the review entirely** when the working tree is clean and HEAD has not moved since the previous stop.
