import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import type { GitHubClient } from "./github.js";
import {
  BOARD_WORKER_ID,
  clearPendingAutoMerge,
  getTask,
  HUMAN_WORKER_ID,
  listOpenMergeQuestions,
  listPendingAutoMerges,
  registerMergeQuestion,
  settleMergeQuestionAsObserved,
} from "./tasks.js";
import { resolveOrQuarantine, type WorkspaceConfig } from "./workspace.js";

/** The auto_if_ci_green poll (issue #11): for every low-risk task awaiting an
 *  unattended merge, check CI live and act — merge on success, or fall back
 *  to an escalation question on failure (a red build is never silently
 *  merged, and never silently dropped either); still pending leaves it
 *  queued for the next poll. Runs on its own interval (server.ts), separate
 *  from the scheduler's pickup poll.
 *
 *  Resolved per pending row against its own originating task's execution
 *  workspace (issue #26 / ADR 0009), not a single board-wide workspace — an
 *  unresolvable name (registry drift) is this poll's own async seam, so it
 *  quarantines fail-closed and leaves the row pending for the next tick. */
export async function checkPendingAutoMerges(
  db: Db,
  github: GitHubClient,
  resolve: (taskWorkspace: string | null) => WorkspaceConfig,
  now: Date,
): Promise<void> {
  for (const { task_id, pr_number } of listPendingAutoMerges(db)) {
    const task = getTask(db, task_id);
    if (!task) continue;
    const workspace = resolveOrQuarantine(db, resolve, task.workspace, now);
    if (!workspace) continue;
    const status = await github.getCiStatus({ path: workspace.path, number: pr_number });
    if (status === "pending") continue;
    if (status === "success") {
      // the GitHub merge call runs before the row is cleared: if it throws, the
      // task stays queued and the next poll retries it, rather than the row
      // vanishing with no merge and no question to fall back on
      try {
        await github.mergePullRequest({ path: workspace.path, number: pr_number });
      } catch (err) {
        // ADR 0079 決定3 の3つ目の契機。この検査は既存の発火条件(待ち行が非空)の
        // **内側**にあり、60秒面を一切広げない。merge 済みなら失敗は恒久的で、
        // 再キューは毎 tick 失敗し続ける無限リトライにしかならない
        if (!(await github.isPullRequestMerged({ path: workspace.path, number: pr_number }))) {
          throw err;
        }
        clearPendingAutoMerge(db, task_id);
        appendEvent(db, {
          taskId: task_id,
          workerId: BOARD_WORKER_ID,
          origin: "board",
          payload: { kind: "pr_merge_observed", pr_number },
          at: now,
        });
        continue;
      }
      clearPendingAutoMerge(db, task_id);
      appendEvent(db, {
        taskId: task_id,
        workerId: HUMAN_WORKER_ID,
        origin: "board",
        payload: { kind: "pr_merged", pr_number },
        at: now,
      });
      continue;
    }
    clearPendingAutoMerge(db, task_id);
    registerMergeQuestion(
      db,
      task,
      pr_number,
      `"${task.title}"'s auto_if_ci_green auto-merge found CI red on PR #${pr_number}. ` +
        "Merge anyway, or hold?",
      "hold",
      HUMAN_WORKER_ID,
      now,
      "board",
    );
  }
}

/** How often the external-merge scan below runs (ADR 0079 決定3). Deliberately
 *  slower than the 60s CI poll and deliberately its own interval: what waits
 *  here is a human's judgement (hours to days), not a CI run, and riding the
 *  60s poll would widen its firing condition by a whole time scale. The scan
 *  buys comfort only — correctness is the answer-time backstop's job, so this
 *  number is not a thing to "fix" down to 60s. */
export const EXTERNAL_MERGE_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/** ADR 0079 決定3's first trigger: read the PRs of the merge questions the
 *  board still holds a decision on, and retire any whose PR someone already
 *  merged on GitHub's own surface — a human must never be shown a decision
 *  that no longer decides anything. Zero open merge questions means zero
 *  requests: the reading list is the board's own decision surface, never all
 *  open PRs (an `external` dial registers no question, so its PRs are out of
 *  scope by construction — the declaration stays honest). */
export async function observeExternalMerges(
  db: Db,
  github: GitHubClient,
  resolve: (taskWorkspace: string | null) => WorkspaceConfig,
  now: Date,
): Promise<void> {
  for (const { id, pr_number, workspace: taskWorkspace } of listOpenMergeQuestions(db)) {
    const workspace = resolveOrQuarantine(db, resolve, taskWorkspace, now);
    if (!workspace) continue;
    // per question, not per scan: an unreachable PR (an offline Pi, a lost
    // token, a GitHub outage) must not stop the others from being observed —
    // and must not take the board down either. This is a comfort mechanism,
    // and correctness lives in the answer-time backstop, so a failed read is
    // simply the scan not having found anything this tick.
    try {
      if (await github.isPullRequestMerged({ path: workspace.path, number: pr_number })) {
        settleMergeQuestionAsObserved(db, id, pr_number, now);
      }
    } catch {}
  }
}
