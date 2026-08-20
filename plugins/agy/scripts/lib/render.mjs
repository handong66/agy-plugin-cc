import { FAILURE_CLASS_GUIDANCE } from "./agycli.mjs";

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "-";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function firstLine(text, maxLength = 120) {
  const line = String(text ?? "").split(/\r?\n/, 1)[0].trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

// `failureClass` qualifies a failure and nothing else. Reconciliation can label
// a record `failed (orphaned)` from any reader, and the owning companion may
// then write the real verdict on top of it; if the label ever outlived the
// status it would make a successful run read as an orphan.
export function describeJobStatus(job) {
  return job?.status === "failed" && job?.failureClass ? `${job.status} (${job.failureClass})` : job?.status;
}

// agy reports auto-rejected paths, provider warnings and quota notices on
// stderr while still exiting 0, so the stderr tail belongs on the success path
// too — hiding it there is what made `permission requested: external_directory
// (/private/tmp/*); auto-rejecting` invisible to every caller.
function stderrBlock(stderrTail, lineCount) {
  const stderr = String(stderrTail ?? "").trim();
  if (!stderr) {
    return [];
  }
  return ["", "Most recent stderr:", "```", stderr.split(/\r?\n/).slice(-lineCount).join("\n"), "```"];
}

// Typed warnings sit above the raw stderr block: the tail explains *what*
// agy printed, this says what it means for the answer below.
function warningBlock(warnings) {
  const entries = Array.isArray(warnings) ? warnings.filter((warning) => warning?.message) : [];
  if (entries.length === 0) {
    return [];
  }
  return ["", "Warnings:", ...entries.map((warning) => `- ${warning.message}`)];
}

// Which model produced this. Every recorded job stored `model: null` and no
// renderer showed the agent, so read-only runs silently landing on the plan
// agent's model — a different, cheaper model than the configured default —
// could not be seen by anyone relying on those reviews.
export function describeRunSelection(job) {
  if (!job?.model && !job?.agent) {
    return null;
  }
  const qualifiers = [job.agent ? `agent ${job.agent}` : null, job.variant ? `variant ${job.variant}` : null]
    .filter(Boolean)
    .join(", ");
  // Only two sources are observations: a `--model` this plugin put on the
  // command line, and a model id the run's own event stream reported. Anything
  // read out of a config file is a prediction — agy resolves its model
  // from a project-level config and its environment too, so stating an inferred
  // id as fact would report a model that never ran.
  const observed = job.modelCertainty
    ? job.modelCertainty === "actual"
    : job.modelSource === "flag" || job.modelSource === "event-stream";
  const label = observed ? "Model" : "Model (expected)";
  return `${label}: ${job.model ?? "agy default"}${qualifiers ? ` (${qualifiers})` : ""}`;
}

function footer(job) {
  const lines = [
    "",
    "---",
    `Job: ${job.id} (${job.kind}, ${describeJobStatus(job)}, ${fmtDuration(job.durationMs)})`
  ];
  const selection = describeRunSelection(job);
  if (selection) {
    lines.push(selection);
  }
  if (job.agyConversationId) {
    lines.push(`agy conversation: ${job.agyConversationId}`);
    lines.push(`Continue in agy with: agy --conversation ${job.agyConversationId}`);
  }
  return lines.join("\n");
}

export function renderTaskOutput(job, payload) {
  const text = String(payload.rawOutput ?? "").trim();
  const body = text || "[agy returned no final output]";
  return [body, ...warningBlock(payload.warnings), ...stderrBlock(payload.stderrTail, 5), footer(job)].join("\n");
}

const INCOMPLETE_REASON_DETAIL = {
  "empty-text": "agy produced no final text at all.",
  "stop-reason": "The run stopped for a reason that is not a finished turn.",
  narration:
    "The last message reads like narration about work in progress, not the requested answer (tool calls happened, but the final text is very short).",
  "schema-mismatch":
    "The final answer did not match the review schema this run asked for, so there is no verdict to report — only the text below."
};

// The fourth renderer: a run that exited 0 without producing an answer. It must
// never look like a success, and it must never hide the partial output either.
export function renderIncompleteOutput(job, payload) {
  const text = String(payload.rawOutput ?? "").trim();
  const toolCalls = Number(payload.toolEventCount ?? 0);
  const schemaMismatch = payload.outputStateReason === "schema-mismatch";
  const lines = [
    schemaMismatch
      ? `agy answered, but the answer is not a review: it did not match the review output schema (${toolCalls} tool call${toolCalls === 1 ? "" : "s"}, ${text.length} chars of text).`
      : `agy stopped before producing a final answer (stopReason: ${payload.stopReason ?? "unknown"}, ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}, ${text.length} chars of text).`
  ];
  const detail = INCOMPLETE_REASON_DETAIL[payload.outputStateReason];
  if (detail) {
    lines.push(detail);
  }
  const schemaErrors = Array.isArray(payload.structuredOutputErrors) ? payload.structuredOutputErrors : [];
  if (schemaMismatch && schemaErrors.length > 0) {
    lines.push("", "Schema mismatches:", ...schemaErrors.slice(0, 8).map((error) => `- ${error}`));
  }
  lines.push(
    schemaMismatch
      ? "Raw output below — do not present it as a verdict, and do not infer one from it."
      : "Partial output below — treat it as work-in-progress, not as the answer."
  );
  lines.push("", text || "[agy produced no text]");
  lines.push(...warningBlock(payload.warnings));
  lines.push(...stderrBlock(payload.stderrTail, 5));

  lines.push(
    "",
    schemaMismatch
      ? "Recover with: /agy:rescue --resume Return only the JSON review object required by the output schema. Do not read any more files and do not call any tools."
      : "Recover with: /agy:rescue --resume Return only the final answer itself. Do not read any more files and do not call any tools."
  );
  lines.push(footer(job));
  return lines.join("\n");
}

export function renderTaskFailure(job, payload) {
  const lines = [`agy ${job.kind} run failed (exit code ${payload.exitCode ?? "unknown"}).`];
  if (payload.timedOut) {
    lines.push(
      `The run was stopped by the companion after ${payload.timeoutMs}ms (--timeout-ms); agy itself has no timeout flag.`,
      "Re-run with a larger --timeout-ms, or narrow the task."
    );
  }
  if (payload.interrupted) {
    lines.push(
      "The companion was terminated (Bash timeout or session teardown) before agy finished, and its child was killed with it.",
      "Anything agy had streamed by then is below — treat it as work-in-progress, not as the answer.",
      "Recover with: /agy:rescue --resume Return only the final answer itself. Do not read any more files and do not call any tools."
    );
  }
  if (payload.spawnError) {
    lines.push(`Spawn error: ${payload.spawnError}`);
  }
  // One line of "what to do about it" ahead of the raw tail. The tail is still
  // printed in full below: the class is a reading aid, never a replacement, and
  // a wrong class must cost nothing more than a wrong suggestion.
  const guidance = FAILURE_CLASS_GUIDANCE[job?.failureClass ?? payload.failureClass];
  if (guidance) {
    lines.push("", `Next step (${job?.failureClass ?? payload.failureClass}): ${guidance}`);
  }
  lines.push(...warningBlock(payload.warnings));
  lines.push(...stderrBlock(payload.stderrTail, 15));
  if (String(payload.rawOutput ?? "").trim()) {
    lines.push("", "Partial output:", String(payload.rawOutput).trim());
  }
  lines.push(footer(job));
  return lines.join("\n");
}

export function renderReviewOutput(job, payload) {
  const review = payload.structuredOutput;
  if (!review || typeof review !== "object") {
    const raw = String(payload.rawOutput ?? "").trim();
    return [
      "agy returned review output that did not match the expected schema. Raw output below.",
      "",
      raw || "[empty output]",
      ...warningBlock(payload.warnings),
      footer(job)
    ].join("\n");
  }

  const lines = [];
  const verdict = review.verdict === "approve" ? "APPROVE" : "NEEDS ATTENTION";
  lines.push(`Verdict: ${verdict}${payload.evidenceLevel ? ` (evidence: ${payload.evidenceLevel})` : ""}`);
  lines.push("");
  lines.push(String(review.summary ?? "").trim());

  const findings = Array.isArray(review.findings) ? [...review.findings] : [];
  findings.sort(
    (left, right) => (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9)
  );

  if (findings.length === 0) {
    lines.push("", "No material findings.");
  } else {
    lines.push("", `Findings (${findings.length}):`);
    findings.forEach((finding, index) => {
      const location = `${finding.file}:${finding.line_start}${
        finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ""
      }`;
      const confidence = Number.isFinite(finding.confidence)
        ? ` (confidence ${Number(finding.confidence).toFixed(2)})`
        : "";
      lines.push("", `${index + 1}. [${finding.severity}] ${finding.title} — ${location}${confidence}`);
      if (finding.body) {
        lines.push(`   ${String(finding.body).trim().replace(/\n/g, "\n   ")}`);
      }
      if (finding.recommendation) {
        lines.push(`   Recommendation: ${String(finding.recommendation).trim().replace(/\n/g, "\n   ")}`);
      }
    });
  }

  const nextSteps = Array.isArray(review.next_steps) ? review.next_steps.filter(Boolean) : [];
  if (nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  lines.push(...warningBlock(payload.warnings));
  lines.push(footer(job));
  return lines.join("\n");
}

export function renderJobList(jobs, { gateEnabled = false } = {}) {
  const lines = [`Review gate: ${gateEnabled ? "enabled" : "disabled"}`];
  if (jobs.length === 0) {
    lines.push("", "No agy jobs recorded for this repository yet.");
    return lines.join("\n");
  }
  lines.push("", "id | kind | status | elapsed | summary");
  for (const job of jobs) {
    // Only a job whose process is still alive keeps counting up; an orphaned
    // record froze when its companion died and must say so.
    const elapsed =
      job.status === "running" || job.status === "queued"
        ? fmtDuration(Date.now() - Date.parse(job.createdAt ?? "") || 0)
        : fmtDuration(job.durationMs);
    const status = describeJobStatus(job);
    lines.push(
      [job.id, job.kind, status, elapsed, firstLine(job.summary ?? job.promptPreview ?? "", 80)].join(" | ")
    );
  }
  lines.push("", "Use /agy:result <id> for finished output, /agy:cancel <id> to stop a running job.");
  return lines.join("\n");
}

export function renderJobDetail(job, payload, logTail) {
  const lines = [
    `Job: ${job.id}`,
    `Kind: ${job.kind}`,
    `Status: ${describeJobStatus(job)}`,
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`,
    `Duration: ${fmtDuration(job.durationMs)}`
  ];
  const selection = describeRunSelection(job);
  if (selection) {
    lines.push(selection);
  }
  if (payload?.outputState || job.outputState) {
    lines.push(`Output state: ${payload?.outputState ?? job.outputState}`);
  }
  if (payload?.stopReason) {
    lines.push(`Stop reason: ${payload.stopReason}`);
  }
  if (job.agyConversationId) {
    lines.push(`agy conversation: ${job.agyConversationId} (agy --conversation ${job.agyConversationId})`);
  }
  if (job.promptPreview) {
    lines.push(`Prompt: ${job.promptPreview}`);
  }
  // The four output renderers all printed these; the one command whose whole
  // job is "tell me about this finished run" did not, so `external_path_blocked`
  // and `skills_loaded` were visible everywhere except where a caller goes to
  // ask what happened. Above the raw log for the usual reason: the log says
  // what agy printed, the warning says what it means.
  lines.push(...warningBlock(payload?.warnings));
  if (logTail) {
    lines.push("", "Recent activity:", "```", logTail, "```");
  }
  if (job.status === "failed" && job.failureClass === "orphaned") {
    lines.push(
      "",
      `The companion process for this job died before it could store a result.${job.logFile ? ` Partial output may exist in ${job.logFile}.` : ""}`,
      "Re-run with /agy:rescue --resume to continue that agy session."
    );
  }
  if (payload && ["completed", "failed", "incomplete"].includes(job.status)) {
    lines.push("", "Stored output available. Run /agy:result " + job.id + " to see it.");
  }
  return lines.join("\n");
}
