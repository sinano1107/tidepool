import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { DEFAULT_AUDITOR_NAME } from "./defaults.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, latestEventOfTask } from "./events.js";
import { git } from "./git.js";
import type { GitHubClient } from "./github.js";
import { registerQuarantine } from "./quarantine.js";
import { type AuthorityProfile, InvalidAgentDefinitionError, UnknownAgentError } from "./registry.js";
import {
  contentSourceFor,
  countUnsettledAttachedChildren,
  getTask,
  isLandingQuestion,
  landingSurface,
  MERGE_QUESTION_OPTIONS,
  PR_PROMOTION_FAILURE_OPTIONS,
  recordPrOpened,
  registerMergeQuestion,
  registerTask,
  resolveTaskAgent,
  settleQuestionAsObserved,
  subtreeSql,
  type Task,
  taskIdForPr,
  typeAwareDefaultAgentSql,
} from "./tasks.js";
import { activeTriageSession } from "./triage.js";
import { BOARD_WORKER_ID } from "./worker-id.js";
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
      form: "local_merge_question" | "pull_request_opened" | "open_pull_request_updated";
      prNumber?: number;
    }
  | {
      kind: "failed";
      reason:
        | "workspace_unavailable"
        | "workspace_needs_human"
        | "agent_unavailable"
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

/** 着地を待つ完了タスクを agent 名の参照で数える(ADR 0217 決定4)—— agent 名の quarantine の解除と
 *  agent 削除の扉。集合の定義は `countAwaitingLanding` にある。 */
export function countTasksAwaitingLanding(
  db: Db,
  agentName: string,
  defaultAgentName?: string,
  auditorName?: string,
): number {
  const fallback = typeAwareDefaultAgentSql("t.type", "@defaultAgentName", "@auditorName");
  return countAwaitingLanding(db, `COALESCE(t.assignee, ${fallback}) = @agentName`, {
    agentName,
    defaultAgentName: defaultAgentName ?? null,
    auditorName: auditorName ?? null,
  });
}

/** 同じ集合を、タスクの `workspace` の参照で数える —— workspace の削除の扉(ADR 0226)。 */
export function countTasksAwaitingLandingInWorkspace(db: Db, workspaceName: string): number {
  return countAwaitingLanding(db, "t.workspace = @workspaceName", { workspaceName });
}

/** 着地を待つ完了タスク(ADR 0217 決定4 / ADR 0226): agent 名の quarantine の解除と
 *  agent 削除の扉は agent 名で、workspace の削除の扉はタスクの `workspace` で、同じ集合を数える。
 *  「未着地の done」だけでは、祖先の枝に乗る子(`land()` は何も記録しない)と PR 昇格を
 *  abandon したタスクを永久に数えてしまうので、待っている積極的な証拠で数える ——
 *  無人 merge キューにいる、または未着地で、PR 昇格失敗の question が開いているか、門で止まった
 *  記録があって昇格を abandon していない。`landing_deferred` は1タスクに1回しか刻まれないので、
 *  retry が再び門で止まった場合も記録は最初の1つのままである —— 失敗 question が立ったこと
 *  ではなく、abandon と答えたことだけを待ちの終わりに数える。 */
function countAwaitingLanding(db: Db, referenceSql: string, params: Record<string, string | null>): number {
  const rows = db
    .prepare(
      `SELECT t.id, EXISTS (SELECT 1 FROM pending_auto_merges WHERE task_id = t.id) AS queued
         FROM tasks t
        WHERE t.type = 'work' AND t.status = 'done'
          AND ${referenceSql}
          AND (queued
               OR EXISTS (SELECT 1 FROM tasks q
                           WHERE q.question_pending_pr_promotion_task_id = t.id AND q.status = 'todo')
               OR (EXISTS (SELECT 1 FROM events d
                            WHERE d.task_id = t.id AND d.kind = 'landing_deferred')
                   AND NOT EXISTS (SELECT 1 FROM tasks q
                                     JOIN events a ON a.task_id = q.id AND a.kind = 'question_answered'
                                    WHERE q.question_pending_pr_promotion_task_id = t.id
                                      AND json_extract(a.payload, '$.answers[0].answer') = @abandon)))`,
    )
    .all({ ...params, abandon: PR_PROMOTION_FAILURE_OPTIONS[1] }) as Array<{ id: string; queued: number }>;
  return rows.filter((row) => row.queued === 1 || !taskHasLanded(db, row.id)).length;
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
  if (!isLandingQuestion(task)) return null;
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
  observeMergedAutoMerges(agentName: string): Promise<void>;
  tick(kind: "auto_merge" | "outside_merge", now: Date): Promise<void>;
}

export interface LandingDeps {
  db: Db;
  clock: Clock;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  github: GitHubClient | null;
  resolveAuthority?: (assignee: string | null) => AuthorityProfile | undefined;
  defaultAgentName: string;
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

/** A PR promotion failure never rolls back completion or the tree rule (issue
 *  #19). It instead leaves a Tidepool-owned question whose retry points back
 *  to the completed task, where its branch and handoff still live. */
export function registerPrPromotionFailureQuestion(
  db: Db,
  task: Task,
  error: string,
  now: Date,
): void {
  registerPrPromotionQuestion(
    db,
    task,
    `PR promotion failed: ${task.title}`,
    `Creating a PR for completed task "${task.title}" failed: ${error}`,
    now,
  );
}

function registerPrPromotionQuestion(
  db: Db,
  task: Task,
  title: string,
  purpose: string,
  now: Date,
): void {
  registerTask(
    db,
    {
      type: "question",
      title,
      purpose,
      completion_criteria: "a human decides whether to retry PR promotion",
      question: [
        {
          title,
          options: [...PR_PROMOTION_FAILURE_OPTIONS],
          recommendation: "retry",
        },
      ],
      pending_pr_promotion_task_id: task.id,
      workspace: task.workspace ?? undefined,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}

function hasOpenPrPromotionQuestion(db: Db, taskId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM tasks WHERE question_pending_pr_promotion_task_id = ? AND status = 'todo'")
      .get(taskId) !== undefined
  );
}

/** ADR 0225 決定1: abandon promotion が断念した内容として、回答の時点のタスクブランチの head を
 *  盤面名義で刻む。workspace もブランチも読めなければ null で刻み、回答は拒まない。 */
export function recordPrPromotionAbandoned(
  db: Db,
  resolve: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined,
  taskWorkspace: string | null,
  taskId: string,
  now: Date,
): void {
  let head: string | null = null;
  try {
    if (resolve) {
      head = git(resolve(taskWorkspace).path, "rev-parse", "--verify", "--quiet", `refs/heads/${taskBranch(taskId)}`);
    }
  } catch {}
  appendEvent(db, {
    taskId,
    workerId: BOARD_WORKER_ID,
    origin: "board",
    payload: { kind: "pr_promotion_abandoned", head },
    at: now,
  });
}

/** ADR 0079 決定3/4: retires a merge question whose PR turned out to be
 *  already merged outside the board. Deliberately not `answerQuestion`:
 *  nobody decided anything, so there is no `question_answered` event, no
 *  recorded option, and no recommendation-acceptance statistic — a "hold"
 *  submitted against an already-merged PR must never read back as a hold
 *  decision. Settles only a still-open question — the merged check is an
 *  awaited network read, so another path can settle it in that window, and
 *  a second observation must not re-stamp an already-closed question. */
function settleMergeQuestionAsObserved(
  db: Db,
  questionId: string,
  prNumber: number,
  now: Date,
): void {
  settleQuestionAsObserved(db, questionId, { kind: "pr_merge_observed", pr_number: prNumber }, now);
}

/** ADR 0092 決定3 の再発火が着地を成立させたら、同じタスクを指す PR 昇格失敗の
 *  question はもう誰にも訊くことがない(issue #406)。開いたままにすると `retry` が
 *  既に開いている PR へ `gh pr create` を撃ち、`abandon promotion` は「PR は無い」と
 *  事実と逆の決定を記録する。引退は上と同じ観測決着 —— 再発火は人間の決定ではない。
 *  再発火が二度失敗して失敗 question が積み上がっている場合もあるので、todo の行は
 *  すべて引退させる。 */
function settlePrPromotionQuestionsAsObserved(
  db: Db,
  taskId: string,
  now: Date,
  excludeQuestionId?: string,
): void {
  const rows = db
    .prepare(
      `SELECT id FROM tasks
        WHERE question_pending_pr_promotion_task_id = ? AND status = 'todo' AND id <> ?`,
    )
    .all(taskId, excludeQuestionId ?? "") as Array<{ id: string }>;
  for (const { id } of rows) {
    settleQuestionAsObserved(db, id, { kind: "pr_promotion_observed" }, now);
  }
}

/** ADR 0053 decision 3: a purely-local root completion cannot be promoted to a PR, so
 *  the board asks whether to fast-forward its task branch onto the protected
 *  branch or leave it there permanently. The task id is deliberately stored
 *  separately from question_pending_merge_pr: one names a local branch while
 *  the other names a GitHub PR. */
export function registerLocalMergeQuestion(
  db: Db,
  task: Task,
  purpose: string,
  now: Date,
): void {
  const title = `land completed task: ${task.title}`;
  registerTask(
    db,
    {
      type: "question",
      title,
      purpose,
      completion_criteria: "a human decides whether to land the completed task branch",
      question: [{ title, options: [...MERGE_QUESTION_OPTIONS], recommendation: "merge" }],
      pending_local_merge_task_id: task.id,
      workspace: task.workspace ?? undefined,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}

interface PendingAutoMerge {
  task_id: string;
  pr_number: number;
}

function listPendingAutoMerges(db: Db): PendingAutoMerge[] {
  return db
    .prepare("SELECT task_id, pr_number FROM pending_auto_merges")
    .all() as PendingAutoMerge[];
}

/** The merge decisions the board still holds (ADR 0079 決定3) — the slow
 *  outside-merge scan's whole reading list. `external` never registers one,
 *  so a dial that declared the merge outside the board is out of scope by
 *  construction, not by a filter that could drift. Empty means the scan makes
 *  no network call at all. */
interface OpenMergeQuestion {
  id: string;
  pr_number: number;
  workspace: string | null;
}

function listOpenMergeQuestions(db: Db): OpenMergeQuestion[] {
  return db
    .prepare(
      `SELECT id, question_pending_merge_pr AS pr_number, workspace FROM tasks
       WHERE type = 'question' AND status = 'todo' AND question_pending_merge_pr IS NOT NULL`,
    )
    .all() as OpenMergeQuestion[];
}

function clearPendingAutoMerge(db: Db, taskId: string): void {
  db.prepare("DELETE FROM pending_auto_merges WHERE task_id = ?").run(taskId);
}

/** キューの PR が merge された(盤面が merge した、または盤面の外での merge を観測した)ので
 *  キューから外し、その事実を盤面の名義で残す。 */
function retireMergedAutoMerge(
  db: Db,
  taskId: string,
  payload: { kind: "pr_merged" | "pr_merge_observed"; pr_number: number },
  now: Date,
): void {
  clearPendingAutoMerge(db, taskId);
  appendEvent(db, { taskId, workerId: BOARD_WORKER_ID, origin: "board", payload, at: now });
}

function isQueuedForAutoMerge(db: Db, taskId: string): boolean {
  return db.prepare("SELECT 1 FROM pending_auto_merges WHERE task_id = ?").get(taskId) !== undefined;
}

/** 門で止まったことを board 名義で1回だけ刻む(ADR 0092 決定1)。着地は1つのタスクに
 *  つき一度きりなので、「この待ちで既に刻んだか」は「このタスクに landing_deferred が
 *  あるか」で足りる — 付帯子が決着するたびの再検査で重複させない。 */
function recordLandingDeferred(
  db: Db,
  taskId: string,
  block: { kind: "attached_children" | "objections"; count: number },
  now: Date,
): void {
  if (latestEventOfTask(db, taskId, "landing_deferred")) return;
  appendEvent(db, {
    taskId,
    workerId: BOARD_WORKER_ID,
    origin: "board",
    payload: { kind: "landing_deferred", reason: block.kind, count: block.count },
    at: now,
  });
}

export function createLanding(deps: LandingDeps): Landing {
  /** ADR 0217 決定3: 解決できない profile はダイヤルを推測せず、agent 名の quarantine に落として
   *  undefined を返す。registry の無い盤面(resolver 無し)は profile 無しで解決する。 */
  const readAuthority = (task: Task, now: Date): { profile: AuthorityProfile | undefined } | undefined => {
    try {
      return { profile: deps.resolveAuthority?.(task.assignee) };
    } catch (err) {
      if (!(err instanceof UnknownAgentError) && !(err instanceof InvalidAgentDefinitionError)) throw err;
      registerQuarantine(deps.db, "agent", err.agentName, err.message, now);
      return undefined;
    }
  };
  /** ADR 0217 決定1・2: いま着地しても無人 merge キューに入るかを読み直し、入らなければ
   *  キューから外して変わった先の面へ渡す。読み直しは PR をキューへ入れない。question 面へ
   *  渡すときに立てる question は呼び出し側が決める(CI 赤なら CI 赤の question — #1644)。 */
  const withdrawIfSurfaceChanged = (
    task: Task,
    authority: AuthorityProfile | undefined,
    prNumber: number,
    workspaceName: string,
    now: Date,
    askQuestion = (changed: string) =>
      registerMergeQuestion(
        deps.db,
        task,
        prNumber,
        `"${task.title}"'s PR #${prNumber} was queued for auto_if_ci_green auto-merge, but its ` +
          `landing surface changed after it was queued: ${changed}. Merge it now?`,
        "merge",
        now,
      ),
  ) => {
    const landing = landingSurface(
      deps.isProtectedWorkspace?.(workspaceName),
      authority?.merge,
      task.risk_flag,
    );
    if (landing.surface === "auto_merge_queue") return false;
    deps.db.transaction(() => {
      clearPendingAutoMerge(deps.db, task.id);
      if (landing.surface === "outside_board") {
        appendEvent(deps.db, {
          taskId: task.id,
          workerId: BOARD_WORKER_ID,
          origin: "board",
          payload: {
            kind: "auto_merge_withdrawn",
            pr_number: prNumber,
            merge: authority?.merge === "external" ? "external" : null,
          },
          at: now,
        });
        return;
      }
      const changed = {
        protected: `workspace "${workspaceName}" is now protected, which always needs a human merge`,
        dial: "the merge dial is now escalate",
        risk: "the task now carries risk, and auto_if_ci_green never auto-merges a risky task",
      }[landing.reason];
      askQuestion(changed);
    })();
    return true;
  };
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
  const agentUnavailable = (task: Task, excludePrPromotionQuestionId?: string) =>
    failed(
      task,
      "agent_unavailable",
      "the assigned agent's authority profile cannot be resolved for landing",
      excludePrPromotionQuestionId,
    );
  /** ADR 0225 決定1: 刻んだ head から内容が変わったか(ADR 0105 と同じ比較)。読めなければ「変わった」—— 修理を捨てない側 */
  const changedSince = (task: Task, head: string | null): boolean => {
    const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
    if (head === null || !resolve) return true;
    try {
      return branchMergeEffect(resolve(task.workspace), head, taskBranch(task.id)).changesCandidate;
    } catch {
      return true;
    }
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
          const resolved = readAuthority(task, deps.clock.now());
          if (!resolved) return agentUnavailable(task, excludePrPromotionQuestionId);
          const purpose =
            resolved.profile?.merge === "auto_if_ci_green"
              ? `Workspace "${workspace.name}" is purely-local, so CI cannot be observed and ` +
                `auto_if_ci_green cannot auto-merge "${task.title}". Land its task branch on the ` +
                `protected branch now?`
              : `Workspace "${workspace.name}" is purely-local and has no GitHub merge surface ` +
                `for "${task.title}". Land its task branch on the protected branch now?`;
          registerLocalMergeQuestion(deps.db, task, purpose, deps.clock.now());
          retireFailures(task.id, excludePrPromotionQuestionId);
          return { kind: "landed", form: "local_merge_question" };
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
            form: "open_pull_request_updated",
            prNumber: task.pr_number,
          };
        }
        // profile を読むのは面を開く時点だけ —— 開いている PR への push は読まない(ADR 0217 決定3)
        const resolved = readAuthority(task, deps.clock.now());
        if (!resolved) return agentUnavailable(task, excludePrPromotionQuestionId);
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
        recordPrOpened(
          deps.db,
          task,
          pr.number,
          resolveTaskAgent(
            task,
            deps.defaultAgentName,
            deps.auditorName ?? DEFAULT_AUDITOR_NAME,
          ),
          deps.clock.now(),
          resolved.profile,
          deps.isProtectedWorkspace?.(workspace.name),
          "worker",
        );
        retireFailures(task.id, excludePrPromotionQuestionId);
        return { kind: "landed", form: "pull_request_opened", prNumber: pr.number };
      } catch (error) {
        const landed = getTask(deps.db, task.id);
        if (!landedBefore && landed && taskHasLanded(deps.db, task.id)) {
          retireFailures(task.id, excludePrPromotionQuestionId);
          return landed.pr_number === null
            ? { kind: "landed", form: "local_merge_question" }
            : {
                kind: "landed",
                form: "pull_request_opened",
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
        if (ancestor.pr_number === null) {
          if (taskHasLanded(deps.db, ancestor.id)) continue;
          // ADR 0225: abandon promotion した祖先は着地し直さない。門が開き、刻んだ head から内容が
          // 変わっていれば、PR を開かず(profile も読まず)昇格の question を立て直す
          const abandoned = latestEventOfTask(deps.db, ancestor.id, "pr_promotion_abandoned");
          if (abandoned) {
            if (
              landingBlock(deps.db, ancestor.id) ||
              hasOpenPrPromotionQuestion(deps.db, ancestor.id) ||
              !changedSince(ancestor, abandoned.payload.head)
            ) {
              continue;
            }
            registerPrPromotionQuestion(
              deps.db,
              ancestor,
              `PR promotion re-asked: ${ancestor.title}`,
              `PR promotion for completed task "${ancestor.title}" was abandoned. An attached child ` +
                `settled afterwards, and ${taskBranch(ancestor.id)} no longer matches (or could not be ` +
                `compared with) the content abandoned then. Promote the current content?`,
              deps.clock.now(),
            );
            results.push({
              taskId: ancestor.id,
              verdict: {
                kind: "failed",
                reason: "promotion_failed",
                error: `the content of ${taskBranch(ancestor.id)} changed after PR promotion was abandoned`,
              },
            });
            continue;
          }
        }
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
    // ADR 0217 決定5: agent 名の quarantine に落ちた agent のキューの PR は、merge 失敗時の
    // 観測(ADR 0079 決定3)に届かない。盤面の外で merge されたものは回答の受理直前にここで
    // 観測する。読めない PR は飛ばす —— キューに残り、着地待ちに数えられる。
    async observeMergedAutoMerges(agentName) {
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      const github = deps.github;
      if (!resolve || !github) return;
      for (const { task_id, pr_number } of listPendingAutoMerges(deps.db)) {
        const task = getTask(deps.db, task_id);
        if (task?.type !== "work" || (task.assignee ?? deps.defaultAgentName) !== agentName) continue;
        try {
          const { path } = resolve(task.workspace);
          if (!(await github.isPullRequestMerged({ path, number: pr_number }))) continue;
        } catch {
          continue;
        }
        // await の間に無人 merge の tick が同じ行を merge して外していれば、それは盤面の
        // merge であって観測ではない
        if (!isQueuedForAutoMerge(deps.db, task_id)) continue;
        retireMergedAutoMerge(
          deps.db,
          task_id,
          { kind: "pr_merge_observed", pr_number },
          deps.clock.now(),
        );
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
        if (!workspace) continue;
        // 着地の面は門と同じ2点 — CI を読む前と、CI を読んだ後に盤面の名義で行為する直前(緑なら
        // merge、赤なら merge question)— で読む。面が変わった PR はキューを外れ、門に当たった PR は
        // キューに残る(ADR 0217 決定1)。profile が読めなければ agent を quarantine に落とし、
        // キューに残してこの回は飛ばす(決定3)
        const stop = (askQuestion?: (changed: string) => void) => {
          const resolved = readAuthority(task, now);
          return (
            !resolved ||
            withdrawIfSurfaceChanged(task, resolved.profile, pr_number, workspace.name, now, askQuestion) ||
            landingBlock(deps.db, task_id)
          );
        };
        if (stop()) continue;
        const status = await github.getCiStatus({ path: workspace.path, number: pr_number });
        if (status === "pending") continue;
        if (status === "success") {
          if (stop()) continue;
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
          retireMergedAutoMerge(
            deps.db,
            task_id,
            { kind: observed ? "pr_merge_observed" : "pr_merged", pr_number },
            now,
          );
          continue;
        }
        // 面が question 側へ変わっていても、立てるのは CI 赤の question(ADR 0217 決定2)
        const askCiRed = () =>
          registerMergeQuestion(
            deps.db,
            task,
            pr_number,
            `"${task.title}"'s auto_if_ci_green auto-merge found CI red on PR #${pr_number}. ` +
              "Merge anyway, or hold?",
            "hold",
            now,
          );
        if (stop(askCiRed)) continue;
        // 外すことと問うことを1つにする — 片方だけで無言で消える経路を残さない(ADR 0105 決定3)
        deps.db.transaction(() => {
          clearPendingAutoMerge(deps.db, task_id);
          askCiRed();
        })();
      }
    },
  };
  return landing;
}
