import assert from "node:assert/strict";
import { test } from "node:test";

import { pickResumeCandidate } from "../plugins/agy/scripts/lib/state.mjs";
import { makeFakeEnv, makeTempGitRepo, readRunArgs, runCompanion } from "./helpers.mjs";

const JOBS = [
  {
    id: "review-newest",
    kind: "review",
    status: "completed",
    agyConversationId: "ses_review",
    updatedAt: "2026-08-16T10:00:00.000Z"
  },
  {
    id: "task-running",
    kind: "task",
    status: "running",
    agyConversationId: "ses_running",
    updatedAt: "2026-08-16T09:30:00.000Z"
  },
  {
    id: "task-cancelled",
    kind: "task",
    status: "cancelled",
    agyConversationId: "ses_cancelled",
    updatedAt: "2026-08-16T09:20:00.000Z"
  },
  {
    id: "task-orphaned",
    kind: "task",
    status: "failed",
    failureClass: "orphaned",
    agyConversationId: "ses_orphaned",
    updatedAt: "2026-08-16T09:10:00.000Z"
  },
  {
    id: "task-incomplete",
    kind: "task",
    status: "incomplete",
    agyConversationId: "ses_incomplete",
    sessionId: "claude-session-a",
    updatedAt: "2026-08-16T09:00:00.000Z"
  },
  {
    id: "task-older-complete",
    kind: "task",
    status: "completed",
    agyConversationId: "ses_older",
    sessionId: "claude-session-b",
    updatedAt: "2026-08-16T08:00:00.000Z"
  }
];

// P-RESUME: `--resume-last` took the newest job of *any* kind and *any* status
// while `task-resume-candidate` — the one the rescue command shows the user —
// filtered to completed tasks. The user approved one session and got another.
test("both resume entry points agree on the same candidate", () => {
  // No Claude session in play: the newest *usable task* wins, not the newest job.
  const anySession = pickResumeCandidate(JOBS, {});
  assert.equal(anySession.id, "task-incomplete");

  // An unfinished run is deliberately eligible: resuming it to ask for the
  // final answer is the recovery path P-COMPLETE points at.
  assert.equal(anySession.agyConversationId, "ses_incomplete");

  // The current Claude session wins over recency.
  assert.equal(pickResumeCandidate(JOBS, { sessionId: "claude-session-b" }).id, "task-older-complete");

  // Cancelled and orphaned runs are never resumed implicitly.
  const noIncomplete = pickResumeCandidate(JOBS, { includeIncomplete: false });
  assert.equal(noIncomplete.id, "task-older-complete");
  assert.equal(pickResumeCandidate(JOBS.filter((job) => job.status !== "completed" && job.status !== "incomplete"), {}), null);
});

// Sessions are conversations: resume is `--conversation <id>`, and the fake
// run reports conversation 11111111-2222-3333-4444-555555555555.
const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";

test("--resume-last says which session it resumed, and --resume-session skips the guesswork", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  const first = runCompanion(["task", "--", "first run"], { env: fake.env, cwd });
  assert.equal(first.status, 0, first.stdout + first.stderr);

  const resumed = runCompanion(["task", "--resume-last", "--", "second run"], { env: fake.env, cwd });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, new RegExp(`Resuming agy conversation ${CONVERSATION_ID} \\(from job task-`));
  assert.match(resumed.stdout, /first run/, "the handle must name the prompt being continued");
  assert.equal(readRunArgs(fake).includes("--conversation"), true);

  const asJson = runCompanion(["task", "--json", "--resume-last", "--", "third run"], { env: fake.env, cwd });
  const payload = JSON.parse(asJson.stdout);
  assert.equal(payload.resumedFrom.agyConversationId, CONVERSATION_ID);
  assert.match(payload.resumedFrom.jobId, /^task-/);

  // An explicit conversation id bypasses the heuristic entirely.
  const explicit = runCompanion(["task", "--resume-session", "ses_chosen_by_caller", "--", "fourth run"], {
    env: fake.env,
    cwd
  });
  assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
  const args = readRunArgs(fake);
  assert.equal(args[args.indexOf("--conversation") + 1], "ses_chosen_by_caller");

  const conflict = runCompanion(
    ["task", "--resume-last", "--resume-session", "ses_x", "--", "fifth run"],
    { env: fake.env, cwd }
  );
  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /--resume-session/);
});

test("task-resume-candidate reports the job --resume-last would pick", () => {
  const fake = makeFakeEnv();
  const cwd = makeTempGitRepo();

  runCompanion(["task", "--", "first run"], { env: fake.env, cwd });
  const candidate = JSON.parse(
    runCompanion(["task-resume-candidate", "--json"], { env: fake.env, cwd }).stdout
  );
  const resumed = JSON.parse(
    runCompanion(["task", "--json", "--resume-last", "--", "second run"], { env: fake.env, cwd }).stdout
  );
  assert.equal(candidate.available, true);
  assert.equal(resumed.resumedFrom.jobId, candidate.jobId);
  assert.equal(resumed.resumedFrom.agyConversationId, candidate.agyConversationId);
});
