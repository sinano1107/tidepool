import { verifyAgentRepaired } from "./agent.js";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import type { ContainmentCheck } from "./containment.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import type { GitHubClient } from "./github.js";
import {
  answerQuestion,
  assertAnswerable,
  DomainError,
  getTask,
  HUMAN_WORKER_ID,
  logDecision,
  MERGE_QUESTION_OPTIONS,
  PR_PROMOTION_FAILURE_OPTIONS,
  type Task,
} from "./tasks.js";
import { stageFrontInsert, triageActivity } from "./triage.js";
import {
  buildWorkspaceResolver,
  UnknownWorkspaceError,
  verifyWorkspaceClean,
  type WorkspaceConfig,
} from "./workspace.js";

export interface SubmitAnswerDeps {
  db: Db;
  onQueueHeadChanged: () => void;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  github?: GitHubClient;
  retryPrPromotion?: (task: Task) => Promise<void>;
  agentRegistered?: (name: string) => boolean;
  containment?: ContainmentCheck;
  boardState?: BoardStatePath[];
}

/**
 * question への人間回答を実行する正準の application seam。
 * WebUI と管理 MCP は transport の違いだけを持ち、この副作用列を共有する。
 * `now` は snapshot ではなく provider — 外部副作用の await 後に都度読むことで、
 * 抽出前と同じ event / DB timestamp の順序を保つ。
 */
export async function submitAnswer(
  deps: SubmitAnswerDeps,
  task: Task,
  answers: string[],
  comment: string | undefined,
  now: () => Date,
): Promise<Task> {
  // Every special-case side effect below must come after this validation.
  // Otherwise a malformed answer can retry promotion, inspect/merge a PR, or
  // verify quarantine before answerQuestion eventually rejects the payload.
  assertAnswerable(task, answers);

  const promotionTaskId = task.question_pending_pr_promotion_task_id;
  const wantsPromotionRetry =
    promotionTaskId !== null && answers[0] === PR_PROMOTION_FAILURE_OPTIONS[0];
  if (wantsPromotionRetry) {
    const promotionTask = getTask(deps.db, promotionTaskId);
    if (!promotionTask || !deps.retryPrPromotion) {
      throw new DomainError("PR promotion can no longer be retried");
    }
    try {
      await deps.retryPrPromotion(promotionTask);
    } catch (err) {
      throw new DomainError(err instanceof Error ? err.message : String(err));
    }
  }

  const mergePr = task.question_pending_merge_pr;
  const wantsMerge = mergePr !== null && answers[0] === MERGE_QUESTION_OPTIONS[0];
  if (wantsMerge) {
    if (!deps.github) {
      throw new DomainError("no GitHub/workspace configured — cannot check CI or merge");
    }
    const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
    if (!resolve) {
      throw new DomainError("no GitHub/workspace configured — cannot check CI or merge");
    }
    let mergeWorkspace: WorkspaceConfig;
    try {
      mergeWorkspace = resolve(task.workspace);
    } catch (err) {
      if (!(err instanceof UnknownWorkspaceError)) throw err;
      throw new DomainError(
        `no workspace configured for "${err.workspaceName}" — cannot check CI or merge`,
      );
    }
    const status = await deps.github.getCiStatus({ path: mergeWorkspace.path, number: mergePr });
    if (status !== "success") {
      throw new DomainError(`CI is not green yet (status: ${status}) — cannot merge`);
    }
    // External merge precedes the persisted answer. If it fails, the question
    // stays open and the human can retry instead of being stranded as done.
    await deps.github.mergePullRequest({ path: mergeWorkspace.path, number: mergePr });
  }

  // Quarantine confirmation is never taken on faith: resolve the named
  // workspace fresh, then verify both its Git tree and its separation from
  // the board's own state immediately before accepting the answer.
  const quarantineWorkspaceName = task.question_quarantine_workspace;
  if (quarantineWorkspaceName !== null) {
    const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
    let target: WorkspaceConfig;
    try {
      if (!resolve) throw new UnknownWorkspaceError(quarantineWorkspaceName);
      target = resolve(quarantineWorkspaceName);
    } catch (err) {
      if (!(err instanceof UnknownWorkspaceError)) throw err;
      throw new DomainError(
        `no workspace configured for "${quarantineWorkspaceName}" — cannot verify repair`,
      );
    }
    try {
      verifyWorkspaceClean(target);
    } catch (err) {
      throw new DomainError(err instanceof Error ? err.message : String(err));
    }
    if (deps.boardState) {
      const overlap = boardStateOverlap(target.path, deps.boardState);
      if (overlap) throw new DomainError(overlap.reason);
    }
  }

  const quarantineAgentName = task.question_quarantine_agent;
  if (quarantineAgentName !== null) {
    try {
      verifyAgentRepaired(
        deps.db,
        quarantineAgentName,
        deps.agentRegistered?.(quarantineAgentName) ?? false,
      );
    } catch (err) {
      throw new DomainError(err instanceof Error ? err.message : String(err));
    }
  }

  if (task.question_quarantine_sandbox !== null && deps.containment) {
    const capability = await deps.containment();
    if (!capability.available) {
      throw new DomainError(
        `worker containment is still not established: ${capability.reason}`,
      );
    }
  }

  // An answer during triage is durable immediately, but its parent unblock is
  // staged until commit. The activity touch also defers triage auto-commit.
  const session = triageActivity(deps.db, now());
  const { question, parentUnblocked, pickupResumed } = answerQuestion(
    deps.db,
    task,
    answers,
    now(),
    session && ((taskId) => stageFrontInsert(deps.db, session.id, taskId)),
    comment,
  );
  if (wantsMerge) {
    appendEvent(deps.db, {
      taskId: task.id,
      workerId: HUMAN_WORKER_ID,
      payload: { kind: "pr_merged", pr_number: mergePr! },
      at: now(),
    });
  }
  // Giving up promotion otherwise leaves no trace beyond a settled question;
  // preserve the reason on the immutable decision log of that question.
  if (promotionTaskId !== null && answers[0] === PR_PROMOTION_FAILURE_OPTIONS[1]) {
    logDecision(
      deps.db,
      question,
      `PR promotion abandoned for task ${promotionTaskId} — the work stays on its task branch, no PR`,
      HUMAN_WORKER_ID,
      now(),
    );
  }
  // An unblocked parent or reinstated quarantined resource can make the queue
  // head pickable immediately. During triage, staging keeps both flags false.
  if (parentUnblocked || pickupResumed) deps.onQueueHeadChanged();
  return question;
}
