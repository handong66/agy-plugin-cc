#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { collectReviewInput } from "./lib/git.mjs";
import { getAgyAvailability, MIN_ANSWER_CHARS_ENV } from "./lib/agycli.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { READY_ENV, SESSION_ID_ENV } from "./lib/session-env.mjs";
import { getConfig, listJobs, resolveStateFile, setConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// Must stay strictly below the Stop hook budget in hooks/hooks.json
// (`"timeout": 900` seconds). They used to be identical, so Claude Code killed
// the hook at the same instant the friendly "the review timed out" message
// became available and the caller got nothing at all.
const STOP_HOOK_BUDGET_MS = 900 * 1000;
const STOP_REVIEW_TIMEOUT_MS = Math.round(STOP_HOOK_BUDGET_MS * 0.8);
// Two blocks in a row means the session cannot get past this gate on its own.
// A third would be a loop with the user inside it.
const MAX_CONSECUTIVE_BLOCKS = 2;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

// Three verdicts, not two. A gate whose failure mode is "the user cannot end
// the session" must distinguish "the reviewer found a problem" from "the
// review never happened": only the first is worth blocking on, and the four
// infrastructure paths below are the ones this runtime produces most often.
function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return { verdict: "error", reason: "the review task returned no final output" };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { verdict: "allow", reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      verdict: "block",
      reason: `agy stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return { verdict: "error", reason: "the review task answered in an unrecognised format" };
}

function runStopReview(cwd, input = {}, { availabilityChecked = false } = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "agy-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {}),
    // The gate's contract asks for one short line (`ALLOW:`/`BLOCK: <reason>`),
    // so the generic "a one-liner after tool calls is narration, not an answer"
    // heuristic is wrong for exactly this child: it turned every real verdict
    // from a reviewer that read the repo into `incomplete`.
    [MIN_ANSWER_CHARS_ENV]: "0",
    // The hook has already paid for `agy --version` + `agy auth list`
    // (~1.1s measured); the child would otherwise run the same two probes.
    ...(availabilityChecked ? { [READY_ENV]: "1" } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      verdict: "error",
      reason: `the review task did not finish within ${Math.round(STOP_REVIEW_TIMEOUT_MS / 60000)} minutes`
    };
  }
  if (result.error) {
    return { verdict: "error", reason: `the review task could not be started (${result.error.message})` };
  }

  const describeExit = () => {
    const detail = String(result.stderr || result.stdout || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .at(-1);
    return detail
      ? `the review task exited ${result.status}: ${detail}`
      : `the review task exited ${result.status}`;
  };

  // The verdict lives in the payload, not in the exit status. `task` exits 2
  // whenever the run ended without what *it* considers a complete answer, and
  // a blacklisted `stopReason` (`tool-calls`) alone is enough to get there — so
  // reading the status first meant the reviewer could say `BLOCK: <reason>`,
  // have it sitting in `rawOutput`, and still be reported as "the gate could
  // not run". Infrastructure failure now means what it says: no spawn, no
  // deadline, no parseable document, or an answer this contract cannot read.
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  if (payload && typeof payload === "object") {
    const review = parseStopReviewOutput(payload.rawOutput);
    if (review.verdict !== "error" || result.status === 0) {
      return review;
    }
    return { verdict: "error", reason: `${review.reason} (${describeExit()})` };
  }

  if (result.status !== 0) {
    return { verdict: "error", reason: describeExit() };
  }
  return { verdict: "error", reason: "the review task returned invalid JSON" };
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function currentHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

// The cheapest possible answer to "is there anything to review": ask git, not a
// model. `prompts/stop-review-gate.md` already tells the model to allow when
// nothing changed — this turns that intent into a mechanism instead of paying
// for a whole agy session to be told so. HEAD is checked as well, because
// a turn whose only change has already been committed leaves a clean tree.
function hasNothingToReview(cwd, config) {
  let isEmpty;
  try {
    isEmpty = collectReviewInput(cwd, { scope: "auto" }).isEmpty;
  } catch {
    return false; // Not a git checkout, or git failed: do not skip the review.
  }
  if (!isEmpty) {
    return false;
  }
  const head = currentHead(cwd);
  const seenHead = config.stopGateLastHead ?? null;
  return Boolean(head) && Boolean(seenHead) && head === seenHead;
}

function recordHead(workspaceRoot, cwd) {
  const head = currentHead(cwd);
  if (head) {
    setConfig(workspaceRoot, "stopGateLastHead", head);
  }
}

function consecutiveBlocks(config, sessionId) {
  return config.stopGateBlockSession === sessionId ? Number(config.stopGateBlockCount ?? 0) : 0;
}

function recordBlockOutcome(workspaceRoot, sessionId, count) {
  setConfig(workspaceRoot, "stopGateBlockSession", count > 0 ? sessionId : null);
  setConfig(workspaceRoot, "stopGateBlockCount", count);
}

function main() {
  const input = readHookInput();
  // Claude Code's standard loop breaker: this Stop is the continuation of a
  // Stop this hook already blocked. Deciding again is how a gate turns into a
  // session the user cannot leave.
  if (input.stop_hook_active) {
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Three of these hooks (grok / agy / codex) run on every Stop of every
  // session, and across 40 recorded sessions the gate was enabled in exactly
  // zero of 25 workspaces. One `existsSync` ends the common case — a workspace
  // that has never run this plugin has no gate to run and no job to report.
  if (!fs.existsSync(resolveStateFile(workspaceRoot))) {
    return;
  }
  const config = getConfig(workspaceRoot);
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;

  const jobs = filterJobsForCurrentSession(listJobs(workspaceRoot), input);
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `agy job ${runningJob.id} is still running. Check /agy:status and use /agy:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    // Non-blocking, but in the transcript rather than on a stderr channel
    // nobody reads: an unreclaimed job is exactly what the user needs to know
    // about before the session ends.
    if (runningTaskNote) {
      emitDecision({ systemMessage: runningTaskNote });
    }
    return;
  }

  if (hasNothingToReview(cwd, config)) {
    logNote("agy stop-gate: no working-tree changes since the last stop; skipping the review.");
    if (runningTaskNote) {
      emitDecision({ systemMessage: runningTaskNote });
    }
    return;
  }

  const availability = getAgyAvailability();
  if (!availability.available || !availability.usable) {
    logNote(`agy is not set up for the review gate. ${availability.detail ?? ""} Run /agy:setup.`);
    if (runningTaskNote) {
      emitDecision({ systemMessage: runningTaskNote });
    }
    return;
  }

  const review = runStopReview(cwd, input, { availabilityChecked: true });
  recordHead(workspaceRoot, cwd);

  // Fail open. A blocked stop caused by the gate's own failure is worse than a
  // missed review: the user is stuck, and this runtime's most common outcome
  // (no final output) hits exactly this path.
  if (review.verdict === "error") {
    recordBlockOutcome(workspaceRoot, sessionId, 0);
    const note = `agy stop-gate could not complete (${review.reason}); allowing the stop. Run /agy:review --wait manually.`;
    logNote(note);
    emitDecision({ systemMessage: runningTaskNote ? `${note} ${runningTaskNote}` : note });
    return;
  }

  if (review.verdict === "block") {
    const priorBlocks = consecutiveBlocks(config, sessionId);
    if (priorBlocks >= MAX_CONSECUTIVE_BLOCKS) {
      recordBlockOutcome(workspaceRoot, sessionId, 0);
      const note = `agy stop-gate has blocked this session ${priorBlocks} times in a row and is standing down so you are not stuck in a loop. Fix the reported findings, or turn the gate off with /agy:setup --disable-review-gate. Last reason: ${review.reason}`;
      logNote(note);
      emitDecision({ systemMessage: runningTaskNote ? `${note} ${runningTaskNote}` : note });
      return;
    }
    recordBlockOutcome(workspaceRoot, sessionId, priorBlocks + 1);
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  recordBlockOutcome(workspaceRoot, sessionId, 0);
  if (runningTaskNote) {
    emitDecision({ systemMessage: runningTaskNote });
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
