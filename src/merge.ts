import { appendEvent } from "./events.js";
import type { Db } from "./db.js";
import type { GitHubClient } from "./github.js";
import {
  clearPendingAutoMerge,
  getTask,
  HUMAN_WORKER_ID,
  listPendingAutoMerges,
  MERGE_QUESTION_OPTIONS,
  registerTask,
} from "./tasks.js";
import type { WorkspaceConfig } from "./workspace.js";

/** The auto_if_ci_green poll (issue #11): for every low-risk task awaiting an
 *  unattended merge, check CI live and act — merge on success, or fall back
 *  to an escalation question on failure (a red build is never silently
 *  merged, and never silently dropped either); still pending leaves it
 *  queued for the next poll. Runs on its own interval (server.ts), separate
 *  from the scheduler's pickup poll. */
export async function checkPendingAutoMerges(
  db: Db,
  github: GitHubClient,
  workspace: WorkspaceConfig,
  now: Date,
): Promise<void> {
  for (const { task_id, pr_number } of listPendingAutoMerges(db)) {
    const status = await github.getCiStatus({ path: workspace.path, number: pr_number });
    if (status === "pending") continue;
    clearPendingAutoMerge(db, task_id);
    if (status === "success") {
      await github.mergePullRequest({ path: workspace.path, number: pr_number });
      appendEvent(db, {
        taskId: task_id,
        workerId: HUMAN_WORKER_ID,
        payload: { kind: "pr_merged", pr_number },
        at: now,
      });
      continue;
    }
    const task = getTask(db, task_id);
    if (!task) continue;
    registerTask(
      db,
      {
        type: "question",
        title: `merge PR #${pr_number}: ${task.title}`,
        purpose:
          `"${task.title}"'s auto_if_ci_green auto-merge found CI red on PR #${pr_number}. ` +
          "Merge anyway, or hold?",
        completion_criteria: "a human decides whether to merge",
        question: { options: [...MERGE_QUESTION_OPTIONS], recommendation: "hold" },
        pending_merge_pr: pr_number,
      },
      now,
      HUMAN_WORKER_ID,
    );
  }
}
