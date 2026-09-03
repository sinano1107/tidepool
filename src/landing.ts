import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import type { GitHubClient } from "./github.js";
import type { AuthorityProfile } from "./registry.js";
import {
  BOARD_WORKER_ID,
  clearPendingAutoMerge,
  contentSourceFor,
  countUnsettledAttachedChildren,
  DEFAULT_AUDITOR_NAME,
  DomainError,
  getTask,
  HUMAN_WORKER_ID,
  listOpenMergeQuestions,
  listPendingAutoMerges,
  recordLandingDeferred,
  recordPrOpened,
  registerLocalMergeQuestion,
  registerMergeQuestion,
  registerPrPromotionFailureQuestion,
  resolveTaskAgent,
  settleMergeQuestionAsObserved,
  settlePrPromotionQuestionsAsObserved,
  subtreeSql,
  type Task,
  taskIdForPr,
} from "./tasks.js";
import { activeTriageSession } from "./triage.js";
import {
  branchMergeEffect,
  buildWorkspaceResolver,
  catchUpTaskBranch,
  isRemoteBacked,
  protectedBranch,
  protectedBranchRef,
  rebaselineRef,
  resolveOrQuarantine,
  resolveTaskBranchLineage,
  taskBranch,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "./workspace.js";

export type LandingVerdict =
  | { kind: "not_applicable"; reason: "not_work" | "ancestor_branch" }
  | { kind: "nothing_to_land"; base: string }
  | { kind: "deferred"; reason: LandingBlock["kind"]; count: number }
  | {
      kind: "landed";
      surface: "local_merge_question" | "pull_request_opened" | "open_pull_request_updated";
      prNumber?: number;
    }
  | {
      kind: "failed";
      reason:
        | "workspace_unavailable"
        | "workspace_needs_human"
        | "github_not_configured"
        | "pull_request_already_merged"
        | "promotion_failed";
      error: string;
    };

export type LandingBlock = { kind: "attached_children" | "objections"; count: number };

function countUnbundledObjections(db: Db, taskId: string): number {
  const open = activeTriageSession(db);
  if (!open) return 0;
  const { n } = db
    .prepare(
      `${subtreeSql("?")}
       SELECT COUNT(*) AS n FROM events
        WHERE kind = 'objection_raised'
          AND json_extract(payload, '$.session_id') = ?
          AND task_id IN (SELECT id FROM subtree)`,
    )
    .get(taskId, open.id) as { n: number };
  return n;
}

function taskHasLanded(db: Db, taskId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM events
                                 WHERE task_id = ? AND kind IN ('pr_opened', 'nothing_to_land'))
                  OR EXISTS (SELECT 1 FROM tasks WHERE question_pending_local_merge_task_id = ?)`,
      )
      .get(taskId, taskId) !== undefined
  );
}

export function landingBlock(db: Db, taskId: string): LandingBlock | null {
  const attached = countUnsettledAttachedChildren(db, taskId);
  if (attached > 0) return { kind: "attached_children", count: attached };
  const objections = countUnbundledObjections(db, taskId);
  return objections > 0 ? { kind: "objections", count: objections } : null;
}

export function landingAnnotation(
  db: Db,
  task: Pick<
    Task,
    "question_pending_local_merge_task_id" | "question_pending_merge_pr" | "workspace"
  >,
): { blocked_by: LandingBlock["kind"] | null } | null {
  const local = task.question_pending_local_merge_task_id;
  const pr = task.question_pending_merge_pr;
  if (local === null && pr === null) return null;
  let landingTaskId: string;
  try {
    landingTaskId = local ?? taskIdForPr(db, pr as number, task.workspace);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { blocked_by: "attached_children" };
  }
  return { blocked_by: landingBlock(db, landingTaskId)?.kind ?? null };
}

export interface Landing {
  land(task: Task, excludePrPromotionQuestionId?: string): Promise<LandingVerdict>;
  relandAncestors(
    settled: Task,
  ): Promise<Array<{ taskId: string; verdict: LandingVerdict }>>;
  observeMergedPullRequest(question: Task): Promise<boolean>;
  tick(kind: "auto_merge" | "outside_merge", now: Date): Promise<void>;
}

export interface LandingDeps {
  db: Db;
  clock: Clock;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  github: GitHubClient | null;
  authority?: AuthorityProfile;
  resolveAuthority?: (assignee: string | null) => AuthorityProfile | undefined;
  defaultAgentName?: string;
  auditorName?: string;
  isProtectedWorkspace?: (name: string) => boolean;
}

type LandingFailureReason = Extract<LandingVerdict, { kind: "failed" }>["reason"];

const LANDING_NOTICE =
  "This PR was opened by the tidepool board after the task completed. The handoff doc " +
  "above was written by the worker before PR promotion, so it does not reflect landing " +
  "state (push / PR / merge).";

function prBody(handoffDoc: string | null, githubIssueNumber: number | null): string {
  const doc = handoffDoc ?? "";
  const withNotice = doc ? `${doc}\n\n${LANDING_NOTICE}` : LANDING_NOTICE;
  return githubIssueNumber == null ? withNotice : `${withNotice}\n\nCloses #${githubIssueNumber}`;
}

/** ADR 0073 / ADR 0105: the landing module owns the completed-root decision;
 *  workspace only supplies the generic content comparison shared with pickup. */
function taskHasContentToLand(workspace: WorkspaceConfig, taskId: string): boolean {
  return branchMergeEffect(
    workspace,
    protectedBranchRef(workspace),
    taskBranch(taskId),
  ).changesCandidate;
}

export function createLanding(deps: LandingDeps): Landing {
  const retireFailures = (taskId: string, excludeQuestionId?: string) =>
    settlePrPromotionQuestionsAsObserved(
      deps.db,
      taskId,
      deps.clock.now(),
      excludeQuestionId,
    );
  const failed = (
    task: Task,
    reason: LandingFailureReason,
    error: unknown,
    excludePrPromotionQuestionId?: string,
  ): Extract<LandingVerdict, { kind: "failed" }> => {
    const message = error instanceof Error ? error.message : String(error);
    if (excludePrPromotionQuestionId === undefined) {
      registerPrPromotionFailureQuestion(deps.db, task, message, deps.clock.now());
    }
    return { kind: "failed", reason, error: message };
  };
  const landing: Landing = {
    async land(task, excludePrPromotionQuestionId) {
      if (task.type !== "work") return { kind: "not_applicable", reason: "not_work" };
      let landedBefore = false;
      try {
        landedBefore = taskHasLanded(deps.db, task.id);
        const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
        if (!resolve) {
          return failed(
            task,
            "workspace_unavailable",
            "no workspace is configured for landing",
            excludePrPromotionQuestionId,
          );
        }
        const workspace = resolveOrQuarantine(
          deps.db,
          resolve,
          task.workspace,
          deps.clock.now(),
        );
        if (!workspace) {
          return failed(
            task,
            "workspace_unavailable",
            "workspace is unavailable for landing",
            excludePrPromotionQuestionId,
          );
        }
        const lineage = resolveTaskBranchLineage(deps.db, workspace, task);
        if (lineage.branch) {
          return { kind: "not_applicable", reason: "ancestor_branch" };
        }
        if (workspaceNeedsHuman(deps.db, workspace.name)) {
          return failed(
            task,
            "workspace_needs_human",
            `workspace "${workspace.name}" needs human attention before landing`,
            excludePrPromotionQuestionId,
          );
        }
        if (!taskHasContentToLand(workspace, task.id)) {
          const base = protectedBranchRef(workspace);
          if (task.pr_number === null) {
            appendEvent(deps.db, {
              taskId: task.id,
              workerId: BOARD_WORKER_ID,
              origin: "board",
              payload: { kind: "nothing_to_land", base },
              at: deps.clock.now(),
            });
          }
          retireFailures(task.id, excludePrPromotionQuestionId);
          return { kind: "nothing_to_land", base };
        }
        const block = landingBlock(deps.db, task.id);
        if (block) {
          recordLandingDeferred(deps.db, task.id, block, deps.clock.now());
          return { kind: "deferred", reason: block.kind, count: block.count };
        }
        if (!isRemoteBacked(workspace)) {
          const purpose =
            (deps.resolveAuthority?.(task.assignee) ?? deps.authority)?.merge ===
            "auto_if_ci_green"
              ? `Workspace "${workspace.name}" is purely-local, so CI cannot be observed and ` +
                `auto_if_ci_green cannot auto-merge "${task.title}". Land its task branch on the ` +
                `protected branch now?`
              : `Workspace "${workspace.name}" is purely-local and has no GitHub merge surface ` +
                `for "${task.title}". Land its task branch on the protected branch now?`;
          registerLocalMergeQuestion(deps.db, task, purpose, deps.clock.now());
          retireFailures(task.id, excludePrPromotionQuestionId);
          return { kind: "landed", surface: "local_merge_question" };
        }
        if (!deps.github) {
          return failed(
            task,
            "github_not_configured",
            "GitHub is not configured for PR promotion",
            excludePrPromotionQuestionId,
          );
        }
        if (lineage.outlivedForkSource && catchUpTaskBranch(workspace, task.id)) {
          rebaselineRef(deps.db, workspace, `refs/heads/${taskBranch(task.id)}`);
        }
        if (task.pr_number !== null) {
          if (
            await deps.github.isPullRequestMerged({
              path: workspace.path,
              number: task.pr_number,
            })
          ) {
            return failed(
              task,
              "pull_request_already_merged",
              `PR #${task.pr_number} is already merged, but merge-backed repair work on ` +
                `${taskBranch(task.id)} still has content to land`,
              excludePrPromotionQuestionId,
            );
          }
          await deps.github.pushBranch({ path: workspace.path, branch: taskBranch(task.id) });
          rebaselineRef(
            deps.db,
            workspace,
            `refs/remotes/origin/${taskBranch(task.id)}`,
          );
          retireFailures(task.id, excludePrPromotionQuestionId);
          return {
            kind: "landed",
            surface: "open_pull_request_updated",
            prNumber: task.pr_number,
          };
        }
        const { title } = await contentSourceFor(task, deps.github, () => workspace?.path).expand();
        let pr: Awaited<ReturnType<GitHubClient["createPullRequest"]>>;
        try {
          pr = await deps.github.createPullRequest({
            path: workspace.path,
            branch: taskBranch(task.id),
            base: protectedBranch(workspace),
            title,
            body: prBody(task.handoff_doc, task.github_issue_number),
          });
        } finally {
          rebaselineRef(
            deps.db,
            workspace,
            `refs/remotes/origin/${taskBranch(task.id)}`,
          );
        }
        const authority = deps.resolveAuthority?.(task.assignee) ?? deps.authority;
        recordPrOpened(
          deps.db,
          task,
          pr.number,
          resolveTaskAgent(
            task,
            deps.defaultAgentName ?? HUMAN_WORKER_ID,
            deps.auditorName ?? DEFAULT_AUDITOR_NAME,
          ),
          deps.clock.now(),
          authority,
          deps.isProtectedWorkspace?.(workspace.name),
          "worker",
        );
        retireFailures(task.id, excludePrPromotionQuestionId);
        return { kind: "landed", surface: "pull_request_opened", prNumber: pr.number };
      } catch (error) {
        const landed = getTask(deps.db, task.id);
        if (!landedBefore && landed && taskHasLanded(deps.db, task.id)) {
          retireFailures(task.id, excludePrPromotionQuestionId);
          return landed.pr_number === null
            ? { kind: "landed", surface: "local_merge_question" }
            : {
                kind: "landed",
                surface: "pull_request_opened",
                prNumber: landed.pr_number,
              };
        }
        return failed(task, "promotion_failed", error, excludePrPromotionQuestionId);
      }
    },
    async relandAncestors(settled) {
      const results: Array<{ taskId: string; verdict: LandingVerdict }> = [];
      for (
        let ancestor = settled.parent_id ? getTask(deps.db, settled.parent_id) : undefined;
        ancestor;
        ancestor = ancestor.parent_id ? getTask(deps.db, ancestor.parent_id) : undefined
      ) {
        if (ancestor.type !== "work" || ancestor.status !== "done") continue;
        if (taskHasLanded(deps.db, ancestor.id) && ancestor.pr_number === null) continue;
        results.push({ taskId: ancestor.id, verdict: await landing.land(ancestor) });
      }
      return results;
    },
    async observeMergedPullRequest(question) {
      const prNumber = question.question_pending_merge_pr;
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      if (prNumber === null || !resolve || !deps.github) return false;
      try {
        const workspace = resolve(question.workspace);
        if (!(await deps.github.isPullRequestMerged({ path: workspace.path, number: prNumber }))) {
          return false;
        }
        settleMergeQuestionAsObserved(deps.db, question.id, prNumber, deps.clock.now());
        return true;
      } catch {
        return false;
      }
    },
    async tick(kind, now) {
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      const github = deps.github;
      if (!resolve || !github) return;
      if (kind === "outside_merge") {
        for (const { id, pr_number, workspace: taskWorkspace } of listOpenMergeQuestions(
          deps.db,
        )) {
          const workspace = resolveOrQuarantine(deps.db, resolve, taskWorkspace, now);
          if (!workspace) continue;
          try {
            if (
              await github.isPullRequestMerged({ path: workspace.path, number: pr_number })
            ) {
              settleMergeQuestionAsObserved(deps.db, id, pr_number, now);
            }
          } catch {}
        }
        return;
      }
      for (const { task_id, pr_number } of listPendingAutoMerges(deps.db)) {
        const task = getTask(deps.db, task_id);
        if (!task) continue;
        const workspace = resolveOrQuarantine(deps.db, resolve, task.workspace, now);
        if (!workspace || landingBlock(deps.db, task_id)) continue;
        const status = await github.getCiStatus({ path: workspace.path, number: pr_number });
        if (status === "pending") continue;
        if (status === "success") {
          if (landingBlock(deps.db, task_id)) continue;
          let observed = false;
          try {
            await github.mergePullRequest({ path: workspace.path, number: pr_number });
          } catch (error) {
            if (
              !(await github.isPullRequestMerged({ path: workspace.path, number: pr_number }))
            ) {
              throw error;
            }
            observed = true;
          }
          clearPendingAutoMerge(deps.db, task_id);
          appendEvent(deps.db, {
            taskId: task_id,
            workerId: observed ? BOARD_WORKER_ID : HUMAN_WORKER_ID,
            origin: "board",
            payload: observed
              ? { kind: "pr_merge_observed", pr_number }
              : { kind: "pr_merged", pr_number },
            at: now,
          });
          continue;
        }
        clearPendingAutoMerge(deps.db, task_id);
        registerMergeQuestion(
          deps.db,
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
    },
  };
  return landing;
}
