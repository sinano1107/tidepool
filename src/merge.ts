import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import type { GitHubClient } from "./github.js";
import {
  clearPendingAutoMerge,
  getTask,
  HUMAN_WORKER_ID,
  listPendingAutoMerges,
  registerMergeQuestion,
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
      await github.mergePullRequest({ path: workspace.path, number: pr_number });
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
