import { verifyAgentRepaired } from "./agent.js";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import type { ContainmentCheck } from "./containment.js";
import type { Db } from "./db.js";
import type { DraftClient } from "./draft.js";
import { appendEvent, type EventOrigin } from "./events.js";
import { type GitHubClient, IssueGoneError } from "./github.js";
import type { RegistryReachabilityCheck } from "./registry.js";
import {
  answerQuestion,
  assertAnswerable,
  assertNoUnsettledIssueRef,
  type CancelDefaults,
  DomainError,
  getTask,
  HUMAN_WORKER_ID,
  hasUnfinishedChildren,
  humanDecomposeTask,
  latestChild,
  logDecision,
  MERGE_QUESTION_OPTIONS,
  PR_PROMOTION_FAILURE_OPTIONS,
  type RegisterTaskInput,
  registerTask,
  type Task,
} from "./tasks.js";
import { stageFrontInsert, triageActivity } from "./triage.js";
import {
  buildWorkspaceResolver,
  mergeTaskToProtected,
  quarantineWorkspace,
  UnknownWorkspaceError,
  verifyWorkspaceClean,
  type WorkspaceConfig,
} from "./workspace.js";

export interface RegisterThroughHumanDoorDeps {
  db: Db;
  agentRegistered?: (name: string) => boolean;
  draftClient?: DraftClient;
  github?: GitHubClient;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  isProtectedWorkspace?: (name: string) => boolean;
}

export interface HumanRegisterInput extends RegisterTaskInput {
  decompose_reason?: string;
}

export type GateFailure =
  | { kind: "invalid"; error: string }
  | { kind: "not_found"; error: string }
  | { kind: "issue_unavailable"; error: string }
  | { kind: "inspection_unavailable"; error: string }
  | {
      kind: "issue_rejected";
      error: string;
      missing: string;
      suggested_comment: string;
    };

export type RegisterThroughHumanDoorResult =
  | { ok: true; task: Task }
  | { ok: false; failure: GateFailure };

export type IssueCommentFailure =
  | { kind: "invalid"; error: string }
  | { kind: "not_configured"; error: string }
  | { kind: "unknown_workspace"; error: string }
  | { kind: "github_failed"; error: string };

/** Shared human-surface GitHub issue-comment write. */
export async function addIssueCommentThroughHumanDoor(
  deps: Pick<RegisterThroughHumanDoorDeps, "github" | "workspace" | "resolveWorkspace">,
  input: { workspace: string; github_issue_number: number; body: string },
): Promise<{ ok: true } | { ok: false; failure: IssueCommentFailure }> {
  if (
    input.workspace.length === 0 ||
    !Number.isInteger(input.github_issue_number) ||
    input.github_issue_number <= 0 ||
    input.body.length === 0
  ) {
    return {
      ok: false,
      failure: { kind: "invalid", error: "an issue comment requires a workspace, positive issue number, and body" },
    };
  }
  const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
  if (!deps.github || !resolve) {
    return {
      ok: false,
      failure: { kind: "not_configured", error: "GitHub or workspace tracking not configured" },
    };
  }
  let path: string;
  try {
    path = resolve(input.workspace).path;
  } catch (err) {
    if (!(err instanceof UnknownWorkspaceError)) throw err;
    return {
      ok: false,
      failure: { kind: "unknown_workspace", error: `unknown workspace: ${input.workspace}` },
    };
  }
  try {
    await deps.github.addIssueComment(
      { path, number: input.github_issue_number },
      input.body,
    );
    return { ok: true };
  } catch {
    return {
      ok: false,
      failure: { kind: "github_failed", error: "could not post the comment to the issue" },
    };
  }
}

export function assertAssigneeKnown(
  agentRegistered: ((name: string) => boolean) | undefined,
  assignee: string | undefined,
): void {
  if (
    assignee !== undefined &&
    assignee !== HUMAN_WORKER_ID &&
    agentRegistered &&
    !agentRegistered(assignee)
  ) {
    throw new DomainError(`unknown agent: ${assignee}`);
  }
}

export function assertWorkspaceKnown(
  workspaceName: string,
  resolveWorkspace: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined,
  workspace: WorkspaceConfig | undefined,
): void {
  const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
  if (!resolve) return;
  try {
    resolve(workspaceName);
  } catch (err) {
    if (!(err instanceof UnknownWorkspaceError)) throw err;
    throw new DomainError(`unknown workspace: ${workspaceName}`);
  }
}

/**
 * 人間名義の task 登録を実行する正準の application seam。
 * WebUI と管理 MCP は transport の違いだけを持ち、この門を共有する。
 */
export async function registerThroughHumanDoor(
  deps: RegisterThroughHumanDoorDeps,
  input: HumanRegisterInput,
  now: () => Date,
  origin: EventOrigin = "webui",
): Promise<RegisterThroughHumanDoorResult> {
  try {
    if (input.type !== "work" && input.type !== "review") {
      throw new DomainError("a human can register only work or review tasks");
    }
    const isHumanDecomposeChild = input.parent_id !== undefined && input.type === "work";
    if (isHumanDecomposeChild && input.github_issue_number !== undefined) {
      throw new DomainError("a child task cannot be issue-backed");
    }
    if (input.workspace !== undefined) {
      assertWorkspaceKnown(input.workspace, deps.resolveWorkspace, deps.workspace);
    }
    assertAssigneeKnown(deps.agentRegistered, input.assignee);
    if (input.github_issue_number !== undefined && input.workspace) {
      assertNoUnsettledIssueRef(deps.db, input.workspace, input.github_issue_number);
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      if (deps.github && resolve) {
        let issue;
        try {
          issue = await deps.github.getIssue({
            path: resolve(input.workspace).path,
            number: input.github_issue_number,
          });
        } catch (err) {
          if (err instanceof IssueGoneError) throw new DomainError(err.message);
          return {
            ok: false,
            failure: {
              kind: "issue_unavailable",
              error: "could not fetch the referenced issue",
            },
          };
        }
        if (deps.draftClient) {
          let inspection;
          try {
            inspection = await deps.draftClient.inspectIssue(issue);
          } catch {
            return {
              ok: false,
              failure: { kind: "inspection_unavailable", error: "LLM inspection failed" },
            };
          }
          if (!inspection.ok) {
            return {
              ok: false,
              failure: {
                kind: "issue_rejected",
                error: "the referenced issue fails the registration gate",
                missing: inspection.missing,
                suggested_comment: inspection.suggested_comment,
              },
            };
          }
        }
      }
    }
    if (isHumanDecomposeChild) {
      if (input.decompose_reason === undefined || input.decompose_reason.length === 0) {
        throw new DomainError("a decomposition requires a reason");
      }
      const parent = getTask(deps.db, input.parent_id!);
      if (!parent) {
        return {
          ok: false,
          failure: { kind: "not_found", error: "parent task not found" },
        };
      }
      const children = humanDecomposeTask(
        deps.db,
        parent,
        {
          reason: input.decompose_reason,
          children: [
            {
              title: input.title ?? "",
              purpose: input.purpose ?? "",
              completion_criteria: input.completion_criteria ?? "",
              assignee: input.assignee,
              workspace: input.workspace,
              risk_flag: input.risk_flag,
              review_flag: input.review_flag,
            },
          ],
        },
        now(),
        deps.isProtectedWorkspace,
        origin,
      );
      const task = children[0] ?? latestChild(deps.db, parent.id);
      if (!task) throw new Error("human decompose did not register a child or approval question");
      return { ok: true, task };
    }
    return { ok: true, task: registerTask(deps.db, input, now(), HUMAN_WORKER_ID, origin) };
  } catch (err) {
    if (err instanceof DomainError) {
      return { ok: false, failure: { kind: "invalid", error: err.message } };
    }
    throw err;
  }
}

export interface SubmitAnswerDeps {
  db: Db;
  onQueueHeadChanged: () => void;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  github?: GitHubClient;
  retryPrPromotion?: (task: Task) => Promise<void>;
  agentRegistered?: (name: string) => boolean;
  containment?: ContainmentCheck;
  registryReachability?: RegistryReachabilityCheck;
  boardState?: BoardStatePath[];
}

/** Shared human-surface defaults for direct cancel's quarantine-question gate. */
export function humanCancelDefaults(
  workspace: WorkspaceConfig | undefined,
  defaultAgentName: string | undefined,
  auditorName: string | undefined,
): CancelDefaults {
  return {
    defaultWorkspaceName: workspace?.name,
    defaultAgentName,
    auditorName,
  };
}

/** A settled child can make its parent immediately pickable on either human surface. */
export function pollIfParentUnblocked(db: Db, task: Task, onQueueHeadChanged: () => void): void {
  if (!task.parent_id) return;
  const parent = getTask(db, task.parent_id);
  if (parent && parent.status === "todo" && !hasUnfinishedChildren(db, parent.id)) {
    onQueueHeadChanged();
  }
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
  origin: EventOrigin = "webui",
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

  const localMergeTaskId = task.question_pending_local_merge_task_id;
  const wantsLocalMerge =
    localMergeTaskId !== null && answers[0] === MERGE_QUESTION_OPTIONS[0];
  if (wantsLocalMerge) {
    const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
    if (!resolve) {
      throw new DomainError("no workspace configured — cannot land the task branch");
    }
    let mergeWorkspace: WorkspaceConfig;
    try {
      mergeWorkspace = resolve(task.workspace);
    } catch (err) {
      if (!(err instanceof UnknownWorkspaceError)) throw err;
      throw new DomainError(
        `no workspace configured for "${err.workspaceName}" — cannot land the task branch`,
      );
    }
    try {
      mergeTaskToProtected(mergeWorkspace, localMergeTaskId);
    } catch (err) {
      quarantineWorkspace(deps.db, mergeWorkspace.name, err, now());
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

  if (task.question_quarantine_registry !== null && deps.registryReachability) {
    const reachability = await deps.registryReachability();
    if (!reachability.available) {
      throw new DomainError(
        `registry remote is still unreachable: ${reachability.reason ?? "refresh failed"}`,
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
    origin,
  );
  if (wantsMerge) {
    appendEvent(deps.db, {
      taskId: task.id,
      workerId: HUMAN_WORKER_ID,
      origin,
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
      origin,
    );
  }
  // An unblocked parent or reinstated quarantined resource can make the queue
  // head pickable immediately. During triage, staging keeps both flags false.
  if (parentUnblocked || pickupResumed) deps.onQueueHeadChanged();
  return question;
}
