import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeJobStatus,
  renderIncompleteOutput,
  renderJobDetail,
  renderJobList,
  renderReviewOutput,
  renderTaskOutput,
  firstLine,
  fmtDuration
} from "../plugins/agy/scripts/lib/render.mjs";

const job = {
  id: "review-x",
  kind: "review",
  status: "completed",
  durationMs: 65_000,
  agyConversationId: "ses_render"
};

test("renderReviewOutput orders findings by severity and keeps the session hint", () => {
  const rendered = renderReviewOutput(job, {
    structuredOutput: {
      verdict: "needs-attention",
      summary: "Two problems.",
      findings: [
        { severity: "low", title: "Nit", body: "b", file: "a.js", line_start: 1, line_end: 1, confidence: 0.5, recommendation: "r" },
        { severity: "critical", title: "Boom", body: "b", file: "b.js", line_start: 2, line_end: 3, confidence: 0.9, recommendation: "r" }
      ],
      next_steps: ["fix Boom"]
    }
  });
  assert.match(rendered, /Verdict: NEEDS ATTENTION/);
  assert.ok(rendered.indexOf("Boom") < rendered.indexOf("Nit"), "critical must render before low");
  assert.match(rendered, /b\.js:2-3/);
  assert.match(rendered, /Continue in agy with: agy --conversation ses_render/);
});

test("renderReviewOutput falls back to raw output when schema parsing failed", () => {
  const rendered = renderReviewOutput(job, { structuredOutput: null, rawOutput: "free-form review text" });
  assert.match(rendered, /did not match the expected schema/);
  assert.match(rendered, /free-form review text/);
});

test("renderTaskOutput appends the job footer", () => {
  const rendered = renderTaskOutput(job, { rawOutput: "did the thing" });
  assert.match(rendered, /did the thing/);
  assert.match(rendered, /Job: review-x \(review, completed, 1m05s\)/);
  assert.doesNotMatch(rendered, /Most recent stderr/, "no stderr, no empty block");
});

// PC3: agy auto-rejects paths outside the repo on stderr and still exits
// 0, so the success path used to hide the cause of a thin or missing answer.
test("renderTaskOutput shows the stderr tail on a run that exited 0", () => {
  const stderrTail = [
    "line one",
    "line two",
    "line three",
    "line four",
    "line five",
    "! permission requested: external_directory (/private/tmp/*); auto-rejecting"
  ].join("\n");
  const rendered = renderTaskOutput(job, { rawOutput: "a long real answer", stderrTail });
  assert.match(rendered, /a long real answer/);
  assert.match(rendered, /Most recent stderr:/);
  assert.match(rendered, /permission requested: external_directory/);
  assert.doesNotMatch(rendered, /line one/, "only the last 5 lines");
  assert.match(rendered, /line two/);
});

test("renderIncompleteOutput labels the run, keeps partial text, and gives a recovery command", () => {
  const rendered = renderIncompleteOutput(
    { ...job, kind: "task", status: "incomplete", durationMs: 124_000 },
    {
      rawOutput: "Parent contracts read. Now the source files.",
      stopReason: "tool-calls",
      outputState: "incomplete",
      outputStateReason: "stop-reason",
      toolEventCount: 3,
      stderrTail: "! permission requested: external_directory (/private/tmp/*); auto-rejecting"
    }
  );
  assert.match(rendered, /stopped before producing a final answer \(stopReason: tool-calls, 3 tool calls, 44 chars of text\)/);
  assert.match(rendered, /treat it as work-in-progress, not as the answer/);
  assert.match(rendered, /Parent contracts read\./);
  assert.match(rendered, /external_directory/);
  assert.match(rendered, /Recover with: \/agy:rescue --resume/);
  assert.match(rendered, /Job: review-x \(task, incomplete, 2m04s\)/);
});

test("renderIncompleteOutput never presents an empty answer as output", () => {
  const rendered = renderIncompleteOutput(
    { ...job, kind: "task", status: "incomplete", durationMs: 7_000 },
    { rawOutput: "", stopReason: "stop", outputStateReason: "empty-text", toolEventCount: 0 }
  );
  assert.match(rendered, /0 tool calls, 0 chars of text/);
  assert.match(rendered, /agy produced no final text at all/);
  assert.doesNotMatch(rendered, /\[agy returned no final output\]/);
});

test("renderJobDetail surfaces the output state and stop reason", () => {
  const rendered = renderJobDetail(
    { ...job, kind: "task", status: "incomplete", createdAt: "t0", updatedAt: "t1" },
    { outputState: "incomplete", stopReason: "tool-calls" },
    ""
  );
  assert.match(rendered, /Output state: incomplete/);
  assert.match(rendered, /Stop reason: tool-calls/);
  assert.match(rendered, /Run \/agy:result review-x/);
});

// A reader can reconcile a job to `failed (orphaned)` while its companion is
// still parsing the run; the owning process then writes the real verdict on
// top. The label must never outlive the failure it describes.
test("a failure label never qualifies a non-failed status", () => {
  const stale = { ...job, id: "task-race", kind: "task", status: "completed", failureClass: "orphaned" };
  assert.equal(describeJobStatus(stale), "completed");
  assert.equal(describeJobStatus({ ...stale, status: "cancelled" }), "cancelled");
  assert.equal(describeJobStatus({ ...stale, status: "failed" }), "failed (orphaned)");

  const table = renderJobList([{ ...stale, createdAt: new Date().toISOString(), summary: "the real answer" }]);
  assert.match(table, /task-race \| task \| completed \|/);
  assert.doesNotMatch(table, /\(orphaned\)/);

  const detail = renderJobDetail(stale, { outputState: "completed" }, "");
  assert.match(detail, /Status: completed$/m);
  assert.doesNotMatch(detail, /companion process for this job died/);

  const failed = renderJobDetail({ ...stale, status: "failed" }, null, "");
  assert.match(failed, /Status: failed \(orphaned\)/);
  assert.match(failed, /companion process for this job died/);
});

test("format helpers behave", () => {
  assert.equal(fmtDuration(2_000), "2s");
  assert.equal(fmtDuration(Number.NaN), "-");
  assert.equal(firstLine("one\ntwo"), "one");
});
