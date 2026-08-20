---
name: agy-prompting
description: Internal guidance for composing agy prompts for coding, review, diagnosis, and research tasks inside the agy Claude Code plugin
user-invocable: false
---

# agy Prompting

Use this skill when `agy:agy-rescue` needs to ask agy for help.

agy fronts several model families (Gemini 3.x, Claude Sonnet/Opus 4.6, GPT-OSS) and resolves its own default, so write prompts that work without relying on model-specific quirks. Prompt like an operator, not a collaborator. Keep prompts compact and block-structured with XML tags. State the task, the output contract, the follow-through defaults, and the small set of extra constraints that matter.

Core rules:
- **Never reference an absolute path outside the repository root in an agy prompt.** agy auto-rejects reads outside its working directory (it prints `! permission requested: external_directory (<path>); auto-rejecting` on stderr and still exits 0), while Claude Code stages large prompts and material under `/private/tmp/claude-<uid>/<project>/<session>/scratchpad` by default (the `501` in that path is the author's own macOS user id, not a constant). A prompt that points at such a path produces a run that reads nothing and answers with narration. Either inline the material in the prompt, or copy the file into the repository (or worktree) first and reference it by repository-relative path.
- Prefer one clear task per agy run. Split unrelated asks into separate runs.
- Tell agy what done looks like. Do not assume it will infer the desired end state.
- Explicit, literal instructions travel well across models; vague nudges get vague behavior. Spell out constraints instead of hinting at them.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.
- Prefer better prompt contracts over raising the model variant or adding long natural-language explanations.
- Use XML tags consistently so the prompt has stable internal structure.

Default prompt recipe:
- `<task>`: the concrete job and the relevant repository or failure context.
- `<structured_output_contract>` or `<compact_output_contract>`: exact shape, ordering, and brevity requirements.
- `<default_follow_through_policy>`: what agy should do by default instead of asking routine questions. This matters in headless runs: there is no user to answer questions, so tell it to proceed on reasonable assumptions and record them.
- `<verification_loop>` or `<completeness_contract>`: required for debugging, implementation, or risky fixes. Tell agy to run the relevant tests or commands and report actual output, not intentions.
- `<grounding_rules>` or `<citation_rules>`: required for review, research, or anything that could drift into unsupported claims.

When to add blocks:
- Coding or debugging: add a completeness contract, a verification loop, and a rule for how to proceed when context is missing.
- Review or adversarial review: add grounding rules and a structured output contract. The plugin's built-in `review` and `adversarial-review` commands already carry these; use them instead of hand-rolling review prompts.
- Research or recommendation tasks: add citation rules and require agy to separate observed facts from inferences.
- Write-capable tasks: add an action-safety block so agy stays narrow, avoids unrelated refactors, and lists every file it touched.

How to choose prompt shape:
- Use the built-in `review` or `adversarial-review` companion commands when the job is reviewing local git changes. Those prompts already carry the review contract.
- Use `task` when the job is diagnosis, planning, research, or implementation and you need to control the prompt more directly.
- Use `task --resume-last` for follow-up instructions on the same agy session. Send only the delta instruction instead of restating the whole prompt unless the direction changed materially.

Working rules:
- Prefer explicit prompt contracts over vague nudges.
- Keep the forwarded prompt faithful to the user's request; tighten wording and structure, never scope.
- Do not raise the model variant or switch models first. Tighten the prompt and verification rules before escalating.
- Ask agy for brief, outcome-based progress updates only when the task is long-running or tool-heavy.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.

Prompt assembly checklist:
1. Define the exact task and scope in `<task>`.
2. Choose the smallest output contract that still makes the answer easy to use.
3. Decide whether agy should keep going by default or stop for missing high-risk details.
4. Add verification, grounding, and safety tags only where the task needs them.
5. Remove redundant instructions before sending the prompt.
