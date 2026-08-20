#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPANION_BIN_ENV,
  DATA_DIR_ENV,
  PLUGIN_DATA_ENV,
  SESSION_ID_ENV,
  TRANSCRIPT_PATH_ENV
} from "./lib/session-env.mjs";
import { listJobs, resolveStateFile, upsertJob } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  // Export our data dir under a namespaced name only. Re-exporting
  // CLAUDE_PLUGIN_DATA into the shared env file would clobber other plugins
  // (and they clobber us) since the last SessionStart hook to run wins.
  appendEnvVar(DATA_DIR_ENV, process.env[PLUGIN_DATA_ENV]);
  // The entry point of the *running* copy, resolved from this file rather than
  // assembled from a version number. Without it callers hard-coded versioned
  // cache paths, and one session spent 3.5 hours pinned to a stale 0.1.0 copy
  // it had found with `find | head -1`.
  appendEnvVar(COMPANION_BIN_ENV, path.join(path.dirname(fileURLToPath(import.meta.url)), "agy-companion.mjs"));
}

// Terminate this session's still-running jobs but keep their records so
// /agy:result stays useful across sessions; MAX_JOBS pruning bounds growth.
function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!fs.existsSync(resolveStateFile(workspaceRoot))) {
    return;
  }

  for (const job of listJobs(workspaceRoot)) {
    if (job.sessionId !== sessionId) {
      continue;
    }
    if (job.status !== "running" && job.status !== "queued") {
      continue;
    }
    try {
      terminateProcessTree(job.childPid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
    upsertJob(workspaceRoot, {
      id: job.id,
      status: "cancelled",
      // Terminal verdict: a stale `orphaned` label must not survive it.
      failureClass: null,
      endedAt: new Date().toISOString(),
      summary: "cancelled at session end"
    });
  }
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
