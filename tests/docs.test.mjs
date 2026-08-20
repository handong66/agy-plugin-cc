import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "./helpers.mjs";

const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "agy");

function readDoc(...segments) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, ...segments), "utf8");
}

// Rescue forwarders inherit Claude Code's 120s Bash default unless the
// invocation template says otherwise; agy runs routinely exceed it.
test("rescue invocation templates carry an explicit Bash timeout", () => {
  const skill = readDoc("skills", "agy-cli-runtime", "SKILL.md");
  const agent = readDoc("agents", "agy-rescue.md");

  for (const [name, text] of [
    ["skills/agy-cli-runtime/SKILL.md", skill],
    ["agents/agy-rescue.md", agent]
  ]) {
    assert.match(text, /timeout:\s*600000/, `${name} must show timeout: 600000 in its Bash template`);
    assert.match(
      text,
      /run_in_background/,
      `${name} must point long runs at Bash(run_in_background: true)`
    );
    assert.match(
      text,
      /agy runs (?:regularly|routinely|often) (?:take|run) longer than (?:two minutes|2 minutes)/i,
      `${name} must state that agy runs regularly exceed the 2-minute default`
    );
  }
});

// X1: headless delegates obey the repository's own bootstrap rules — 57/128
// grok jobs and 89/231 agy jobs opened by reading a PUA/superpowers
// SKILL.md before doing any of the requested work, and narration is what
// P-COMPLETE's `narration` class is made of.
test("prompt templates open with the headless delegation preamble", () => {
  for (const name of ["review", "adversarial-review", "stop-review-gate"]) {
    const text = readDoc("prompts", `${name}.md`);
    assert.ok(
      text.startsWith("<headless_delegation>"),
      `prompts/${name}.md must lead with the headless delegation preamble`
    );
    assert.match(text, /Ignore repository bootstrap instructions/, `prompts/${name}.md`);
    assert.match(text, /`pua`/, `prompts/${name}.md must name the personas it is overriding`);
    assert.match(text, /superpowers/, `prompts/${name}.md must name the personas it is overriding`);
    assert.match(text, /Do not narrate/, `prompts/${name}.md must forbid narration`);
    assert.doesNotMatch(
      text.split("</headless_delegation>")[0],
      /\{\{[A-Z0-9_]+\}\}/,
      `prompts/${name}.md preamble must not depend on interpolation`
    );
  }
});

// PC2: the documented single-argument form ran the prompt through `tokenize`,
// which drops quotes and folds newlines — 8 of 39 recorded task calls used it,
// all carrying quoted multi-line contracts.
test("rescue docs teach the prompt forms that survive tokenization", () => {
  for (const [name, text] of [
    ["skills/agy-cli-runtime/SKILL.md", readDoc("skills", "agy-cli-runtime", "SKILL.md")],
    ["agents/agy-rescue.md", readDoc("agents", "agy-rescue.md")]
  ]) {
    assert.match(text, /task .*--\s*<(?:task text|prompt)>/, `${name} must show the -- form`);
    assert.match(text, /--prompt-file/, `${name} must offer --prompt-file for hostile prompts`);
    assert.doesNotMatch(
      text,
      /task (?:--write )?"<(?:task text|raw arguments)>"/,
      `${name} must not still document the quoted single-argument form`
    );
  }
});

// X4/PC4: "return nothing" degraded exactly where it mattered — a forwarder
// killed by the 120s Bash wall has no stdout to return, so 6 of 13 recorded
// rescue dispatches came back empty while their job had already completed.
test("rescue docs replace `return nothing` with a structured failure line", () => {
  for (const [name, text] of [
    ["skills/agy-cli-runtime/SKILL.md", readDoc("skills", "agy-cli-runtime", "SKILL.md")],
    ["agents/agy-rescue.md", readDoc("agents", "agy-rescue.md")]
  ]) {
    assert.doesNotMatch(text, /return nothing/i, `${name} must not tell the forwarder to return nothing`);
    assert.match(
      text,
      /AGY_RESCUE_FAILED: <reason> \| job=<id[^>]*> \| log=<[^>]*>/,
      `${name} must specify the structured failure line`
    );
    assert.match(text, /at most one `result <id>`/, `${name} must allow retrieving its own job`);
    assert.match(text, /never write your own answer/i, `${name} must keep the substitution ban`);
  }

  // The slash command briefs the same subagent, and it still carried the older
  // rule — "do not ask the subagent to poll `/agy:status`, fetch
  // `/agy:result`" — which forbids the recovery the two documents above
  // now require. Whichever the model read first decided whether a killed
  // forwarder was allowed to go and get the answer that already existed.
  const command = readDoc("commands", "rescue.md");
  assert.doesNotMatch(
    command,
    /poll `\/agy:status`, fetch `\/agy:result`/,
    "commands/rescue.md must not ban the recovery the rescue contract requires"
  );
  assert.match(command, /AGY_RESCUE_FAILED/, "commands/rescue.md must name the failure line too");
  assert.match(command, /at most one `result <id>`/);
});

// `--background` / `--wait` are Claude-side execution flags; forwarding them to
// the companion is what made two 2026-07-21 runs die on the 2-minute wall.
test("rescue docs keep --background as a Claude-side flag, not a companion flag", () => {
  const skill = readDoc("skills", "agy-cli-runtime", "SKILL.md");
  assert.match(skill, /Strip it before calling `task`/);
  assert.doesNotMatch(skill, /agy-companion\.mjs" task --background/);
});

// M7 / the repository's documentation ownership layers: a bundled SKILL.md
// states contract facts (which call, which field, which code is retryable);
// orchestration rhythm and budget advice belongs where the runtime owns it —
// `--help` and the README. Both copies drifted apart the last time this was
// only a convention.
test("wall-time budgeting lives in --help and the README, not the bundled skill", () => {
  const skill = readDoc("skills", "agy-result-handling", "SKILL.md");
  const runtime = readDoc("scripts", "agy-companion.mjs");
  const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

  for (const measurement of [/p90/i, /median/i, /16 of 19/]) {
    assert.doesNotMatch(skill, measurement, "the skill must not carry scheduling statistics");
    assert.match(runtime, measurement, "status --help must carry them instead");
    assert.match(readme, measurement, "and so must the README");
  }
  // What the skill keeps: the primitive and the field semantics.
  assert.match(skill, /status <id> --wait --timeout-ms <ms>/);
  assert.match(skill, /`resultComplete: false`[^\n]*missing seat/);
  assert.match(skill, /`status --help`[^\n]*README/, "the skill must point at the layer that owns the budget");
});

// The 0.2.0 notes described a stderr warning for focus text dropped by
// `review` — behaviour PC6 removed inside the same batch, contradicted by a
// sibling entry in the same section and absent from the runtime. A release note
// is a deliverable: it has to describe the code that shipped.
test("the changelog's review claims match the runtime that shipped", () => {
  const sections = readDoc("CHANGELOG.md").split(/^## /m);
  const latest = sections[1];
  assert.match(latest, /^0\.2\.0\b/, "the first section must be the release being described");
  assert.doesNotMatch(
    latest,
    /stderr warning naming the dropped text/,
    "review no longer warns about dropped focus text; it interpolates it"
  );

  const runtime = readDoc("scripts", "agy-companion.mjs");
  // What the notes claim instead, checked against the code and the template.
  assert.match(runtime, /USER_FOCUS: focus/, "focus text must reach both review prompts");
  assert.match(readDoc("prompts", "review.md"), /\{\{USER_FOCUS\}\}/);
  assert.match(latest, /`--threat-model` is refused by plain `review`/);
  assert.doesNotMatch(
    readDoc("prompts", "review.md"),
    /THREAT_MODEL/,
    "plain review has no threat-model slot, which is why the flag is refused"
  );
});

// X5/PC9: orchestrators hard-coded `.../agy/0.1.0/scripts/...`, guessed a
// path that did not exist, and then `find | head -1`'d their way onto a stale
// copy — which they then used for 3.5 hours while its job state went into
// another plugin's directory.
test("rescue docs route through the exported entry point, never a versioned path", () => {
  for (const [name, text] of [
    ["skills/agy-cli-runtime/SKILL.md", readDoc("skills", "agy-cli-runtime", "SKILL.md")],
    ["agents/agy-rescue.md", readDoc("agents", "agy-rescue.md")],
    // The slash command briefs the same subagent and was left on the bare
    // plugin-root path, which is the fallback rather than the route.
    ["commands/rescue.md", readDoc("commands", "rescue.md")]
  ]) {
    assert.match(
      text,
      /\$\{AGY_COMPANION_BIN:-\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/agy-companion\.mjs\}/,
      `${name} must use the exported entry point with a plugin-root fallback`
    );
    assert.doesNotMatch(
      text,
      /plugins\/(?:cache|marketplaces)[^\s`'"]*\d+\.\d+\.\d+/,
      `${name} must not contain a versioned cache path`
    );
  }
  assert.match(
    readDoc("skills", "agy-cli-runtime", "SKILL.md"),
    /never `find \| head -1`/i,
    "the skill must ban path guessing outright"
  );
});
