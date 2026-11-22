import { lstatSync } from "node:fs";
import { join } from "node:path";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "./actor-id.js";
import type { BoardStatePath } from "./board-state.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { DEFAULT_AUDITOR_NAME, DEFAULT_INTERVIEWER_NAME } from "./defaults.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, type EventRowOf, latestEventOfTask, parseEventRow, type TaskScopedPayload } from "./events.js";
import { git, isAncestor } from "./git.js";
import type { GitHubClient, PrStateRead } from "./github.js";
import { type GitHubAuth, remoteTrackingRef, workspaceNetworkDestination } from "./github-auth.js";
import { GITHUB_APP_SLUG } from "./github-login.js";
import { type HumanMergePathReview, humanMergePathChanges } from "./human-merge-paths.js";
import { declaredProtectedBranchRef, isRemoteBacked, namePickupPredicates, resolvedCommit } from "./pickup-predicates.js";
import { openQuarantineQuestion, parseWorkspaceContainmentValue, type QuarantineKind, quarantineAgent } from "./quarantine.js";
import { type PrMergeQuestionContent, type PrMergeReason, type QuestionColumns, type QuestionKind, questionKindOf } from "./question-kind.js";
import { type AuthorityProfile, isUnresolvableAgentError, type MergeDial } from "./registry.js";
import { treeDeltaEntries } from "./sandbox.js";
import {
  ancestorsSql,
  type ClosedRootOf,
  contentSourceFor,
  countUnsettledAttachedChildren,
  derivedWorkspace,
  getTask,
  hasTaskBranchSql,
  isHumanAssigned,
  LANDING_ENDED_KINDS_SQL,
  landingSurface,
  localLandingOpenOrExecutedSql,
  logDecision,
  MERGE_QUESTION_OPTIONS,
  mergeQuestionWasReplaced,
  openPrPromotionQuestionIds,
  PR_PROMOTION_FAILURE_OPTIONS,
  QuestionClosedError,
  recordPrNumber,
  recordPrOpened,
  registerMergeQuestion,
  registerTask,
  resolveTaskAgent,
  settleQuestionAsObserved,
  subtreeSql,
  type Task,
  type TaskType,
  type TierRef,
  taskBranchLostInForce,
  teardownUnfinishedUnder,
} from "./tasks.js";
import { activeTriageSession } from "./triage.js";
import type { LandingState, RootSettledByObservation, SettledByObservation } from "./wire-contract.js";
import {
  type Answerer,
  boardRefWriter,
  branchMergeEffect,
  buildWorkspaceResolver,
  catchUpTaskBranch,
  checkAcceptanceFirstHalf,
  clearRefusedOnce,
  compareRefsBeforeLanding,
  endLostRootLanding,
  FirstCaptureRefusedError,
  type IntakeContext,
  lineageTaskBranch,
  noReturnAncestor,
  outsideCommitsStop,
  outsidePushRefusal,
  PromotionStopError,
  prepareFetchCommitIfMissing,
  protectedBranch,
  protectedBranchRef,
  quarantineWorkspace,
  RefsMovedError,
  readOriginBranchHead,
  redoMergeBacks,
  refreshProtectedBranch,
  refusedOnceHead,
  resolveOrQuarantine,
  resolveTaskBranchLineage,
  resolveWorkspacesBaseDir,
  rewindStop,
  takeInCatchUp,
  takeInOutsideHead,
  taskBranch,
  taskBranchExists,
  taskBranchTip,
  UnknownWorkspaceError,
  type WorkspaceConfig,
  WorkspaceRepoMismatchError,
  type WorkspaceResolver,
  withRememberedRepoCheck,
  workspaceNeedsHuman,
} from "./workspace.js";

export type LandingVerdict =
  | { kind: "nothing_to_land"; base: string }
  | { kind: "deferred"; reason: LandingBlock["kind"]; count: number }
  | {
      kind: "landed";
      form: "local_merge_question" | "pull_request_opened" | "open_pull_request_updated" | "merge_question";
      prNumber?: number;
    }
  // 開いている PR に積み残しが無い —— push も GitHub の読み取りもしない(ADR 0241)
  | { kind: "up_to_date"; prNumber: number }
  // PR の hold が効き、hold した question と同じ内容のまま —— question を立てず、書き換えの head にも push しない(ADR 0394 決定6・7)
  | { kind: "awaiting_held_question"; prNumber: number; question: string }
  // 回答が待つ根を、この回の収束は撃たなかった(ADR 0241 決定5 / ADR 0394 決定4)。error は回答の拒否文
  | { kind: "excluded"; reason: "pull_request_closed" | "teardown_unfinished" | "root_pull_request_open" | "not_a_root"; error: string }
  // 止まっている原因が quarantine の question としてすでに出ている —— 失敗 question を重ねない(ADR 0241 決定6)。error は retry の拒否文
  | { kind: "quarantined"; error: string }
  | {
      kind: "failed";
      reason:
        | "workspace_unavailable"
        | "github_not_configured"
        | "pull_request_already_merged"
        | "pull_request_closed"
        | "content_left_behind"
        | "promotion_failed"
        // 根の着地が回の中で例外に落ちた —— 失敗 question は立てず、ログと回答の拒否文だけに出る
        | "landing_failed";
      error: string;
    };

export type LandingBlock = { kind: "attached_children" | "objections"; count: number };

/** 比較で止まった根(ADR 0370 決定1)—— 着地の読みの catch を素通りして、回の verdict になる。 */
class RootStopped extends Error {
  constructor(readonly verdict: Extract<LandingVerdict, { kind: "quarantined" }>) {
    super(verdict.error);
  }
}

/** ADR 0330: 縛りの読みと行為を同じ同期の区間に置く。gate は Promise を返せない。 */
export async function actIfGateOpen<T, Refusal>(
  gate: () => (Refusal & { then?: never }) | null,
  act: () => Promise<T>,
): Promise<T | Refusal> {
  const refusal = gate();
  return refusal === null ? act() : refusal;
}

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

/** 着地を待つ完了タスクの id を agent 名の参照で返す(ADR 0217 決定4)—— agent 名の quarantine の解除と agent 削除の扉。
 *  集合の定義は `tasksAwaitingLanding` にある。 */
export function taskIdsAwaitingLanding(
  db: Db,
  resolve: WorkspaceResolver | undefined,
  agentName: string,
  defaultAgentName?: string,
): string[] {
  return tasksAwaitingLanding(db, resolve)
    .filter((task) => (task.assignee ?? defaultAgentName) === agentName)
    .map(({ id }) => id);
}

/** 同じ集合を、タスクの `workspace` の参照で返す —— workspace の削除の扉(ADR 0226)。 */
export function taskIdsAwaitingLandingInWorkspace(db: Db, resolve: WorkspaceResolver | undefined, workspaceName: string): string[] {
  return tasksAwaitingLanding(db, resolve)
    .filter((task) => task.workspace === workspaceName)
    .map(({ id }) => id);
}

/** 着地を待つ完了タスク(ADR 0217 決定4 / ADR 0226 / ADR 0241 決定6): 収束の導出を1回走らせ、PR をまだ開いていない
 *  未着地の根と、無人 merge キューにいるものを返す。何も書かない。profile を読むのは面を開くとき(PR の作成)と無人
 *  merge の瞬間だけなので(ADR 0217 決定3・4)、この2つに絞る —— 開いている PR への push は profile を読まない。
 *  根は、門・quarantine・開いた失敗 question で止まっているものを含み、断念が効いている根(ADR 0225)と、ローカル着地を
 *  hold した内容のままの根(ADR 0289 決定3)は除く。立て直した
 *  昇格の question が開いていれば、その retry が profile を読むので数える。 */
function tasksAwaitingLanding(db: Db, resolve: WorkspaceResolver | undefined): Task[] {
  const roots = landingCandidateIds(db)
    .flatMap((id) => landingRootOf(db, resolve, id)?.task ?? [])
    .filter((task) => {
      const held = declineInForce(db, task.id, "local_merge");
      return (
        task.pr_number === null &&
        // ADR 0289 決定3: hold した内容のままの根は、断念の根と同じく着地を待たない。変わった根は立て直しを待つ
        ((!declineInForce(db, task.id, "pr_promotion_retry") && !(held && !declinedContentChanged(resolve, task, held.payload))) ||
          openPrPromotionQuestionIds(db, task.id).length > 0)
      );
    });
  return [...roots, ...listPendingAutoMerges(db).map(({ task_id }) => getTask(db, task_id)!)];
}

type Declined = EventRowOf<"landing_declined">["payload"];
/** 断った内容のうち、今の内容と比べる外の部分(PR の外の push の段だけが今の値を持つ)。 */
type DeclinedOutside = Pick<Declined, "outside" | "missing_branches">;
/** 断る回答を受ける question の種類(ADR 0394 決定5)。 */
type DeclinableQuestion = Extract<QuestionKind, { kind: "pr_merge" | "local_merge" | "pr_promotion_retry" }>;

/** ADR 0394 決定5: 断る回答が根に刻む記録 —— 答えた question が問うた内容を、その question の列から写す。 */
export function landingDeclined(questionId: string, kind: DeclinableQuestion): Declined {
  const pr = kind.kind === "pr_merge" ? kind : undefined;
  return { kind: "landing_declined", question_id: questionId, tip: kind.tip, outside: pr?.outside ?? null, missing_branches: pr?.missingBranches ?? null };
}

/** 欠けたブランチの組 —— 並びは読み手の列挙の順に依るので、順に依らずに比べる。 */
const branchSet = (branches: string[] | null) => JSON.stringify(branches && [...branches].sort());

/** ADR 0394 決定5: 断った内容と今の内容が違うか —— 比べ方はここだけ。盤面の部分は tip の sha、外の部分は sha と種類の組で、写した全体を
 *  比べる(`current` は今の外の部分。PR の外の push の段だけが渡す)。tip が無い・読めない・workspace を解決できなければ「変わった」——
 *  修理を捨てない側(ADR 0225 決定1 / ADR 0234 決定3)。 */
function declinedContentChanged(
  resolve: WorkspaceResolver | undefined,
  task: Task,
  declined: Declined,
  current: DeclinedOutside = { outside: null, missing_branches: null },
): boolean {
  if (declined.tip === null || !resolve) return true;
  if (declined.outside?.sha !== current.outside?.sha || declined.outside?.kind !== current.outside?.kind) return true;
  if (branchSet(declined.missing_branches) !== branchSet(current.missing_branches)) return true;
  try {
    return questionTip(resolve(task.workspace), task.id) !== declined.tip;
  } catch {
    return true;
  }
}

/** ADR 0394 決定6: 根の断る記録のうち、`kind` の question を断った最新のもの —— 効いている間だけ返す。種類は記録が指す question から
 *  読む(`questionKindOf`)。効かなくなる条件は種類ごと: abandon は後の retry が PR を開くか push したとき(ADR 0225 決定2)、ローカル着地の
 *  hold は merge の執行の記録(ADR 0289 決定1・3)、PR の hold はその PR の決着(ADR 0265)か、同じ PR に新しい question が立ったとき。 */
function declineInForce(db: Db, taskId: string, kind: DeclinableQuestion["kind"]): EventRowOf<"landing_declined"> | undefined {
  const rows = db.prepare("SELECT * FROM events WHERE task_id = ? AND kind = 'landing_declined' ORDER BY id DESC").all(taskId);
  for (const row of rows) {
    const declined = parseEventRow(row) as EventRowOf<"landing_declined">;
    const question = getTask(db, declined.payload.question_id);
    const asked = question && questionKindOf(question);
    if (asked?.kind !== kind) continue;
    if (asked.kind === "pr_merge") {
      const stillAsked = latestMergeQuestion(db, asked.task_id)?.id === question!.id;
      return rootPrOutcome(db, taskId) === null && stillAsked ? declined : undefined;
    }
    const ends = kind === "local_merge" ? ["local_merge_executed"] : ["pr_opened", "pr_branch_pushed"];
    const ended = db
      .prepare(`SELECT 1 FROM events WHERE task_id = ? AND kind IN (${ends.map(() => "?").join(", ")}) AND id > ?`)
      .get(taskId, ...ends, declined.id);
    return ended === undefined ? declined : undefined;
  }
  return undefined;
}

export function landingBlock(db: Db, taskId: string): LandingBlock | null {
  const attached = countUnsettledAttachedChildren(db, taskId);
  if (attached > 0) return { kind: "attached_children", count: attached };
  const objections = countUnbundledObjections(db, taskId);
  return objections > 0 ? { kind: "objections", count: objections } : null;
}

export class LandingRefCheckError extends DomainError {}
class LandingRefsRefusedError extends LandingRefCheckError {}

function workspaceQuarantinedMessage(name: string): string {
  return `workspace "${name}" is quarantined and needs human attention before landing; answer its quarantine question`;
}

/** ADR 0370 決定1: 基準と違う ref は着地を止め、workspace の Quarantine を立てる。最初の撮りを待つ場合は、すでに止めている
 *  Quarantine の question を名指す(ADR 0373 決定13 追記)。 */
export function assertLandingRefs(db: Db, workspace: WorkspaceConfig, resolveRegistered: WorkspaceResolver | undefined, now: Date): void {
  try {
    compareRefsBeforeLanding(db, workspace, { resolveRegistered, now });
  } catch (error) {
    if (error instanceof FirstCaptureRefusedError) {
      const { quarantine, value } = error.stop;
      if (quarantine === "workspaceContainment") {
        throw new LandingRefsRefusedError(
          `the containment of workspace "${parseWorkspaceContainmentValue(value!).workspace}" is quarantined, and a workspace the board holds no baseline for ` +
            `waits until it is closed; answer question ${openQuarantineQuestion(db, quarantine, value)?.id}`,
        );
      }
      throw new LandingRefsRefusedError(workspaceQuarantinedMessage(value!));
    }
    if (!(error instanceof RefsMovedError)) {
      if (error instanceof WorkspaceRepoMismatchError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new LandingRefCheckError(`could not verify refs for workspace "${workspace.name}" before landing: ${reason}`);
    }
    quarantineWorkspace(db, workspace.name, error, now);
    throw new LandingRefsRefusedError(`${error.message}; answer the quarantine question of workspace "${workspace.name}" before landing`);
  }
}

/** ADR 0231 決定2 / ADR 0239 / ADR 0242: 積み残し —— 盤面が持つ着地の内容が、まだ PR の head に載っていない。着地する
 *  タスク自身と、cancelled の祖先を挟まない done の work の子孫それぞれのブランチを、呼び手が渡す head(candidate)と
 *  ADR 0105 の内容の述語で比べ、1つでも candidate を変えれば積み残しとする。merge の門は GitHub が報告した head を
 *  必要なら fetch し、収束は盤面が最後に push した head を渡す。head を candidate に置くので、盤面の外の push で先へ
 *  進んでいても積み残しと読まない。ブランチが無ければ運ぶ内容も無い。比べられなければ積み残しとする(fail-closed)。
 *  門(`landingBlock`)とは別の述語である(ADR 0231 決定3)。 */
function hasContentLeftBehind(
  db: Db,
  workspace: WorkspaceConfig,
  taskId: string,
  candidate: string | undefined,
): boolean {
  try {
    return contentLeftBehindLocally(db, workspace, taskId, candidate).length > 0;
  } catch {
    return true;
  }
}

/** 手元の candidate に積み残しを運ぶタスクの id —— 比べられなければ throw する。ローカル着地の merge 回答は同期で読み、
 *  merge の実行まで await を挟まない(ADR 0289 決定2 / ADR 0288 決定2)。 */
export function contentLeftBehindLocally(
  db: Db,
  workspace: WorkspaceConfig,
  taskId: string,
  candidate: string | undefined,
): string[] {
  return targetsLeftBehind(workspace, taskId, leftBehindTargets(db, workspace, taskId), candidate);
}

function targetsLeftBehind(workspace: WorkspaceConfig, taskId: string, targets: string[], candidate: string | undefined): string[] {
  if (targets.length === 0) return [];
  if (candidate === undefined) throw new Error(`the board has no record of pushing ${taskBranch(taskId)}`);
  return targets.filter((id) => branchMergeEffect(workspace, candidate, taskBranch(id)).changesCandidate);
}

function leftBehindTargets(db: Db, workspace: WorkspaceConfig, taskId: string): string[] {
  return (
    db
      .prepare(
        `${subtreeSql("@root", "c.status <> 'cancelled'")}
       SELECT id FROM tasks
        WHERE id IN (SELECT id FROM subtree) AND (id = @root OR (type = 'work' AND status = 'done'))`,
      )
      .pluck()
      .all({ root: taskId }) as string[]
  ).filter(
    // ADR 0375 決定6 / ADR 0380 決定3: 生きている根の積み残しに、死んだ task も帰り先なしの task も数えない —— 失われた ref は git で読まない
    (id) => !taskBranchLostInForce(db, id) && !noReturnAncestor(db, workspace, getTask(db, id)!) && taskBranchExists(workspace, id),
  );
}

/** ADR 0242 決定2: 盤面が最後に push した head(`pr_opened` / `pr_branch_pushed` の sha)—— 収束が積み残しを比べる相手 */
export function lastPushedHead(db: Db, taskId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT json_extract(payload, '$.sha') AS sha FROM events
        WHERE task_id = ? AND kind IN ('pr_opened', 'pr_branch_pushed') ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { sha: string | null } | undefined;
  return row?.sha ?? undefined;
}

/** ADR 0376 決定7: 記録済みの PR の head が、盤面が最後に push した値を祖先に持たない(書き換え・巻き戻し)。`rewound` は head が local の
 *  `task/<root>` の祖先(text A4a)で、そうでなければ書き換え(A4b)。`droppedBranches` は外の push が落とした内容、`unpushedBranches` は盤面がまだ push して
 *  いない内容(text A4d —— 未 push のものを落とされたとは言わない)。根のブランチは子孫の内容も持つので、子孫があれば子孫を名指す。
 *  同じ内容のまま書き換えた head(rebase)は何も落としていないので `droppedBranches` は空。 */
export type OutsidePush = { head: string; lastPushed: string; rewound: boolean; droppedBranches: string[]; unpushedBranches: string[] };

/** head は手元にある前提。最後に push した値が無い・その commit が手元に無い・head の祖先なら undefined —— 収束はそれを止めない
 *  (ADR 0376 決定2)。無人 merge と人間の `merge` 回答は、祖先関係を確かめてから中身を読むためだけに呼ぶ(`prHeadOrigin`)。 */
function outsidePushOf(
  workspace: WorkspaceConfig,
  taskId: string,
  head: string,
  targets: string[],
  lastPushed: string | undefined,
): OutsidePush | undefined {
  if (lastPushed === undefined || resolvedCommit(workspace, lastPushed) === undefined || isAncestor(workspace, lastPushed, head)) return undefined;
  const unpushed = targetsLeftBehind(workspace, taskId, targets, lastPushed);
  const droppedDescendants = targetsLeftBehind(workspace, taskId, targets, head).filter((id) => id !== taskId && !unpushed.includes(id));
  // 子孫の名指せない落ちた内容は根のもの —— head が最後に push した値の内容を欠くときだけそう言う
  const dropped = droppedDescendants.length > 0 ? droppedDescendants : branchMergeEffect(workspace, head, lastPushed).changesCandidate ? [taskId] : [];
  const unpushedDescendants = unpushed.filter((id) => id !== taskId);
  return {
    head,
    lastPushed,
    // 手元に根のブランチが無ければ巻き戻しとは確かめられない —— 書き換えと読む
    rewound: taskBranchExists(workspace, taskId) && isAncestor(workspace, head, `refs/heads/${taskBranch(taskId)}`),
    droppedBranches: dropped.map(taskBranch),
    // 根自身の未 push の内容は、何も落ちていないときにだけ名指す —— 落ちた根の内容と同じブランチを2度言わない
    unpushedBranches: (unpushedDescendants.length > 0 || dropped.length > 0 ? unpushedDescendants : unpushed).map(taskBranch),
  };
}

/** ADR 0387 決定1・2: 記録済みの PR の head の出所 —— 盤面が最後に push した値(`pushed`)、それを祖先に持たないと確かめられた
 *  書き換え・巻き戻し(`rewritten`、ADR 0376 決定7)、それ以外(`not_pushed` —— 外から進んだ head、祖先関係を確かめられない head、
 *  最後に push した値が無い head)。 */
export type PrHeadOrigin = { kind: "pushed" } | { kind: "rewritten"; outside: OutsidePush } | { kind: "not_pushed"; lastPushed: string | undefined };

/** 無人 merge と人間の `merge` 回答が読む1つの判定。判定は一致だけで、祖先関係は倒し先を選ぶのにだけ使う —— 確かめられなければ
 *  `not_pushed`(fail-closed)。`lastPushed` は呼び手が head を読んだ同期区間で読んだ値(ADR 0387 決定4)。 */
function prHeadOrigin(workspace: WorkspaceConfig, taskId: string, head: string, lastPushed: string | undefined, targets: string[]): PrHeadOrigin {
  if (head === lastPushed) return { kind: "pushed" };
  let rewritten = false;
  try {
    rewritten =
      lastPushed !== undefined &&
      resolvedCommit(workspace, lastPushed) !== undefined &&
      resolvedCommit(workspace, head) !== undefined &&
      !isAncestor(workspace, lastPushed, head);
  } catch {
    // 祖先関係を読めない
  }
  const outside = rewritten ? outsidePushOf(workspace, taskId, head, targets, lastPushed) : undefined;
  return outside ? { kind: "rewritten", outside } : { kind: "not_pushed", lastPushed };
}

/** spec #3273 text A4 の `<branches>` の句 —— 未 push の内容が重なれば text A4d の形に分け、真であるものだけを言う。何も欠いていない
 *  (同じ内容の rebase)なら、最後に push した値を持たない事実だけを言う。 */
function lacksContentOf({ lastPushed, droppedBranches, unpushedBranches }: OutsidePush): string {
  if (droppedBranches.length > 0 && unpushedBranches.length > 0) {
    return `lacks the content of ${droppedBranches.join(", ")} (dropped by the outside push) and of ${unpushedBranches.join(", ")} (not pushed by the board yet)`;
  }
  if (droppedBranches.length > 0) return `lacks the content of ${droppedBranches.join(", ")}`;
  if (unpushedBranches.length > 0) return `lacks the content of ${unpushedBranches.join(", ")} (not pushed by the board yet)`;
  return `no longer contains ${lastPushed}, which the board pushed`;
}

/** 盤面がその PR に in-flight 印を持つ(merge しているか、push して記録するまでの)間の回答の拒否文(ADR 0236 決定3 / ADR 0387 決定4)。 */
export const prInFlightRefusal = (prNumber: number) => `PR #${prNumber} is being merged or pushed to by the board right now — answer again in a moment`;

/** spec #3273 text A6(ADR 0376 決定9): PR の merge の失敗の拒否と tick の question 本文に、失敗が何でも足す —— GitHub 上で conflict した PR
 *  は head への merge で解き、rebase・force-push した head は書き換えとして扱われる(決定7)。ADR 0387 決定3 / ADR 0394 決定3: 盤面は人間の push
 *  を見分けないので、答え直した `merge` は push した commit を列挙して拒まれ、question が立て直されることを前もって言う。 */
export const conflictedPrRoute = (prNumber: number, protectedName: string) =>
  ` If PR #${prNumber} conflicts with ${protectedName}, merge ${protectedName} into the PR's head in your own clone and push it — ` +
  "do not rebase or force-push; the board treats such a head as rewritten outside — " +
  "then answer `merge`: the board refuses it, listing the commits you pushed, and closes this question — answer `merge` on the new question it names to merge.";

/** ADR 0387 決定1・2: 盤面が push していない head の question の本文と `merge` の拒否文が共有する句。 */
const notPushedText = {
  subject: (prNumber: number, head: string) => `PR #${prNumber}'s head ${head} holds commits the board did not push`,
  noRecord: (prNumber: number) => `, and the board has no record of what it pushed to PR #${prNumber}`,
  onGitHub: "review the PR's commits on GitHub",
  log: (lastPushed: string, head: string) => `\`git log ${lastPushed}..${head}\``,
};

/** ADR 0387 決定1: 盤面が push していない head の、推奨 hold の merge question の本文 —— 盤面の知らない commit があることと、
 *  それを見るコマンド。最後に push した値が無ければ、比べる起点が無いことを言う。 */
const notPushedQuestionBody = (task: Task, prNumber: number, head: string, lastPushed: string | undefined) =>
  `"${task.title}": ${notPushedText.subject(prNumber, head)}` +
  (lastPushed === undefined
    ? `${notPushedText.noRecord(prNumber)} — ${notPushedText.onGitHub}. Merge, or hold?`
    : ` — the board last pushed ${lastPushed}. See them with ${notPushedText.log(lastPushed, head)}. Merge, or hold?`);

/** spec #3273 text A4c: 外の push が落とした内容の、推奨 hold の merge question の本文。 */
const outsidePushQuestionBody = (task: Task, prNumber: number, outside: OutsidePush) =>
  `"${task.title}": PR #${prNumber}'s head was moved outside the board and ${lacksContentOf(outside)}. Merge, or hold? ` +
  "The first `merge` is refused once and opens a workbench where you decide whether that content comes back.";

/** ADR 0370 決定1 / ADR 0242 決定1: token を待ったら、fetch が交渉用の ref を読む前に比べ直す。
 *  その同期区間で GitHub の head と、必要なら最後に push した head を、検査済みのブランチと比べる。head の出所(ADR 0387 決定1)は
 *  積み残しの比較対象の有無に依らず読む —— 最後に push した値と違う head は、祖先関係を読むために取る。 */
export async function checkPrMergeContent(
  db: Db,
  workspace: WorkspaceConfig,
  taskId: string,
  pr: { number: number; head: string; lastPushed: string | undefined },
  { auth, compareRefs }: { auth: GitHubAuth | undefined; compareRefs: () => void },
): Promise<{ left: string[]; head: PrHeadOrigin }> {
  compareRefs();
  let targets = leftBehindTargets(db, workspace, taskId);
  const forContent = targets.length > 0;
  // 積み残しを比べないなら、取れない head は拒まず、祖先関係を確かめられない head と読む(ADR 0387 決定1)
  const unfetched = (error: unknown) => {
    if (forContent || error instanceof WorkspaceRepoMismatchError) throw error;
  };
  const fetching = forContent || pr.head !== pr.lastPushed ? prepareFetchCommitIfMissing(db, workspace, pr.head, auth) : undefined;
  if (fetching) {
    const fetch = await fetching.catch(unfetched);
    compareRefs();
    try {
      fetch?.();
    } catch (error) {
      unfetched(error);
    }
    targets = leftBehindTargets(db, workspace, taskId);
  }
  const left = targetsLeftBehind(workspace, taskId, targets, pr.head);
  return { left, head: prHeadOrigin(workspace, taskId, pr.head, pr.lastPushed, targets) };
}

export function landingAnnotation(
  db: Db,
  task: QuestionColumns<TierRef> & Pick<Task, "workspace">,
): { blocked_by: LandingBlock["kind"] | null } | null {
  const kind = questionKindOf(task);
  let landingTaskId: string;
  switch (kind.kind) {
    case "local_merge":
      landingTaskId = kind.task_id;
      break;
    case "pr_merge":
      landingTaskId = kind.task_id;
      break;
    case "escalation":
    case "failure":
    case "premise_breach":
    case "broken_probe":
    case "approval":
    case "pr_promotion_retry":
    case "proposal":
    case "quarantine":
    case "stop_reason":
    case "intake":
    case "cli_auth_expiry_warning":
      return null;
  }
  return { blocked_by: landingBlock(db, landingTaskId)?.kind ?? null };
}

/** `reraised` は回答の寄り道の中で question を立て直して拒んだこと(ADR 0394 決定3)。`notice` は retry の回答の取り込みが作業台を残したときの text C6(1つの作業台に1行)。`takenIn` は回答の取り込みが作業台の tip を
 *  取り込んだこと(spec #3273 text A10)。 */
export type RootVerdict = { taskId: string; verdict: LandingVerdict; notice?: string; takenIn?: true; reraised?: true };

/** 盤面がまだ着地を運ぶ根(GLOSSARY.md「着地」)。`outlivedForkSource` は lineage が読んだ事実で、PR を開く前の追いつきに
 *  使う。`lineageError` は lineage が読めなかった候補 —— 根かどうか分からないので、根として人間に失敗を見せる。`workspace` は
 *  lineage を読めた根の解決した workspace。 */
interface LandingRoot {
  task: Task;
  outlivedForkSource: boolean;
  lineageError?: unknown;
  workspace?: WorkspaceConfig;
}

/** 盤面の外で決着した PR の観測の綴り —— merge と閉じたことを、互いにも執行とも区別する(ADR 0079 決定4 / ADR 0229 決定4)。 */
const OBSERVED = { MERGED: "pr_merge_observed", CLOSED: "pr_close_observed" } as const;

/** 読んだ PR の決着の綴り(ADR 0265 決定5): 盤面自身の名義の merge は執行(`pr_merged`)—— merge の後・記録の前に落ちた
 *  盤面の merge —— で、それ以外は観測。名義は `gh pr view --json mergedBy` の login で、App は `app/<slug>`(#2079 で実測)。 */
function prOutcomeKind(state: keyof typeof OBSERVED, mergedBy: string | null) {
  return state === "MERGED" && mergedBy === `app/${GITHUB_APP_SLUG}` ? "pr_merged" : OBSERVED[state];
}

/** 根の PR の決着(ADR 0265 決定2): merge されたか閉じられたか、盤面の執行(`pr_merged`)か観測か。決着していなければ null。
 *  決着はどの経路でも PR を開いた根の id に刻まれる(決定1)ので、根の記録だけを読む。読み手はすべてこれを通る。 */
export function rootPrOutcome(db: Db, taskId: string): { state: "MERGED" | "CLOSED"; observed: boolean; prNumber: number } | null {
  const row = db
    .prepare(
      `SELECT kind, json_extract(payload, '$.pr_number') AS pr_number FROM events
        WHERE task_id = ? AND kind IN ('pr_merged', '${OBSERVED.MERGED}', '${OBSERVED.CLOSED}') ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { kind: string; pr_number: number } | undefined;
  if (!row) return null;
  return { state: row.kind === OBSERVED.CLOSED ? "CLOSED" : "MERGED", observed: row.kind !== "pr_merged", prNumber: row.pr_number };
}

/** 閉じた根に塞がれた子(ADR 0265 決定6)の唯一の述語: lineage の帰り先を辿ると盤面の外で閉じた PR の根のブランチに行き着き、
 *  その根の内容がまだ保護ブランチに無い(ADR 0250 決定1 の前の場合)。帰り先は pickup がブランチを切るときの lineage そのもので、
 *  完了した修理の review は修理のブランチへ、修理は根へ帰るので、行き着く先まで辿る。question は pickup されないので当たらない。
 *  閉じた根が祖先にいなければ git を読まない。workspace や git が読めなければ当たらない —— pickup が自分の経路で同じ失敗を見せる。 */
export function closedRootOf(db: Db, resolve: WorkspaceResolver | undefined): ClosedRootOf {
  return (task) => {
    const ancestors: Task[] = [];
    for (let id = task.parent_id; id !== null; ) {
      const ancestor = getTask(db, id)!;
      ancestors.push(ancestor);
      id = ancestor.parent_id;
    }
    if (task.type === "question" || !resolve || !ancestors.some((a) => rootPrOutcome(db, a.id)?.state === "CLOSED")) return null;
    try {
      const workspace = resolve(derivedWorkspace(db, task));
      const base = declaredProtectedBranchRef(workspace);
      for (let current: Pick<Task, "type" | "parent_id"> = task; ; ) {
        const branch = lineageTaskBranch(db, workspace, current, base);
        const target = ancestors.find((a) => taskBranch(a.id) === branch);
        if (!target) return null;
        const outcome = rootPrOutcome(db, target.id);
        if (outcome?.state === "CLOSED") {
          return taskHasContentToLand(workspace, target.id, base) ? { task_id: target.id, pr_number: outcome.prNumber } : null;
        }
        current = target;
      }
    } catch {
      return null;
    }
  };
}

/** question 自身の記録に残る観測(ADR 0265 決定1)。根から導く種類を除いた印の全部 —— 種類を足してここを足さないと typecheck が落ちる。 */
const QUESTION_RECORDED_SQL = Object.keys({
  pr_promotion_observed: true,
  quarantine_released: true,
  routing_proposal_stale: true,
  memory_proposal_stale: true,
} satisfies Record<Exclude<SettledByObservation, RootSettledByObservation>, true>)
  .map((kind) => `'${kind}'`)
  .join(", ");

/** 観測で閉じた question の印(ADR 0265 決定7): 回答なしで done の question の観測の種類、それ以外は null。merge question の
 *  決着は根に刻まれる(決定1)ので根の決着の読みから、他の観測は question 自身の記録から引く。 */
export function settledByObservation(db: Db, question: Pick<Task, "id" | "question_pending_merge_task_id">): SettledByObservation | null {
  const row = db
    .prepare(
      `SELECT status = 'done' AND NOT EXISTS (SELECT 1 FROM events WHERE task_id = tasks.id AND kind = 'question_answered') AS observed,
         (SELECT kind FROM events WHERE task_id = tasks.id AND kind IN (${QUESTION_RECORDED_SQL}) ORDER BY id DESC LIMIT 1) AS kind
         FROM tasks WHERE id = ?`,
    )
    .get(question.id) as { observed: number; kind: SettledByObservation | null };
  if (!row.observed) return null;
  if (question.question_pending_merge_task_id === null) return row.kind;
  if (mergeQuestionWasReplaced(db, question)) return null;
  const outcome = rootPrOutcome(db, question.question_pending_merge_task_id);
  return outcome && (outcome.observed ? OBSERVED[outcome.state] : "pr_merged");
}

/** done の work の着地の状態(ADR 0265 決定7): 根の PR の決着 → 無人 merge キュー → 開いた merge question → 内容で
 *  終わった(`landing_finished`)→ ブランチを失って終えた(`landing_ended_branch_lost`)→ キューからの取り下げ、の順に記録から導く。内容で終わっても決裁は残る(決定3)ので、
 *  生きているキューの行と merge question を先に言う。done の work でない行と、どれも無い行(PR を開く前で止まっている根・
 *  根でない行)は null。キューに残る理由は名指さない(#1866)。 */
export function landingState(db: Db, task: Pick<Task, "id" | "type" | "workspace" | "pr_number"> & { status: string }): LandingState | null {
  if (task.type !== "work" || task.status !== "done") return null;
  const outcome = rootPrOutcome(db, task.id);
  if (outcome) return outcome.state === "CLOSED" ? "close_observed" : outcome.observed ? "merge_observed" : "merged";
  if (isQueuedForAutoMerge(db, task.id)) return "auto_merge_queue";
  if (listOpenMergeQuestions(db).some((q) => q.root === task.id)) return "merge_question";
  if (latestEventOfTask(db, task.id, "landing_finished")) return "landed";
  // spec #3273 group H: ブランチを失って終えた根 —— ADR 0265 決定7 の7つの外の8つ目(同 Status 追記)
  if (latestEventOfTask(db, task.id, "landing_ended_branch_lost")) return "branch_lost";
  return latestEventOfTask(db, task.id, "auto_merge_withdrawn") ? "withdrawn" : null;
}

/** 収束の根の候補の id を rowid の順(祖先が子孫より先)に返す —— SQL だけで、git は読まない。候補を SQL で先に絞り、
 *  lineage は候補にだけ解く(`landingRootOf`)ので、1回の git の呼び出しの数は着地の終わっていない木の大きさに比例し、
 *  盤面の歴史の長さには比例しない。外すのは、着地が終わった根(merge の記録か内容で終わった PR の根の `landing_finished`
 *  (ADR 0265 決定3) / `nothing_to_land` / ブランチを失って終えた根の `landing_ended_branch_lost`(ADR 0375 決定7))と、ローカル着地が人間の手にあるか執行した根(ADR 0289 決定1)である。hold した根は
 *  候補に残り、撃つ側が hold の head と比べる(`landRoot`)。人間が担当した work は盤面の
 *  タスクブランチを持たなければ根にしない(人間の完了は祖先の着地の契機である)—— 持てば根になる(ADR 0374 決定12)。Interview の子(pin を持つ
 *  work)は使い捨てブランチで走り、ブランチを残すだけで着地しない(ADR 0199)。 */
function landingCandidateIds(db: Db): string[] {
  return db
    .prepare(
      `SELECT t.id FROM tasks t
        WHERE t.type = 'work' AND t.status = 'done'
          AND (t.assignee IS NOT '${HUMAN_ACTOR_ID}' OR ${hasTaskBranchSql("t.id")})
          AND t.interview_target_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.kind IN ${LANDING_ENDED_KINDS_SQL})
          AND NOT ${localLandingOpenOrExecutedSql("t.id")}
        ORDER BY t.rowid`,
    )
    .pluck()
    .all() as string[];
}

/** ADR 0241 決定1 / ADR 0240 決定2: 候補が収束の根ならその根を返す。収束の回と着地を待つ完了タスクの数えはどちらもこれを通る。
 *  ADR 0378 決定7・8: convergence は repo を検査してから lineage を読み、件数の読み口は宣言の ref を使うだけ。盤面の外で閉じた PR の根は
 *  lineage の前に根の PR の決着の読み(`rootPrOutcome`)で外す。PR が開いている根の子孫も lineage の前に記録で外す
 *  (`openPrRootAbove`、ADR 0265 帰結 —— ADR 0250 決定3 を置き換えた): 根の内容が別の経路で保護ブランチに届けば根は
 *  内容で終わり(ADR 0265 決定3)、子孫は次に導くとき自分で根になる。今の記録を読むので、同じ回で先に終わった根の子孫は
 *  その回で自分で根になる。閉じた根と断念した根の子孫は記録で外さず、lineage に任せる(ADR 0250 決定1・2)—— 閉じた根には
 *  push せず、断念した根には撃たないので、どちらの根も子孫を運ばない。lineage が祖先のブランチへ帰る done の work は根では
 *  ない。workspace を解決できない候補と lineage が読めない候補は根かどうか分からないので根として返し、撃つ側がその根の
 *  失敗として人間に見せる。後始末が未了の木は、撃つ直前に根ごとに読む(`landRoot`)。 */
function landingRootOf(
  db: Db,
  resolve: WorkspaceResolver | undefined,
  id: string,
  readBase = declaredProtectedBranchRef,
  compareBeforeLineage?: (workspace: WorkspaceConfig) => void,
): LandingRoot | undefined {
  if (rootPrOutcome(db, id)?.state === "CLOSED" || openPrRootAbove(db, id)) return undefined;
  const task = getTask(db, id)!;
  let workspace: WorkspaceConfig | undefined;
  try {
    workspace = resolve?.(task.workspace);
  } catch {}
  if (!workspace) return { task, outlivedForkSource: false };
  try {
    // ADR 0370 決定1: 収束だけが、lineage が ref を読む直前に比べる —— 表示と扉の読みは比べない
    const resolved = workspace;
    const lineage = resolveTaskBranchLineage(db, resolved, task, readBase(resolved), compareBeforeLineage && (() => compareBeforeLineage(resolved)));
    // ADR 0380 決定3: 帰り先なしは「自分が根」と別の答え —— 着地の根に数えない
    return lineage.branch || lineage.noReturn ? undefined : { task, outlivedForkSource: lineage.outlivedForkSource, workspace: resolved };
  } catch (lineageError) {
    if (lineageError instanceof RootStopped) throw lineageError;
    return { task, outlivedForkSource: false, lineageError };
  }
}

/** `id` の祖先のうち、PR が開いていて子孫を記録で外している根を返す(ADR 0265 帰結)—— 着地が終わっておらず、PR が決着も
 *  断念もしておらず、未回答の失敗 question で止まってもいない根。止まっている根は内容の確かめに届かず内容で終わらない
 *  (ADR 0240 決定2)ので、子孫を外さない —— 子孫は lineage に任せる。 */
function openPrRootAbove(db: Db, id: string): { id: string; prNumber: number } | undefined {
  const unfinishedPrAncestors = db
    .prepare(
      `${ancestorsSql("?")}
       SELECT t.id, t.pr_number AS prNumber FROM tasks t
        WHERE t.id IN (SELECT id FROM ancestors) AND t.pr_number IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.kind IN ${LANDING_ENDED_KINDS_SQL})`,
    )
    .all(id) as Array<{ id: string; prNumber: number }>;
  return unfinishedPrAncestors.find(
    (ancestor) =>
      rootPrOutcome(db, ancestor.id) === null &&
      !declineInForce(db, ancestor.id, "pr_promotion_retry") &&
      openPrPromotionQuestionIds(db, ancestor.id).length === 0,
  );
}

/** 回答が待つ根を回が候補にしなかった理由(ADR 0241 決定5 / ADR 0394 決定4)。error は回答の拒否文。 */
function exclusionOf(db: Db, taskId: string): Extract<LandingVerdict, { kind: "excluded" }> {
  const outcome = rootPrOutcome(db, taskId);
  if (outcome?.state === "CLOSED") {
    return {
      kind: "excluded",
      reason: "pull_request_closed",
      error: `PR #${outcome.prNumber} was closed outside the board, so ${taskBranch(taskId)} is not pushed to it`,
    };
  }
  const root = openPrRootAbove(db, taskId);
  if (root) {
    return {
      kind: "excluded",
      reason: "root_pull_request_open",
      error: `task ${taskId} waits for its root task ${root.id}'s PR #${root.prNumber} to finish landing; answer again once it has`,
    };
  }
  return { kind: "excluded", reason: "not_a_root", error: `task ${taskId} is no longer a landing root, so the board did not carry this answer` };
}

/** 収束を通る回答(retry と `merge`)が待つ根。 */
function answeredRootOf(db: Db, questionId: string): string | undefined {
  const question = getTask(db, questionId);
  return question?.question_pending_pr_promotion_task_id ?? question?.question_pending_merge_task_id ?? undefined;
}


export interface Landing {
  /** ADR 0241 決定1・2・5: 収束を突き、その回で扱った根ごとの verdict を返す。走っている回があれば、その後に
   *  ちょうど1回走る回の結果を返す。retry と、外の push が落とした内容の merge question への `merge`(ADR 0376 決定7)だけが
   *  `answering`(答えている question の id と、取り込みの event に残す回答者)を渡す —— その回はその question を開いていないと読み、
   *  引退の対象からも除く(ADR 0106 決定5)。 */
  converge(options?: { answering?: { question: string; answerer: Answerer } }): Promise<RootVerdict[]>;
  /** 回答受理直前のバックストップ(ADR 0079 決定3)。merge 済み・閉じた PR を観測で決着させたら true、該当しない
   *  (PR 番号・GitHub・workspace が無い)か PR が開いている・印が付いていれば false。PR を読めなければ DomainError を
   *  投げる(ADR 0265 決定4)。 */
  observePullRequestOutcome(question: Task): Promise<boolean>;
  observeAutoMergeOutcomes(agentName: string): Promise<void>;
  /** Annotates a replacement question with the diff of the head it asks about. */
  reviewMergePaths(workspace: WorkspaceConfig, task: Task, pr: PrDiff | undefined): HumanMergePathReview | undefined;
  tick(kind: "auto_merge" | "outside_merge", now: Date): Promise<void>;
  /** ADR 0236 決定2・3: 執行する経路が PR に処理中の印を取り、印を放す関数を返す。既に印が付いていれば取らずに
   *  null を返す。印の鍵は PR を開いた根の id(ADR 0399 決定2)。 */
  takeInFlightMark(rootId: string): (() => void) | null;
  /** 印が付いているかを読むだけ —— 執行しない回答が印の付いた PR を拒むための口(ADR 0288 決定2)。 */
  isMarked(rootId: string): boolean;
  /** 盤面の停止(issue #1851): 以後の `converge()` は回を始めず空を返し、走っている回と列に入った回の終わりで解ける。
   *  回の失敗では reject しない。 */
  stop(): Promise<void>;
}

export interface LandingDeps {
  db: Db;
  clock: Clock;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  github: GitHubClient | null;
  resolveAuthority?: (assignee: string | null, taskType: TaskType) => AuthorityProfile | undefined;
  defaultAgentName: string;
  auditorName?: string;
  interviewerName?: string;
  isProtectedWorkspace?: (name: string) => boolean;
  /** merge 済みの根を比べる前の保護ブランチの fetch(ADR 0241 決定1)が使う盤面の GitHub 身元(ADR 0093)。 */
  githubAuth?: GitHubAuth;
  /** 作業台を開く基点(`resolveWorkspacesBaseDir` に渡す値、ADR 0371 決定7)—— 追いつきの conflict と、retry の取り込み。 */
  workspacesDir?: string;
  /** 盤面の状態の在り処 —— 積み残しの retry が受理と同じ前半の項に渡す(ADR 0371 決定10)。 */
  boardState?: BoardStatePath[];
  /** 走っている pickup の poll が終わると解ける。収束の回はこれを待ってから始まる —— 同じ checkout で pickup の
   *  fetch・checkout と着地の push が重ならない(GLOSSARY.md「収束」)。Absent → pickup を持たない盤面。 */
  pickupIdle?: () => Promise<void>;
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
function taskHasContentToLand(workspace: WorkspaceConfig, taskId: string, base = protectedBranchRef(workspace)): boolean {
  return branchMergeEffect(
    workspace,
    base,
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
  purpose = `Creating a PR for completed task "${task.title}" failed: ${error}`,
  tip: string | null = null,
): void {
  registerPrPromotionQuestion(db, task, `PR promotion failed: ${task.title}`, purpose, now, tip);
}

function registerPrPromotionQuestion(
  db: Db,
  task: Task,
  title: string,
  purpose: string,
  now: Date,
  tip: string | null,
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
      question_kind: { kind: "pr_promotion_retry", task_id: task.id, tip },
      workspace: task.workspace ?? undefined,
    },
    now,
    BOARD_ACTOR_ID,
    "board",
  );
}

/** ADR 0394 決定1 / ADR 0370 決定1: 問う内容は基準と比べずに読む。完全修飾 ref の解決に他の ref の曖昧さは要らない。 */
function questionTip(workspace: WorkspaceConfig, taskId: string): string | null {
  try {
    if (lstatSync(join(workspace.path, ".git"), { throwIfNoEntry: false }) === undefined) return null;
    return git(workspace.path, "-c", "core.warnAmbiguousRefs=false", "rev-parse", "--verify", "--quiet", `refs/heads/${taskBranch(taskId)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOTDIR") return null;
    if ((error as { status?: number } | null)?.status !== 1) throw error;
    return null;
  }
}

/** ADR 0079 決定3/4 / ADR 0229 決定4: retires a merge question whose PR turned out to be
 *  already merged or closed outside the board — or merged under the board's own name with the answer's record lost
 *  (ADR 0265 決定5), `kind` then being `pr_merged`. Deliberately not `answerQuestion`:
 *  nobody decided anything, so there is no `question_answered` event, no
 *  recorded option, and no recommendation-acceptance statistic — a "hold"
 *  submitted against an already-merged PR must never read back as a hold
 *  decision. Settles only a still-open question — the merged check is an
 *  awaited network read, so another path can settle it in that window, and
 *  a second observation must not re-stamp an already-closed question. Returns the root it recorded the outcome on, if any. */
function settleMergeQuestionAsObserved(
  db: Db,
  question: OpenMergeQuestion,
  kind: ReturnType<typeof prOutcomeKind>,
  now: Date,
): string | null {
  // ADR 0265 決定1: 決着(観測、または盤面の名義の merge の執行)は PR を開いた根に1回だけ刻み(収束が先に刻んでいれば
  // 重ねない)、question は回答なしの done で閉じる。根は question が持つ id で辿る(ADR 0399 決定2)
  const { root, pr_number: prNumber } = question;
  const recordOn = rootPrOutcome(db, root) === null ? root : null;
  return settleQuestionAsObserved(db, question.id, { kind, pr_number: prNumber }, now, recordOn) ? root : null;
}

/** 収束が着地を成立させたら、同じタスクを指す PR 昇格失敗の question はもう誰にも訊く
 *  ことがない(issue #406)。開いたままにすると `retry` が既に開いている PR へ PR の作成
 *  を撃ち、`abandon promotion` は「PR は無い」と事実と逆の決定を記録する。引退は上と同じ
 *  観測決着 —— 収束は人間の決定ではない。失敗 question が積み上がっている場合もあるので、
 *  答えている question(ADR 0106 決定5)を除く todo の行はすべて引退させる。 */
function settlePrPromotionQuestionsAsObserved(
  db: Db,
  taskId: string,
  now: Date,
  answering: Pick<ReadonlySet<string>, "has">,
): void {
  for (const id of openPrPromotionQuestionIds(db, taskId)) {
    if (!answering.has(id)) settleQuestionAsObserved(db, id, { kind: "pr_promotion_observed" }, now);
  }
}

/** ADR 0053 decision 3: a purely-local root completion cannot be promoted to a PR, so
 *  the board asks whether to land its task branch on the protected branch (a fast-forward,
 *  or a catch-up merge commit — ADR 0103) or hold it there — a hold declines only the content of that moment, and
 *  the question is asked again once the content changes (ADR 0289 決定3). The task id is deliberately stored
 *  separately from question_pending_merge_pr: one names a local branch while
 *  the other names a GitHub PR. */
export function registerLocalMergeQuestion(
  db: Db,
  task: Task,
  purpose: string,
  now: Date,
  tip: string | null = null,
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
      question_kind: { kind: "local_merge", task_id: task.id, tip },
      workspace: task.workspace ?? undefined,
    },
    now,
    BOARD_ACTOR_ID,
    "board",
  );
}

/** ADR 0289 決定3: hold の後に内容が変わった根の立て直しの purpose —— hold の head に無く、今のタスクブランチには届いた
 *  子孫のブランチ(届いた修理)を名指す。head が無いか比べられなければ、届いたものは名指さない。 */
function reaskedLocalMergePurpose(db: Db, workspace: WorkspaceConfig, task: Task, head: string | null): string {
  let arrived: string[] = [];
  try {
    if (head !== null) {
      const notYet = new Set(contentLeftBehindLocally(db, workspace, task.id, taskBranch(task.id)));
      arrived = contentLeftBehindLocally(db, workspace, task.id, head).filter((id) => id !== task.id && !notYet.has(id));
    }
  } catch {}
  const root = taskBranch(task.id);
  return (
    `Landing of completed task "${task.title}" was held, but ${root} no longer matches (or could not be compared with) ` +
    "the content held then" +
    (arrived.length > 0 ? ` — the content of ${arrived.map(taskBranch).join(", ")} has reached it since` : "") +
    ". Land its task branch on the protected branch now?"
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
  root: string;
}

function listOpenMergeQuestions(db: Db): OpenMergeQuestion[] {
  return db
    .prepare(
      `SELECT id, question_pending_merge_pr AS pr_number, workspace, question_pending_merge_task_id AS root FROM tasks
       WHERE type = 'question' AND status = 'todo' AND question_pending_merge_pr IS NOT NULL ORDER BY rowid`,
    )
    .all() as OpenMergeQuestion[];
}

function latestMergeQuestion(db: Db, rootId: string): Pick<Task, "id" | "status"> | undefined {
  return db.prepare(`SELECT id, status FROM tasks
    WHERE type = 'question' AND question_pending_merge_task_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(rootId) as Pick<Task, "id" | "status"> | undefined;
}

function clearPendingAutoMerge(db: Db, taskId: string): void {
  db.prepare("DELETE FROM pending_auto_merges WHERE task_id = ?").run(taskId);
}

/** PR が決着した(盤面が merge した、または盤面の外での merge・閉じたことを観測した)ので、キューにいれば
 *  外し、その事実を盤面の名義で残す。キューにいない PR の観測(収束が閉じた・merge 済みの PR を読んだとき)も同じ形で刻む。 */
function retireAutoMerge(
  db: Db,
  taskId: string,
  payload: { kind: "pr_merged" | (typeof OBSERVED)[keyof typeof OBSERVED]; pr_number: number },
  now: Date,
): void {
  // 外すことと記録を1つにする —— 片方だけで無言で消える経路を残さない(ADR 0105 決定3)
  db.transaction(() => {
    clearPendingAutoMerge(db, taskId);
    appendEvent(db, { taskId, actorId: BOARD_ACTOR_ID, origin: "board", payload, at: now });
  })();
}

function isQueuedForAutoMerge(db: Db, taskId: string): boolean {
  return db.prepare("SELECT 1 FROM pending_auto_merges WHERE task_id = ?").get(taskId) !== undefined;
}

const UNREPORTED_CI_GRACE_MS = 5 * 60_000;

/** 猶予を問い・拒否の本文に書くときの綴り —— 猶予の長さと本文がずれないように同じ定数から作る。 */
export const UNREPORTED_CI_GRACE_TEXT = `${UNREPORTED_CI_GRACE_MS / 60_000} minutes`;

/** 猶予の起点を問い・拒否の本文に書くときの綴り。 */
export const UNREPORTED_CI_GRACE_ORIGIN_TEXT = "the board first saw its current head";

/** その head を盤面が知った最初の event の時刻 —— 自分で push した `pr_opened` / `pr_branch_pushed` か、盤面の外の
 *  head を読んだ `pr_head_observed` のうち、sha が一致するもの。 */
function headKnownAt(db: Db, taskId: string, head: string): string | null {
  const { at } = db
    .prepare(
      `SELECT MIN(created_at) AS at FROM events WHERE task_id = ?
         AND kind IN ('pr_opened', 'pr_branch_pushed', 'pr_head_observed') AND json_extract(payload, '$.sha') = ?`,
    )
    .get(taskId, head) as { at: string | null };
  return at;
}

/** ADR 0231 決定4: 盤面が PR の head を読んだら、記録に無い head(盤面の外の push)だけを盤面名義で1件刻む。
 *  無人 merge の tick と人間の merge 回答の、head を返す読み取りの直後に呼ぶ。 */
export function observePrHead(db: Db, taskId: string, prNumber: number, head: string, now: Date): void {
  if (headKnownAt(db, taskId, head) !== null) return;
  appendEvent(db, {
    taskId,
    actorId: BOARD_ACTOR_ID,
    origin: "board",
    payload: { kind: "pr_head_observed", pr_number: prNumber, sha: head },
    at: now,
  });
}

/** 拒否文に列挙する commit の上限 —— 保護ブランチを merge した head は、その commit も全部並ぶ。 */
const LISTED_COMMITS = 10;

type MergeQuestionPrompt = {
  reason: PrMergeReason;
  detail: string;
  question: string;
  recommendation: (typeof MERGE_QUESTION_OPTIONS)[number];
};

type PrDiff = Pick<PrStateRead, "base" | "head">;
const COMMIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** ADR 0395 決定4: The live PR base may differ from the board's cached protected ref. */
function reviewHumanMergePaths(workspace: WorkspaceConfig, pr: PrDiff | undefined): HumanMergePathReview | undefined {
  if (!pr?.base) return { kind: "unreadable" };
  const expected = protectedBranch(workspace);
  if (pr.base.branch !== expected) return { kind: "retargeted", actual: pr.base.branch, expected };
  if (!COMMIT_OID.test(pr.base.sha) || !COMMIT_OID.test(pr.head)) return { kind: "unreadable" };
  try {
    const delta = treeDeltaEntries(workspace.path, pr.base.sha, pr.head);
    const paths = humanMergePathChanges(delta, workspace.human_merge_paths ?? []);
    if (paths.length > 0) return { kind: "matches", paths };
  } catch {
    return { kind: "unreadable" };
  }
}
/** 書き換えの question の盤面の部分が名指す欠けたブランチ(ADR 0394 決定1)。無ければ null。 */
function missingBranchesOf({ droppedBranches, unpushedBranches }: OutsidePush): string[] | null {
  const missing = [...droppedBranches, ...unpushedBranches];
  return missing.length === 0 ? null : missing;
}

/** ADR 0217 決定2: キューの行を外すことと問うことを1つにする。 */
function askMerge(
  db: Db,
  workspace: WorkspaceConfig,
  task: Task,
  pr: number,
  now: Date,
  head: string,
  origin: PrHeadOrigin,
  prompt?: MergeQuestionPrompt,
  mergePathReview?: HumanMergePathReview,
): string {
  const outsideBody = origin.kind === "rewritten" ? outsidePushQuestionBody(task, pr, origin.outside)
    : origin.kind === "not_pushed" ? notPushedQuestionBody(task, pr, head, origin.lastPushed) : undefined;
  if (outsideBody === undefined && prompt === undefined) throw new Error("a merge question must say why it was raised");
  // ADR 0394 決定1: 外の head を先に言い、CI や面の変化は後ろに添える。
  const purpose = outsideBody === undefined ? `${prompt!.detail} ${prompt!.question}`
    : prompt === undefined ? outsideBody : `${outsideBody}\n\n${prompt.detail}`;
  const tip = questionTip(workspace, task.id);
  const base = { pr, tip, reason: prompt?.reason ?? "outside_head" as const };
  const content: PrMergeQuestionContent = origin.kind === "rewritten"
    ? { ...base, outside: { kind: "rewritten", sha: head }, missingBranches: missingBranchesOf(origin.outside) }
    : { ...base, outside: origin.kind === "not_pushed" ? { kind: "not_pushed", sha: head } : null, missingBranches: null };
  return db.transaction(() => {
    clearPendingAutoMerge(db, task.id);
    return registerMergeQuestion(db, task, content, purpose, prompt?.recommendation ?? "hold", now, mergePathReview);
  })();
}

/** ADR 0376 決定7 / spec #3273 "Refused once": 内容が落ちた head への `merge` を拒む文 —— 作業台を開いてその head に「1回拒んだ」印を付ける。 */
function refuseOutsidePushOnce(workspace: WorkspaceConfig, base: string, taskId: string, prNumber: number, outside: OutsidePush, answerOn?: string): string {
  return outsidePushRefusal(workspace, base, taskId, { prNumber, head: outside.head, rewound: outside.rewound, lacks: lacksContentOf(outside), answerOn });
}

/** ADR 0394 決定3: question が問うていない外の部分への `merge` の回答の拒否 —— 今の外の部分で question を立て直し(決定2)、足された commit
 *  (`lastPushed..head`、ADR 0387 決定2 と同じ範囲)と立て直した question を名指す文を返す。呼び手はそれを投げる(立て直しは残る)。
 *  内容が落ちた head では作業台を開いてその head に「1回拒んだ」印を付け(ADR 0376 決定7)、拒否を1回にまとめる。`ciRed` は回答が読んだ
 *  CI が赤のとき —— 本文の後ろに1行添える(ADR 0394 決定1)。 */
export function refuseUnaskedHead(
  db: Db,
  workspace: WorkspaceConfig,
  workbenchBase: string,
  root: Task,
  { prNumber, head, origin, answeredQuestion, ciRed = false, pathReview }: {
    prNumber: number; head: string; origin: Exclude<PrHeadOrigin, { kind: "pushed" }>; answeredQuestion: string; ciRed?: boolean;
    pathReview?: HumanMergePathReview;
  },
  now: Date,
): string {
  const prompt: MergeQuestionPrompt | undefined = ciRed
    ? { detail: `"${root.title}"'s PR #${prNumber} has CI red.`, question: "Merge anyway, or hold?", reason: "ci_red", recommendation: "hold" }
    : undefined;
  const asked = askMerge(db, workspace, root, prNumber, now, head, origin, prompt, pathReview);
  const replaced = asked !== answeredQuestion;
  const closing = replaced ? ` This question is closed — question ${asked} now asks about this head; answer \`merge\` there to merge it.` : "";
  const lastPushed = origin.kind === "rewritten" ? origin.outside.lastPushed : origin.lastPushed;
  const subject = notPushedText.subject(prNumber, head);
  let commits: string[] | undefined;
  if (lastPushed !== undefined) {
    try {
      commits = git(workspace.path, "log", "--format=%H %s", `${lastPushed}..${head}`).split("\n").filter(Boolean);
    } catch {
      // 最後に push した値か head が手元に無い —— 列挙できない
    }
  }
  const log = lastPushed === undefined ? "" : notPushedText.log(lastPushed, head);
  const more = commits !== undefined && commits.length > LISTED_COMMITS ? `; and ${commits.length - LISTED_COMMITS} more — see them with ${log}` : "";
  const listed = commits === undefined || commits.length === 0 ? "" : `${commits.slice(0, LISTED_COMMITS).join("; ")}${more}`;
  if (origin.kind === "rewritten") {
    // 作業台の手順が答える question を名指すので、閉じたことだけを添える
    return `${refuseOutsidePushOnce(workspace, workbenchBase, root.id, prNumber, origin.outside, replaced ? asked : undefined)}` +
      `${listed === "" ? "" : ` The board did not push these commits on it: ${listed}.`}` +
      `${replaced ? ` This question is closed — question ${asked} now asks about this head.` : ""}`;
  }
  if (lastPushed === undefined) {
    return `${subject}${notPushedText.noRecord(prNumber)}, so it cannot list them — ${notPushedText.onGitHub}.${closing}`;
  }
  if (listed === "") {
    return `${subject} (the board last pushed ${lastPushed}), and it could not list them here — see them with ${log} in your own clone.${closing}`;
  }
  return `${subject} (the board last pushed ${lastPushed}): ${listed}.${closing}`;
}

/** ADR 0227 決定2: check 未報告を pending と同じに待つ猶予。猶予は head ごとで、起点は盤面がその head を知った
 *  時点。無人 merge と人間の merge 回答が同じ起点を読む。起点の無い head は猶予の中とする(fail-closed)——
 *  読み取りの直後の `observePrHead` が起点を刻むので、通常は起こらない。 */
export function unreportedCiGraceElapsed(db: Db, taskId: string, head: string, now: Date): boolean {
  const at = headKnownAt(db, taskId, head);
  return at !== null && now.getTime() - Date.parse(at) >= UNREPORTED_CI_GRACE_MS;
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
    actorId: BOARD_ACTOR_ID,
    origin: "board",
    payload: { kind: "landing_deferred", reason: block.kind, count: block.count },
    at: now,
  });
}

export function createLanding(deps: LandingDeps): Landing {
  const checked = (workspace: WorkspaceConfig) => withRememberedRepoCheck(deps.db, workspace, () => deps.clock.now(), deps.resolveWorkspace);
  const workbenchBase = resolveWorkspacesBaseDir(deps.workspacesDir);
  const mergePathReview = (workspace: WorkspaceConfig, pr: PrDiff | undefined, dial: MergeDial | undefined) => {
    if (dial === "external" || workspace.repo === undefined) return undefined;
    try {
      return reviewHumanMergePaths(deps.resolveWorkspace?.(workspace.name) ?? workspace, pr);
    } catch {
      return { kind: "unreadable" } as const;
    }
  };
  const reviewMergePaths: Landing["reviewMergePaths"] = (workspace, task, pr) => {
    try {
      const dial = isHumanAssigned(task) ? undefined : deps.resolveAuthority?.(task.assignee, task.type)?.merge;
      return mergePathReview(workspace, pr, dial);
    } catch {
      // The annotation must not block an already-required replacement question.
      return undefined;
    }
  };
  const readPrState = async (github: GitHubClient, workspace: WorkspaceConfig, number: number): Promise<PrStateRead> => {
    workspaceNetworkDestination(workspace);
    return github.getPullRequestState({ workspace, number });
  };
  /** ADR 0217 決定3: 解決できない profile はダイヤルを推測せず、agent 名の quarantine に落として
   *  その名前を返す。registry の無い盤面(resolver 無し)は profile 無しで解決する。
   *  ADR 0374 決定13: 人間の根は `human` を agent として引かず、profile なしで解決する。 */
  const readAuthority = (
    task: Task,
    now: Date,
  ): { profile: AuthorityProfile | undefined } | { quarantinedAgent: string } => {
    if (isHumanAssigned(task)) return { profile: undefined };
    try {
      return { profile: deps.resolveAuthority?.(task.assignee, task.type) };
    } catch (err) {
      if (!isUnresolvableAgentError(err)) throw err;
      quarantineAgent(deps.db, err.agentName, err, now);
      return { quarantinedAgent: err.agentName };
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
    askQuestion: (changed: string | null) => void,
    humanMergeRequired: boolean,
  ) => {
    const landing = landingSurface(
      deps.isProtectedWorkspace?.(workspaceName),
      false,
      authority?.merge,
      task.risk_flag,
      humanMergeRequired,
    );
    if (landing.surface === "auto_merge_queue") return false;
    deps.db.transaction(() => {
      clearPendingAutoMerge(deps.db, task.id);
      if (landing.surface === "outside_board") {
        appendEvent(deps.db, {
          taskId: task.id,
          actorId: BOARD_ACTOR_ID,
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
        human_merge_paths: null,
      }[landing.reason];
      askQuestion(changed);
    })();
    return true;
  };
  /** ADR 0376 決定7: 外の push が落とした内容を問う直前に profile → 門の順に読み直し(ADR 0217 決定1・ADR 0232)、
   *  止まればその verdict を返す。着地の面は読まない。 */
  const askOutsidePush = (workspace: WorkspaceConfig, task: Task, prNumber: number, outside: OutsidePush, pr: PrDiff | undefined): { question: string } | LandingVerdict => {
    // ADR 0288 決定2 / ADR 0394 決定2: 執行中の回答を閉じず、tick の読みを待つ間は収束が問い直せる。
    if (inFlight.get(task.id) === "write") return failedAnswer(prInFlightRefusal(prNumber));
    const now = deps.clock.now();
    const resolved = readAuthority(task, now);
    if (!("profile" in resolved)) return quarantined("agent", resolved.quarantinedAgent);
    const block = landingBlock(deps.db, task.id);
    if (block) return { kind: "deferred", reason: block.kind, count: block.count };
    return { question: askMerge(deps.db, workspace, task, prNumber, now, outside.head, { kind: "rewritten", outside }, undefined, mergePathReview(workspace, pr, resolved.profile?.merge)) };
  };
  /** 回答の取り込みが根の verdict に添えるもの: 作業台を残したときの text C6(`kept`)と、取り込んだこと(`takenIn`、text A10)。 */
  type IntakeOutcome = { kept: string[]; takenIn: boolean; reraised?: true };
  /** 収束の1回の、根ごとの文脈。`answering` は答えている question —— その根の PR 昇格失敗 question に retry が答えている途中なら
   *  (ADR 0106 決定5)失敗 question を立て直さず、答えている question を引退の対象から除く。`intake` はその回答の取り込みの束で、
   *  retry か、外の push が落とした内容の merge question への `merge`(entry `landing_merge`)が答えている途中であることを表す。 */
  type RootContext = { answering: ReadonlyMap<string, Answerer>; intake?: IntakeContext; outcome: IntakeOutcome };
  const readQuestionTip = (task: Task) => {
    let workspace: WorkspaceConfig | undefined;
    try {
      workspace = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace)?.(task.workspace);
    } catch (error) {
      if (!(error instanceof UnknownWorkspaceError)) throw error;
    }
    return workspace === undefined ? null : questionTip(workspace, task.id);
  };
  const retireFailures = (taskId: string, ctx: RootContext) =>
    settlePrPromotionQuestionsAsObserved(deps.db, taskId, deps.clock.now(), ctx.answering);
  const failed = (
    task: Task,
    reason: LandingFailureReason,
    error: unknown,
    ctx: RootContext,
  ): Extract<LandingVerdict, { kind: "failed" }> => {
    const message = error instanceof Error ? error.message : String(error);
    const verdict = { kind: "failed" as const, reason, error: message };
    if (!ctx.intake) {
      let tip: string | null;
      try {
        tip = readQuestionTip(task);
      } catch (tipError) {
        console.error(`[landing] could not read the question tip for root ${task.id}:`, tipError);
        return verdict;
      }
      // ADR 0371 決定11: 作業台を開いた時点で question が立つ場面は、本文がその在り処を言う —— 追いつきの conflict(text A2)と origin の盤面の
      // 知らない commit(text D1)の文そのもの。巻き戻しの文(text D2)も本文になる(ADR 0376 決定6)
      registerPrPromotionFailureQuestion(deps.db, task, message, deps.clock.now(), error instanceof PromotionStopError ? message : undefined, tip);
    }
    return verdict;
  };
  /** 答えている回答だけを拒む止まり —— 昇格失敗 question を立てない。 */
  const failedAnswer = (error: string): LandingVerdict => ({ kind: "failed", reason: "promotion_failed", error });
  const quarantined = (quarantine: Extract<QuarantineKind, "workspace" | "agent">, name: string): Extract<LandingVerdict, { kind: "quarantined" }> => ({
    kind: "quarantined",
    error:
      quarantine === "workspace"
        ? workspaceQuarantinedMessage(name)
        : `agent "${name}" is quarantined: its authority profile cannot be resolved for landing; repair the registry and answer its quarantine question`,
  });
  // ADR 0241 決定6: Quarantine が抱える根に着地の失敗 question を重ねない。
  const stopRootIfRefsMoved = (workspace: WorkspaceConfig) => {
    try {
      assertLandingRefs(deps.db, workspace, deps.resolveWorkspace, deps.clock.now());
    } catch (error) {
      if (error instanceof LandingRefsRefusedError) throw new RootStopped({ kind: "quarantined", error: error.message });
      throw error;
    }
  };
  const changedSince = (task: Task, declined: Declined, current?: DeclinedOutside) =>
    declinedContentChanged(buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace), task, declined, current);
  /** 閉じた観測を根に刻んだ直後(ADR 0265 決定6): 閉じた根に塞がれて走らない子があれば、盤面名義の判断行を1行流す。
   *  観測は根に1回だけ刻まれるので、行も1つの観測に1回。子が無ければ流さない。 */
  const announceClosed = (rootId: string, prNumber: number, now: Date) => {
    const blocking = closedRootOf(deps.db, buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace));
    const stranded = (
      deps.db
        .prepare(
          `${subtreeSql("?")} SELECT id, type, parent_id, workspace FROM tasks WHERE id IN (SELECT id FROM subtree) AND status = 'todo' ORDER BY rowid`,
        )
        .all(rootId) as Array<Pick<Task, "id" | "type" | "parent_id" | "workspace">>
    ).filter((task) => blocking(task)?.task_id === rootId);
    if (stranded.length === 0) return;
    logDecision(
      deps.db,
      getTask(deps.db, rootId)!,
      `PR #${prNumber} was closed outside the board, so ${stranded.length} task(s) under it will not run: ` +
        `${stranded.map(({ id }) => id).join(", ")}. To go on, reopen the PR on GitHub and merge it — once its content ` +
        "reaches the protected branch, they run and land as roots of their own. To stop, cancel them.",
      BOARD_ACTOR_ID,
      now,
      "board",
    );
  };
  /** キューの行を外して決着を根に刻む(`retireAutoMerge`)。閉じた観測なら判断行も流す。 */
  const retire = (taskId: string, payload: Parameters<typeof retireAutoMerge>[2], now: Date) => {
    retireAutoMerge(deps.db, taskId, payload, now);
    if (payload.kind === OBSERVED.CLOSED) announceClosed(taskId, payload.pr_number, now);
  };
  /** merge question を観測で閉じる(`settleMergeQuestionAsObserved`)。閉じた観測を根に刻んだなら判断行も流す。 */
  const settleObserved = (question: OpenMergeQuestion, kind: ReturnType<typeof prOutcomeKind>, now: Date) => {
    const root = settleMergeQuestionAsObserved(deps.db, question, kind, now);
    if (root !== null && kind === OBSERVED.CLOSED) announceClosed(root, question.pr_number, now);
  };
  const recordBoardFact = (taskId: string, payload: TaskScopedPayload) =>
    appendEvent(deps.db, { taskId, actorId: BOARD_ACTOR_ID, origin: "board", payload, at: deps.clock.now() });
  /** PR の根の着地は終わった —— 事実を根拠つきで1回刻み、以後この根は候補に入らない(ADR 0241 決定1 / ADR 0265 決定3)。 */
  const finishLanding = (
    task: Task,
    workspace: WorkspaceConfig,
    prNumber: number,
    basis: Extract<TaskScopedPayload, { kind: "landing_finished" }>["basis"],
    ctx: RootContext,
  ): LandingVerdict => {
    recordBoardFact(task.id, { kind: "landing_finished", pr_number: prNumber, basis });
    retireFailures(task.id, ctx);
    return { kind: "nothing_to_land", base: protectedBranchRef(workspace) };
  };
  const alreadyMerged = (task: Task, prNumber: number, ctx: RootContext) =>
    failed(
      task,
      "pull_request_already_merged",
      `PR #${prNumber} is already merged, but merge-backed repair work on ${taskBranch(task.id)} still has content to land`,
      ctx,
    );
  /** merge 済みの PR の根(ADR 0241 決定1): 保護ブランチの写しを読み直してから、根自身のブランチと比べる。子孫の積み残しは
   *  読まない —— merge の後に完了した子孫は、自分で根になる。 */
  const settleMerged = async (task: Task, workspace: WorkspaceConfig, prNumber: number, ctx: RootContext) => {
    await refreshProtectedBranch(deps.db, workspace, deps.githubAuth);
    stopRootIfRefsMoved(workspace);
    return taskHasContentToLand(workspace, task.id)
      ? alreadyMerged(task, prNumber, ctx)
      : finishLanding(task, workspace, prNumber, "merge", ctx);
  };
  // ADR 0236: 処理中の印。決着を書く経路はすべてこのプロセスの中にあるので、DB には持たない
  const inFlight = new Map<string, "write" | "auto_merge_read">();
  // ADR 0399 決定2: 鍵は PR を開いた根の id —— 登録し直した名前では、別の根が同じ番号の PR を持ちうる
  const isMarked = (rootId: string) => inFlight.has(rootId);
  const takeInFlightMark = (rootId: string, purpose: "write" | "auto_merge_read" = "write") => {
    if (inFlight.has(rootId)) return null;
    inFlight.set(rootId, purpose);
    return () => {
      inFlight.delete(rootId);
    };
  };
  /** 根ごとの手順(ADR 0241 決定1・3、spec #1839 A): 除外 → workspace の解決 → 運ぶ内容 → 門 → workspace の
   *  quarantine → ローカルか remote か → PR の有無と状態 → profile。lineage は導出(`landingRootOf`)が解いた。
   *  撃たずに外した根は undefined を返す。 */
  const landRoot = async (
    { task, outlivedForkSource, lineageError }: LandingRoot,
    answering: ReadonlyMap<string, Answerer>,
    outcome: IntakeOutcome,
  ): Promise<LandingVerdict | undefined> => {
    const open = openPrPromotionQuestionIds(deps.db, task.id);
    // ADR 0376 決定7・8: 外の push が落とした内容の merge question への `merge` は、取り込み → 追いつき → push をこの収束で通す
    const merging = [...answering.keys()].find((id) => {
      const answered = getTask(deps.db, id);
      return answered?.question_pending_merge_task_id === task.id;
    });
    const retrying = open.find((id) => answering.has(id));
    const question = retrying ?? merging;
    const entry = retrying === undefined ? "landing_merge" : "promotion_retry";
    const ctx: RootContext = {
      answering,
      intake: question === undefined ? undefined : { workbenchBase, entry, answerer: answering.get(question)!, now: () => deps.clock.now() },
      outcome,
    };
    // ADR 0394 決定2: 収束の列で待つ間に取り替えられた回答では作業台に触れない。
    const closedMergeAnswer = () => entry === "landing_merge" && question !== undefined && getTask(deps.db, question)?.status !== "todo"
      ? failedAnswer(new QuestionClosedError().message) : undefined;
    const closed = closedMergeAnswer();
    if (closed) return closed;
    /** ADR 0370 決定1: 断念・hold が写した tip を今のブランチと比べる前の比較。tip が無いか workspace を解決できなければ ref を読まない
     *  (`declinedContentChanged` は読まずに「変わった」と読む、ADR 0225 決定1 / ADR 0234 決定3)。比較そのものが落ちれば、比べていない
     *  ref で問い直さず根の失敗にする。 */
    const compareBeforeChangedSince = (tip: string | null): LandingVerdict | undefined => {
      if (tip === null) return undefined;
      let workspace: WorkspaceConfig | undefined;
      try {
        workspace = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace)?.(task.workspace);
      } catch {}
      if (!workspace) return undefined;
      try {
        stopRootIfRefsMoved(workspace);
      } catch (error) {
        if (error instanceof RootStopped) throw error;
        return failed(task, "promotion_failed", error, ctx);
      }
      return undefined;
    };
    // ADR 0240 決定2: 人間がまだ答えていない失敗 question を、盤面が先回りして潰さない
    if (open.length > 0 && !ctx.intake) return undefined;
    // 後始末が未了の木は、その merge back がまだ帰っていない(ADR 0240 決定2)。回の途中で後始末に入ることがあるので、撃つ直前に読む
    if (teardownUnfinishedUnder(deps.db, task.id) !== undefined) {
      return ctx.intake
        ? {
            kind: "excluded",
            reason: "teardown_unfinished",
            error: `a task under ${taskBranch(task.id)} is still in its teardown; answer again once it has finished`,
          }
        : undefined;
    }
    // ADR 0225 / ADR 0241 決定3: 断念した根には PR の有無によらず撃たない。門が開き、断念した内容から
    // 内容が変わっていれば、PR を開かず(profile も読まず)昇格の question を立て直す。retry はこの守りを外す
    const abandoned = ctx.intake ? undefined : declineInForce(deps.db, task.id, "pr_promotion_retry");
    if (abandoned) {
      // 門が閉じていれば他の理由より先に待つ(GLOSSARY.md「収束」)。待った記録は刻まない —— 立て直しは門が開いてから(ADR 0225 決定2)
      const block = landingBlock(deps.db, task.id);
      if (block) return { kind: "deferred", reason: block.kind, count: block.count };
      const failure = compareBeforeChangedSince(abandoned.payload.tip);
      if (failure) return failure;
      if (!changedSince(task, abandoned.payload)) return undefined;
      registerPrPromotionQuestion(
        deps.db,
        task,
        `PR promotion re-asked: ${task.title}`,
        `PR promotion for completed task "${task.title}" was abandoned, but ${taskBranch(task.id)} no longer matches ` +
          "(or could not be compared with) the content that question asked about. Promote the current content?",
        deps.clock.now(),
        readQuestionTip(task),
      );
      return {
        kind: "failed",
        reason: "promotion_failed",
        error: `the content of ${taskBranch(task.id)} differs from the content PR promotion abandoned`,
      };
    }
    // ADR 0289 決定3: ローカル着地の hold は断念と同じ形で読む —— 門が閉じていれば待ち(記録は刻まない)、hold した内容のままなら
    // 撃たず、変わっていれば通常の経路を進んで local merge question を立て直す。merge を執行した根は候補に入らない
    const held = ctx.intake ? undefined : declineInForce(deps.db, task.id, "local_merge");
    if (held) {
      const block = landingBlock(deps.db, task.id);
      if (block) return { kind: "deferred", reason: block.kind, count: block.count };
      const failure = compareBeforeChangedSince(held.payload.tip);
      if (failure) return failure;
      if (!changedSince(task, held.payload)) return undefined;
    }
    let resolvedWorkspace: string | undefined;
    try {
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      if (!resolve) {
        return failed(task, "workspace_unavailable", "no workspace is configured for landing", ctx);
      }
      let workspace: WorkspaceConfig;
      try {
        workspace = resolve(task.workspace);
      } catch (err) {
        if (!(err instanceof UnknownWorkspaceError)) throw err;
        quarantineWorkspace(deps.db, err.workspaceName, err, deps.clock.now());
        return quarantined("workspace", err.workspaceName);
      }
      resolvedWorkspace = workspace.name;
      workspace = checked(workspace);
      const remoteBacked = isRemoteBacked(workspace);
      // ADR 0241 決定7: push しても積み残しが消えなければ、着地したとは言わない —— quarantine が抱えていなければ失敗 question を1回立てる
      const afterPush = (landed: LandingVerdict, pushed: string): LandingVerdict => {
        stopRootIfRefsMoved(workspace);
        const left = contentLeftBehindLocally(deps.db, workspace, task.id, pushed);
        if (left.length === 0) {
          retireFailures(task.id, ctx);
          return landed;
        }
        if (workspaceNeedsHuman(deps.db, workspace.name)) return quarantined("workspace", workspace.name);
        const [root, branches] = [taskBranch(task.id), left.map(taskBranch).join(", ")];
        if (!ctx.intake) {
          registerPrPromotionQuestion(
            deps.db,
            task,
            `PR promotion left content behind: ${task.title}`,
            `Pushing ${root} for completed task "${task.title}" left content behind: the content of ${branches} ` +
              `has not reached ${root}. Answer \`retry\` and the board re-fires those merge backs. If one conflicts, the answer is ` +
              "refused and the refusal says where to resolve it.",
            deps.clock.now(),
            questionTip(workspace, task.id),
          );
        }
        return { kind: "failed", reason: "content_left_behind", error: `pushed ${root}, but the content of ${branches} has not reached it` };
      };
      // lineage が読めなかった候補は、根かどうか分からないまま人間に見せる(根ごとの失敗)
      if (lineageError !== undefined) return failed(task, "promotion_failed", lineageError, ctx);
      stopRootIfRefsMoved(workspace);
      // ADR 0371 決定10: retry は根の分解ツリーの届いていない merge back を受理と同じ条件(前半の項と clean を含む)で撃ち直してから収束する
      // (積み残しの question、text A5)。
      // conflict は作業台を開いて回答を拒む(text A1)
      if (ctx.intake?.entry === "promotion_retry" && !workspaceNeedsHuman(deps.db, workspace.name)) {
        const predicates = namePickupPredicates(deps.db, workspace.name, workspace, workbenchBase, deps.boardState);
        const firstHalf = () => checkAcceptanceFirstHalf(deps.db, workspace, predicates, true);
        ctx.outcome.kept.push(
          ...(await redoMergeBacks(deps.db, workspace, deps.workspace?.name, deps.githubAuth, ctx.intake, { root: task.id, firstHalf }, () => stopRootIfRefsMoved(workspace))),
        );
        stopRootIfRefsMoved(workspace);
      }
      const outcome = rootPrOutcome(deps.db, task.id);
      const mergedPr = outcome?.state === "MERGED" ? outcome.prNumber : undefined;
      // merge 済みの根は、保護ブランチの写しを読み直してから比べる —— merge の直後の写しは merge された内容をまだ持たない
      if (mergedPr !== undefined) {
        await refreshProtectedBranch(deps.db, workspace, deps.githubAuth);
        stopRootIfRefsMoved(workspace);
      }
      if (!taskHasContentToLand(workspace, task.id)) {
        if (mergedPr !== undefined) return finishLanding(task, workspace, mergedPr, "merge", ctx);
        // ADR 0265 決定3: merge の記録が無い PR の根は内容で終わる。キューの行と merge question は PR の状態の読み取りが閉じる
        if (task.pr_number !== null) return finishLanding(task, workspace, task.pr_number, "content", ctx);
        const base = protectedBranchRef(workspace);
        recordBoardFact(task.id, { kind: "nothing_to_land", base });
        retireFailures(task.id, ctx);
        return { kind: "nothing_to_land", base };
      }
      const block = landingBlock(deps.db, task.id);
      if (block) {
        recordLandingDeferred(deps.db, task.id, block, deps.clock.now());
        return { kind: "deferred", reason: block.kind, count: block.count };
      }
      // 門は quarantine より先に読む(ADR 0241 決定3)
      if (workspaceNeedsHuman(deps.db, workspace.name)) return quarantined("workspace", workspace.name);
      if (mergedPr !== undefined) return alreadyMerged(task, mergedPr, ctx);
      if (!remoteBacked) {
        const resolved = readAuthority(task, deps.clock.now());
        if (!("profile" in resolved)) return quarantined("agent", resolved.quarantinedAgent);
        // 保護を先に読む(ADR 0374 決定13)—— purely-local の保護された workspace の人間の根は C5 でなく、profile を持たないので
        // dial の無い根と同じ汎用の本文になる
        const landing = landingSurface(deps.isProtectedWorkspace?.(workspace.name), isHumanAssigned(task), resolved.profile?.merge, task.risk_flag);
        const purpose = held
          ? reaskedLocalMergePurpose(deps.db, workspace, task, held.payload.tip)
          : landing.surface === "merge_question" && landing.reason === "human_root"
            ? `"${task.title}" was completed by a human. A human-completed root is merged only on your answer. ` +
              `Merge it into ${protectedBranch(workspace)}, or hold?`
            : resolved.profile?.merge === "auto_if_ci_green"
            ? `Workspace "${workspace.name}" is purely-local, so CI cannot be observed and ` +
              `auto_if_ci_green cannot auto-merge "${task.title}". Land its task branch on the ` +
              `protected branch now?`
            : `Workspace "${workspace.name}" is purely-local and has no GitHub merge surface ` +
              `for "${task.title}". Land its task branch on the protected branch now?`;
        registerLocalMergeQuestion(deps.db, task, purpose, deps.clock.now(), questionTip(workspace, task.id));
        retireFailures(task.id, ctx);
        return { kind: "landed", form: "local_merge_question" };
      }
      // ADR 0241: 開いている PR の根は、積み残しがあるときだけ push する —— 無ければ GitHub を呼ばない
      // 外の push が落とした内容の `merge` は、最後に push した値と同じ tip でも head に戻す(ADR 0376 決定7)
      if (task.pr_number !== null && ctx.intake?.entry !== "landing_merge" && !hasContentLeftBehind(deps.db, workspace, task.id, lastPushedHead(deps.db, task.id))) {
        retireFailures(task.id, ctx);
        return { kind: "up_to_date", prNumber: task.pr_number };
      }
      if (!deps.github) {
        return failed(task, "github_not_configured", "GitHub is not configured for PR promotion", ctx);
      }
      // 追いつきは PR の状態を読んだ後に置く —— 閉じた・merge 済みの PR の根のタスクブランチは動かさない。
      // ADR 0376 決定8: retry は人間の tip の取り込み → 追いつき → push の順。conflict は作業台を開く(text A2)
      const catchUp = () => {
        if (!outlivedForkSource) return;
        const caughtUp = ctx.intake && takeInCatchUp(deps.db, workspace, task.id, ctx.intake);
        if (caughtUp) ctx.outcome.kept.push(caughtUp);
        // ADR 0371 決定11: conflict の拒否は答え直す回答を言う —— `merge` の中の追いつきなら `merge`
        catchUpTaskBranch(deps.db, workspace, task.id, workbenchBase, ctx.intake?.entry === "landing_merge" ? "merge" : "retry");
      };
      /** ADR 0376 決定1〜6・8: push すると決めた後・追いつきと push の前に GitHub の head(`prHead` は PR の読みが返した head、PR が無ければ
       *  origin のブランチを読む)を確かめる。origin にブランチが無ければ今どおり押す。PR の記録が無い巻き戻しは、作業台を開かずに止まる
       *  (text D2)—— retry の取り込みより前に決めるので、前の text D1 の作業台に tip が残っていても印も event も足さない(決定6)。
       *  それ以外は retry が人間の tip を先に取り込み、head が push する sha の祖先でなければ、盤面は merge も push もせず作業台を開いて
       *  止まる(text D1)。PR が記録済みで head が最後に push した値を欠く(書き換え・巻き戻し)ときは
       *  決定7 が持つ(`outsidePushStep`)。決定7 で止まれば verdict を返し、押してよければ undefined を返す。読めない head と text D1・D2 は
       *  今どおり投げる(昇格の失敗になる)。 */
      const checkHeadBeforePush = async (
        pr: PrDiff | undefined,
        foundPr?: number,
        questionBeforeRead?: ReturnType<typeof latestMergeQuestion>,
      ): Promise<LandingVerdict | undefined> => {
        const branch = taskBranch(task.id);
        // ADR 0376 決定2: 読めなかった head には push を撃たない(text D4)
        const unread = (error: unknown) => {
          return new Error(`could not read origin's ${branch} (${error instanceof Error ? error.message : String(error)}), so the board did not push.`);
        };
        let head: string | undefined;
        let fetch: (() => void) | undefined;
        try {
          head = pr?.head ?? (await readOriginBranchHead(deps.db, workspace, deps.githubAuth, branch));
          const fetching = head === undefined ? undefined : prepareFetchCommitIfMissing(deps.db, workspace, head, deps.githubAuth);
          fetch = fetching && (await fetching);
        } catch (error) {
          throw unread(error);
        }
        const closed = closedMergeAnswer();
        if (closed) return closed;
        // head の読みと token の await の後、fetch が交渉用の ref を読む前・取り込み・追いつき・tip の読みの前(ADR 0370 決定1)
        stopRootIfRefsMoved(workspace);
        try {
          fetch?.();
        } catch (error) {
          throw unread(error);
        }
        if (head === undefined) return undefined;
        const prNumber = task.pr_number;
        const outside = prNumber === null ? undefined : outsidePushOf(workspace, task.id, head, leftBehindTargets(deps.db, workspace, task.id), lastPushedHead(deps.db, task.id));
        const answeringMerge = ctx.intake?.entry === "landing_merge";
        // ADR 0394 決定3: 寄り道の中で読んだ書き換えが答えている question の問うた head と違えば、立て直して拒む —— 回答の2回目の読みと
        // 同じ拒否で、拒否を1回にまとめる
        const answered = answeringMerge && outside ? getTask(deps.db, question!) : undefined;
        if (prNumber !== null && outside && answered && (answered.question_pr_merge_outside_kind !== "rewritten" || answered.question_pr_merge_outside_sha !== head)) {
          if (inFlight.get(task.id) === "write") return failedAnswer(prInFlightRefusal(prNumber));
          ctx.outcome.reraised = true;
          return failedAnswer(refuseUnaskedHead(
            deps.db, workspace, workbenchBase, task, {
              prNumber, head, origin: { kind: "rewritten", outside }, answeredQuestion: answered.id, pathReview: reviewMergePaths(workspace, task, pr),
            }, deps.clock.now(),
          ));
        }
        if (prNumber !== null && outside && !answeringMerge) {
          // ADR 0265 決定1: head を待つ間に決着した PR には、古い観測から merge question を立てない。
          const settled = rootPrOutcome(deps.db, task.id);
          if (settled?.state === "MERGED") return settleMerged(task, workspace, settled.prNumber, ctx);
          if (settled?.state === "CLOSED") return closedPr(settled.prNumber);
          const current = latestMergeQuestion(deps.db, task.id);
          if (current?.id !== questionBeforeRead?.id || current?.status !== questionBeforeRead?.status) {
            if (current?.status !== "todo") return failedAnswer(`PR #${prNumber}'s merge question closed while the board was reading its head`);
            if (ctx.intake) return failedAnswer(`PR #${prNumber}'s merge question changed — answer question ${current.id} (\`merge\`)`);
            return { kind: "landed", form: "merge_question", prNumber };
          }
          // ADR 0394 決定6・7: PR の hold が効き内容が同じなら問い直さない。retry は hold を外して新しく立てる(決定6)
          const prHold = ctx.intake ? undefined : declineInForce(deps.db, task.id, "pr_merge");
          if (prHold && !changedSince(task, prHold.payload, { outside: { kind: "rewritten", sha: head }, missing_branches: missingBranchesOf(outside) })) {
            return { kind: "awaiting_held_question", prNumber, question: prHold.payload.question_id };
          }
          return outsidePushStep(prNumber, outside, pr);
        }
        const refuse = (pushed: OutsidePush) => failedAnswer(refuseOutsidePushOnce(workspace, workbenchBase, task.id, task.pr_number!, pushed));
        // spec #3273 "Refused once": 印がこの head でなければ、作業台を開いて拒む —— 作業台があるだけでは印でない
        if (outside && refusedOnceHead(workspace, workbenchBase, task.id) !== head) return refuse(outside);
        const rewound = task.pr_number === null ? rewindStop(workspace, task.id, head, foundPr) : undefined;
        if (rewound) throw rewound;
        const taken = ctx.intake && takeInOutsideHead(deps.db, workspace, task.id, head, ctx.intake);
        if (taken) {
          ctx.outcome.takenIn = true;
          if (taken.kept) ctx.outcome.kept.push(taken.kept);
        }
        // ADR 0376 決定4・7: 書き換えた head を人間が作業台で merge していなければ、盤面は押せない(外の commit を盤面は merge しない)——
        // retry を言う text D1 でなく、同じ拒否を言い直す
        if (outside && !isAncestor(workspace, head, `refs/heads/${taskBranch(task.id)}`)) return refuse(outside);
        const outsideStop = outsideCommitsStop(workspace, workbenchBase, task.id, head);
        if (outsideStop) throw outsideStop;
        return undefined;
      };
      /** ADR 0376 決定7 / ADR 0394 決定2: 収束はキューの行を外して外の部分を問い、別の失敗で開いていた昇格失敗
       *  question への retry はその question を id で名指して拒む(text D3b)。 */
      const outsidePushStep = (prNumber: number, outside: OutsidePush, pr: PrDiff | undefined): LandingVerdict => {
        const asked = askOutsidePush(workspace, task, prNumber, outside, pr);
        if (!("question" in asked)) return asked;
        if (ctx.intake) {
          return failedAnswer(
            `PR #${prNumber}'s head was ${outside.rewound ? "moved back" : "rewritten"} outside the board — answer question ${asked.question} (\`merge\`); ` +
              "its first `merge` opens a workbench.",
          );
        }
        // 開いていた question も同じ形 —— 根の着地はその question を待つ
        return { kind: "landed", form: "merge_question", prNumber };
      };
      const closedPr = (prNumber: number): LandingVerdict => ({
        kind: "failed",
        reason: "pull_request_closed",
        error: `PR #${prNumber} was closed outside the board, so ${taskBranch(task.id)} is not pushed to it`,
      });
      // 盤面の push は写しを動かすので、口を通す(ADR 0243)
      const { github } = deps;
      let authority: AuthorityProfile | undefined;
      const push = async (sha: string) => {
        const pushBranch = await github.preparePush({ workspace, branch: taskBranch(task.id) });
        return actIfGateOpen<null, LandingVerdict>(() => {
          const closed = closedMergeAnswer();
          if (closed) return closed;
          // ADR 0370 決定1: 準備の await の間に動いた ref があれば、確かめた sha も運ばない —— 比較と push を同じ同期区間に置く
          stopRootIfRefsMoved(workspace);
          const block = landingBlock(deps.db, task.id);
          if (block) {
            recordLandingDeferred(deps.db, task.id, block, deps.clock.now());
            return { kind: "deferred", reason: block.kind, count: block.count };
          }
          if (workspaceNeedsHuman(deps.db, workspace.name)) return quarantined("workspace", workspace.name);
          if (task.pr_number === null) {
            const resolved = readAuthority(task, deps.clock.now());
            if (!("profile" in resolved)) return quarantined("agent", resolved.quarantinedAgent);
            authority = resolved.profile;
          }
          return null;
        }, async () => {
          boardRefWriter(deps.db, workspace)(remoteTrackingRef(taskBranch(task.id)), sha, () => pushBranch(sha));
          return null;
        });
      };
      if (task.pr_number !== null) {
        const prNumber = task.pr_number;
        // ADR 0394 決定2: PR を読む間に開いた、または答えられた question を、古い head で取り替えない。
        const before = latestMergeQuestion(deps.db, task.id);
        const pr = await deps.github.getPullRequestState({ workspace, number: prNumber });
        const { state, mergedBy } = pr;
        // 決着した PR は1回だけ刻み、キューからも外す —— tick が同じ観測を重ねない。盤面の外の決着は観測、落ちた盤面
        // 自身の merge は執行(ADR 0265 決定5)。
        // 印の付いた PR の決着は執行側が書く。印と根の決着は await の後に見る —— 読んでいる間に遅い走査が
        // 根へ刻んだ観測を重ねない(ADR 0236 決定3)
        if (state !== "OPEN" && !isMarked(task.id) && rootPrOutcome(deps.db, task.id) === null) {
          retire(task.id, { kind: prOutcomeKind(state, mergedBy), pr_number: task.pr_number }, deps.clock.now());
        }
        if (state === "MERGED") return await settleMerged(task, workspace, task.pr_number, ctx);
        // ADR 0241 決定3: 盤面の外で閉じられた PR には push しない。人間の close を question で問い返さない
        if (state === "CLOSED") return closedPr(task.pr_number);
        const stopped = await checkHeadBeforePush(pr, undefined, before) ?? closedMergeAnswer();
        if (stopped) return stopped;
        catchUp();
        const sha = taskBranchTip(workspace, task.id);
        // ADR 0387 決定4: push の前から最後に push した値を書くまで、tick と人間の merge 回答と同じ PR の印を持つ —— その間に読まれた
        // 盤面自身の head を、盤面の push していない head と読ませない。取れなければ撃たず次の突きへ回す(回答の中の収束なら答え直させる)。
        // 決着の読み(上の `isMarked`)は印を取る前に読んだ
        const release = takeInFlightMark(task.id);
        if (!release) return ctx.intake ? failedAnswer(prInFlightRefusal(task.pr_number)) : undefined;
        try {
          const refusal = await push(sha);
          if (refusal) return refusal;
          // push の直後に刻む —— 後段が throw しても、GitHub に載った head の猶予の起点は失わない(ADR 0227 決定2)
          recordBoardFact(task.id, { kind: "pr_branch_pushed", pr_number: task.pr_number, sha });
        } catch (error) {
          // 転送の後に失敗と報告された push(ADR 0243 決定2 の形)も、origin に載っていれば盤面の push —— 印を持ったまま1度だけ読んで刻む。
          // 刻まなければ、次の tick と回答は盤面自身の commit を盤面の push していない head と読む(ADR 0387 決定1)。読めなければ刻まない
          if (!(error instanceof RootStopped)) {
            const landed = await readOriginBranchHead(deps.db, workspace, deps.githubAuth, taskBranch(task.id)).catch(() => undefined);
            if (landed === sha) recordBoardFact(task.id, { kind: "pr_branch_pushed", pr_number: task.pr_number, sha });
          }
          throw error;
        } finally {
          release();
        }
        // 拒否が伝えた head は push で上書きされた —— 同じ head へまた動かされれば、新しい外の push としてもう一度拒む
        clearRefusedOnce(workspace, workbenchBase, task.id);
        return afterPush({ kind: "landed", form: "open_pull_request_updated", prNumber: task.pr_number }, sha);
      }
      // ADR 0241 決定4: 作る前に同じタスクブランチの PR を探す —— 作成の後・記録の前に落ちた盤面が2つ目を作らない
      const found = await deps.github.findPullRequestByHead({ workspace, branch: taskBranch(task.id) });
      if (found && found.state !== "OPEN") {
        // 名義を見ない —— 盤面は記録した PR 番号にしか merge を撃たないので、番号の記録が無い PR は盤面の merge ではない
        const observed = { kind: OBSERVED[found.state], pr_number: found.number };
        deps.db.transaction(() => {
          recordPrNumber(deps.db, task.id, found.number);
          retire(task.id, observed, deps.clock.now());
        })();
        if (found.state === "MERGED") return await settleMerged(task, workspace, found.number, ctx);
        return {
          kind: "failed",
          reason: "pull_request_closed",
          error: `PR #${found.number} on ${taskBranch(task.id)} was closed outside the board, so no PR is opened`,
        };
      }
      const stopped = await checkHeadBeforePush(found ?? undefined, found?.number);
      if (stopped) return stopped;
      catchUp();
      // profile を読むのは面を開く時点だけ —— 開いている PR への push は読まない(ADR 0217 決定3)
      const resolved = readAuthority(task, deps.clock.now());
      if (!("profile" in resolved)) return quarantined("agent", resolved.quarantinedAgent);
      const sha = taskBranchTip(workspace, task.id);
      let prNumber: number;
      if (found) {
        // 見つけた開いている PR にも、作るときと同じく今のタスクブランチを押してから記録する —— 落ちた後に帰った修理も載る
        const refusal = await push(sha);
        if (refusal) return refusal;
        prNumber = found.number;
      } else {
        const { title } = await contentSourceFor(task, deps.github, () => workspace).expand();
        // PR の作成は push 済みのブランチに作成の要求だけを撃つ —— その失敗や所要時間は予告の範囲に入らない
        const refusal = await push(sha);
        if (refusal) return refusal;
        const created = await deps.github.createPullRequest({
          workspace,
          branch: taskBranch(task.id),
          base: protectedBranch(workspace),
          title,
          body: prBody(task.handoff_doc, task.github_issue_number),
        });
        prNumber = created.number;
      }
      const dial = authority?.merge;
      const humanRoot = isHumanAssigned(task);
      let protectedWorkspace = deps.isProtectedWorkspace?.(workspace.name);
      const inspectPr = dial !== "external" && (dial !== undefined || protectedWorkspace || humanRoot);
      // ADR 0395 決定4: Check the actual PR diff, including when an earlier PR creation was recovered.
      const openedPr = inspectPr ? await readPrState(github, workspace, prNumber).catch((error) => {
        if (error instanceof WorkspaceRepoMismatchError) throw error;
        return undefined;
      }) : undefined;
      if (inspectPr) protectedWorkspace = deps.isProtectedWorkspace?.(workspace.name);
      recordPrOpened(
        deps.db,
        task,
        prNumber,
        sha,
        resolveTaskAgent(task, deps.defaultAgentName, deps.auditorName ?? DEFAULT_AUDITOR_NAME, deps.interviewerName ?? DEFAULT_INTERVIEWER_NAME),
        deps.clock.now(),
        authority,
        protectedWorkspace,
        // spec #3273 group C の [spec] は人間の根の pr_opened だけに origin board を決めた —— actor が人間でも開いたのは盤面だと読めるように。
        // agent の根の origin はこの決定の外(actor は今どおり assignee)
        humanRoot ? "board" : "worker",
        inspectPr ? mergePathReview(workspace, openedPr, dial) : undefined,
      );
      return afterPush({ kind: "landed", form: "pull_request_opened", prNumber }, sha);
    } catch (error) {
      if (error instanceof RootStopped) throw error;
      // 読めなかった根を workspace の quarantine が抱えていれば、失敗 question を重ねない(ADR 0241 決定6)
      if (resolvedWorkspace !== undefined && workspaceNeedsHuman(deps.db, resolvedWorkspace)) {
        return quarantined("workspace", resolvedWorkspace);
      }
      return failed(task, "promotion_failed", error, ctx);
    }
  };
  /** ADR 0397 決定3: 失われた event が効いている根(受理の後で根になった task を含む)は、着地させる前に受理と同じ判定で終える —— 失われた
   *  ブランチを git で読まない。昇格失敗の question が開いている根は終えずに `landRoot` へ渡す —— 人間がまだ答えていない失敗 question を
   *  先回りして潰さない(ADR 0240 決定2)。閉じるのは受理だけ(ADR 0397 決定2)。終えなければ undefined。 */
  const endLostRoot = ({ task, workspace }: LandingRoot): LandingVerdict | undefined => {
    if (!workspace || !taskBranchLostInForce(deps.db, task.id) || openPrPromotionQuestionIds(deps.db, task.id).length > 0) return undefined;
    return endLostRootLanding(deps.db, workspace, task, deps.clock.now(), { closeQuestions: false }) ? { kind: "nothing_to_land", base: protectedBranchRef(workspace) } : undefined;
  };
  /** 収束の1回(ADR 0241 決定1): 根を導き、根ごとに撃つ。根ごとの失敗はその根に閉じ込め、回は残りの根へ進む。
   *  候補の読み取りそのものの失敗はログに出して回を終え、次の突きで走り直す。 */
  const pass = async (answering: ReadonlyMap<string, Answerer>): Promise<RootVerdict[]> => {
    let ids: string[];
    try {
      ids = landingCandidateIds(deps.db);
    } catch (error) {
      console.error("[landing] reading the landing roots failed; the next trigger runs the convergence again:", error);
      return [];
    }
    const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
    const verdicts: RootVerdict[] = [];
    // 候補ごとに、撃つ直前に根かを導く —— 同じ回で先に終わった根の子孫が、取り残されずにこの回で自分で根になる(ADR 0265 決定3・帰結)
    for (const id of ids) {
      const outcome: IntakeOutcome = { kept: [], takenIn: false };
      const record = (verdict: LandingVerdict) =>
        verdicts.push({
          taskId: id,
          verdict,
          ...(outcome.kept.length > 0 && { notice: outcome.kept.join("\n") }),
          ...(outcome.takenIn && { takenIn: true as const }),
          ...(outcome.reraised && { reraised: true as const }),
        });
      try {
        const root = landingRootOf(deps.db, resolve, id, (workspace) => protectedBranchRef(checked(workspace)), stopRootIfRefsMoved);
        const verdict = root && (endLostRoot(root) ?? (await landRoot(root, answering, outcome)));
        if (verdict) record(verdict);
      } catch (error) {
        if (error instanceof RootStopped) {
          record(error.verdict);
          continue;
        }
        console.error(`[landing] landing root ${id} failed; the pass goes on with the rest:`, error);
        // ADR 0394 決定4: 例外で verdict を落とすと、回答の拒否文が「根でなくなった」と事実と違うことを言う
        const message = error instanceof Error ? error.message : String(error);
        record({ kind: "failed", reason: "landing_failed", error: `the board failed to land task ${id} (${message}); answer again` });
      }
    }
    // ADR 0394 決定4: 回答が待つ根をこの回が飛ばしたなら、なぜかを verdict にする —— 回答はそれで拒まれる
    for (const questionId of answering.keys()) {
      const taskId = answeredRootOf(deps.db, questionId);
      if (!taskId || verdicts.some((root) => root.taskId === taskId)) continue;
      verdicts.push({ taskId, verdict: exclusionOf(deps.db, taskId) });
    }
    return verdicts;
  };
  // ADR 0241 決定2: 着地の書き込みの列。プロセス内の状態として持つ(ADR 0236 の印と同じ理由で DB には持たない)。
  // 走っている間の突きは捨てず、まだ始まっていない次の1回に束ねる —— 呼び手は自分の呼び出しより後に始まる回の結果を受け取る
  let tail: Promise<unknown> = Promise.resolve();
  let queued: { answering: Map<string, Answerer>; run: Promise<RootVerdict[]> } | undefined;
  let stopped = false;
  const landing: Landing = {
    reviewMergePaths,
    converge(options) {
      if (!queued) {
        if (stopped) return Promise.resolve([]);
        const answering = new Map<string, Answerer>();
        const run = tail.then(async () => {
          try {
            await deps.pickupIdle?.();
          } finally {
            queued = undefined;
          }
          return pass(answering);
        });
        queued = { answering, run };
        // 回の rejection はその回の呼び手だけが受け取る —— 列には持ち越さない(#2400)
        tail = run.catch(() => undefined);
      }
      if (options?.answering !== undefined) queued.answering.set(options.answering.question, options.answering.answerer);
      return queued.run;
    },
    async stop() {
      stopped = true;
      await tail;
    },
    async observePullRequestOutcome(question) {
      const { question_pending_merge_pr: prNumber, question_pending_merge_task_id: root } = question;
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      if (prNumber === null || root === null || !resolve || !deps.github) return false;
      // ADR 0265 決定4: 読めなければ回答を拒む(「観測しなかった」に倒すと merge 済みの PR への hold が残る)。
      // 決着の書き込みの失敗も呼び手(回答)へ投げる
      let read: PrStateRead;
      try {
        read = await readPrState(deps.github, checked(resolve(question.workspace)), prNumber);
      } catch (error) {
        if (error instanceof WorkspaceRepoMismatchError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new DomainError(`PR #${prNumber}'s state could not be read (${reason}), so the answer was not accepted`);
      }
      // 印の付いた PR の決着は執行側が書く。印は await の後に見る(ADR 0236 決定3)
      if (read.state === "OPEN" || isMarked(root)) return false;
      settleObserved({ id: question.id, workspace: question.workspace, pr_number: prNumber, root }, prOutcomeKind(read.state, read.mergedBy), deps.clock.now());
      return true;
    },
    // ADR 0217 決定5: agent 名の quarantine に落ちた agent のキューの PR は、tick の観測
    // (ADR 0079 決定3)に届かない。merge された・閉じられたもの(ADR 0229 決定4)は回答の受理直前にここで決着を
    // 刻む —— 盤面の名義の merge(落ちた後)は執行、それ以外は観測(ADR 0265 決定5)。読めない PR は飛ばす —— キューに残り、着地待ちに数えられる。
    async observeAutoMergeOutcomes(agentName) {
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      const github = deps.github;
      if (!resolve || !github) return;
      for (const { task_id, pr_number } of listPendingAutoMerges(deps.db)) {
        const task = getTask(deps.db, task_id);
        if (task?.type !== "work" || (task.assignee ?? deps.defaultAgentName) !== agentName) continue;
        let read: PrStateRead;
        try {
          read = await readPrState(github, checked(resolve(task.workspace)), pr_number);
        } catch {
          continue;
        }
        // 印は await の後に見る —— 前に見ると、await の間に執行側が印を取れる。印の付いた PR の決着は
        // 執行側が書く(ADR 0236 決定3)。キューの確認は、quarantine 回答が重なったときの観測同士の競合を防ぐ
        if (read.state === "OPEN" || isMarked(task_id) || !isQueuedForAutoMerge(deps.db, task_id)) continue;
        retire(task_id, { kind: prOutcomeKind(read.state, read.mergedBy), pr_number }, deps.clock.now());
      }
    },
    async tick(kind, now) {
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      const github = deps.github;
      if (!resolve || !github) return;
      if (kind === "outside_merge") {
        for (const question of listOpenMergeQuestions(deps.db)) {
          const { id, pr_number, workspace: taskWorkspace } = question;
          try {
            const workspace = resolveOrQuarantine(deps.db, resolve, taskWorkspace, now);
            if (!workspace) continue;
            // 状態が読めない(網・認証)回は黙って次の tick へ回す —— 瞬断のたびにログを出さない
            const read = await readPrState(github, checked(workspace), pr_number).catch(() => null);
            // 印は await の後に見る —— merge 回答が merge 中の PR の決着は回答が書く(ADR 0236 決定3)
            if (read && read.state !== "OPEN" && !isMarked(question.root)) {
              settleObserved(question, prOutcomeKind(read.state, read.mergedBy), now);
            }
          } catch (error) {
            // ADR 0229 決定1: 分類できない失敗はログに出し、その question は open のまま残して次へ進む
            console.error(`[landing] outside-merge scan of PR #${pr_number} (question ${id}) failed; it stays open:`, error);
          }
        }
        return;
      }
      // ADR 0229 決定1: 失敗は PR ごとに閉じ込める —— 分類できない失敗はログに出し、その行はキューに残る
      for (const { task_id, pr_number } of listPendingAutoMerges(deps.db)) {
        let release: (() => void) | null = null;
        try {
          const task = getTask(deps.db, task_id);
          if (!task) continue;
          // 印は await の前に同期で取り、どの抜け方でも finally で放す。重なった tick は印の付いた PR を飛ばす(ADR 0236)。
          // 一覧は tick の始めに読んだものなので、重なった tick が決着させて外した行もここに来る —— 印を取った後にまだ
          // キューにあるかを確かめる
          release = takeInFlightMark(task_id, "auto_merge_read");
          if (!release || !isQueuedForAutoMerge(deps.db, task_id)) continue;
          const resolved = resolveOrQuarantine(deps.db, resolve, task.workspace, now);
          if (!resolved) continue;
          const workspace = checked(resolved);
          workspaceNetworkDestination(workspace);
          // 盤面の名義の行為(merge / merge question)の直前に profile → 門 → 着地の面の順で読み直す(ADR 0217 決定1・
          // ADR 0232)。CI を読む前は profile と門だけを読み、面は PR の状態の後で読む —— 閉じた PR は面に依らず観測になり、
          // CI 赤の PR に立つのは CI 赤の question になる(ADR 0238 決定1)。門に当たった PR はキューに残り、面が変わった
          // PR はキューを外れる。profile が読めなければ agent を quarantine に落とし、キューに残してこの回は飛ばす(ADR 0217 決定3)
          const authorityIfGateOpen = () => {
            const resolved = readAuthority(task, now);
            return "profile" in resolved && !landingBlock(deps.db, task_id) ? resolved : undefined;
          };
          if (!authorityIfGateOpen()) continue;
          const ref = { workspace, number: pr_number };
          // 状態は CI と同じ読み取りで、行為の前に読む(ADR 0229 決定2)。閉じた PR は CI の色に依らず観測になる
          const pr = await github.readPullRequest(ref);
          if (!isQueuedForAutoMerge(deps.db, task_id)) continue;
          if (pr.state === "MERGED" || pr.state === "CLOSED") {
            retire(task_id, { kind: prOutcomeKind(pr.state, pr.mergedBy), pr_number }, now);
            continue;
          }
          // 状態が読めなければ、面が変わっていてもキューに残す(ADR 0238 決定3)
          if (pr.state === "unreadable") continue;
          observePrHead(deps.db, task_id, pr_number, pr.head, now);
          const { ci, head } = pr;
          let pathReview: HumanMergePathReview | undefined;
          const stop = (askQuestion: (changed: string | null) => void, observedPr: PrDiff = pr) => {
            // ADR 0394 決定2: GitHub を待つ間に収束がキューを外して問うたら、古い読みで立て直さない。
            if (!isQueuedForAutoMerge(deps.db, task_id)) return true;
            workspaceNetworkDestination(workspace);
            const resolved = authorityIfGateOpen();
            if (!resolved) return true;
            // ADR 0395 決定4: decide on the same head CI read and merge would pin, with the current declaration.
            pathReview = mergePathReview(workspace, observedPr, resolved.profile?.merge);
            return withdrawIfSurfaceChanged(task, resolved.profile, pr_number, workspace.name, now, askQuestion, pathReview !== undefined);
          };
          // tick は印を持って読むので、収束の push と記録の間の値を読まない(ADR 0387 決定4)
          const lastPushed = lastPushedHead(deps.db, task_id);
          const red = ci === "failure" || (ci === "unreported" && unreportedCiGraceElapsed(deps.db, task_id, head, now));
          const ciPrompt: MergeQuestionPrompt | undefined = red
            ? {
                detail: `"${task.title}"'s auto_if_ci_green auto-merge ` +
                  (ci === "failure"
                    ? `found CI red on PR #${pr_number}`
                    : `found no CI check reported on PR #${pr_number} in the ${UNREPORTED_CI_GRACE_TEXT} since ` +
                      `${UNREPORTED_CI_GRACE_ORIGIN_TEXT}, so its CI-green condition cannot be observed`) +
                  ".",
                question: "Merge anyway, or hold?",
                reason: ci === "failure" ? "ci_red" : "ci_unreported",
                recommendation: "hold",
              }
            : undefined;
          // 積み残しは門と同じくキューに残す(ADR 0231 決定3)。CI を読んだ head と比べ、手元に無ければ sha で取る
          // (ADR 0242 決定1)。比べられなければ null(積み残し)。fetch を待つので面の読み直しより前に読む。
          // 最後に push した値と違う head は CI の色に依らず出所を読む(ADR 0387 決定1)
          const content =
            ci === "success" || head !== lastPushed
              ? await checkPrMergeContent(deps.db, workspace, task_id, { number: pr_number, head, lastPushed }, {
                auth: deps.githubAuth,
                compareRefs: () => assertLandingRefs(deps.db, workspace, deps.resolveWorkspace, now),
              }).catch((error) => {
                if (error instanceof WorkspaceRepoMismatchError || error instanceof LandingRefCheckError) throw error;
                return null;
              })
              : null;
          // 比べられなかった head は、最後に push した値と違えば祖先関係を確かめられない head と読む(ADR 0387 決定1)
          const origin: PrHeadOrigin = content?.head ?? (head === lastPushed ? { kind: "pushed" } : { kind: "not_pushed", lastPushed });
          const ask = (prompt?: MergeQuestionPrompt) => askMerge(deps.db, workspace, task, pr_number, now, head, origin, prompt, pathReview);
          const askSurface = (changed: string | null) => {
            if (changed === null && origin.kind !== "pushed") {
              ask(ciPrompt);
              return;
            }
            ask(ciPrompt ?? {
              detail: `"${task.title}"'s PR #${pr_number} was queued for auto_if_ci_green auto-merge` +
                (changed === null ? "." : `, but its landing surface changed after it was queued: ${changed}.`),
              question: changed === null ? "Merge it now, or hold?" : "Merge it now?",
              reason: "surface_changed",
              recommendation: "merge",
            });
          };
          await actIfGateOpen(() => stop(askSurface) ? true : null, async () => {
            // ADR 0394 決定1 / ADR 0387 決定1: 外の head は CI の色を待たずに問う。
            if (origin.kind !== "pushed" || ciPrompt !== undefined) {
              ask(ciPrompt);
              return;
            }
            if (ci !== "success" || !content || content.left.length > 0) return;
            // ADR 0394 決定2 / ADR 0288 決定2: 読みの間と違い、merge の執行中は収束が question を立てない。
            inFlight.set(task_id, "write");
            // merge は CI を読んだ head に固定する(ADR 0231 決定1)
            const stoppedBeforeMerge = Symbol();
            const failure = await github.mergePullRequest(ref, head, () => {
              // ADR 0330 決定1: Registry changes during token acquisition must reach the final guard.
              assertLandingRefs(deps.db, workspace, deps.resolveWorkspace, now);
              if (stop(askSurface) || hasContentLeftBehind(deps.db, workspace, task_id, head)) throw stoppedBeforeMerge;
            }).then(
              () => null,
              (error: unknown) => {
                if (error instanceof WorkspaceRepoMismatchError || error instanceof LandingRefCheckError) throw error;
                if (error === stoppedBeforeMerge) return stoppedBeforeMerge;
                return error instanceof Error ? error.message : String(error);
              },
            );
            if (failure === stoppedBeforeMerge) return;
            if (failure === null) {
              retire(task_id, { kind: "pr_merged", pr_number }, now);
              return;
            }
            // merge の失敗の後に状態と head を読み直す。読めなければ分類できない失敗(ADR 0229 決定3)
            const after = await github.readPullRequest(ref);
            if (!isQueuedForAutoMerge(deps.db, task_id)) return;
            if (after.state === "unreadable") {
              throw new Error(`merge failed (${failure}) and PR #${pr_number} could not be re-read`);
            }
            if (after.state !== "OPEN") {
              retire(task_id, { kind: prOutcomeKind(after.state, after.mergedBy), pr_number }, now);
              return;
            }
            observePrHead(deps.db, task_id, pr_number, after.head, now);
            // head が動いただけなら、次の tick で新しい head の CI を読む(ADR 0231 決定1)。gh の文面では見分けない
            if (after.head !== head) return;
            const askFailure = () => ask({
              detail: `"${task.title}"'s auto_if_ci_green auto-merge could not merge PR #${pr_number}: ${failure}.`,
              question: `Merge once it is fixed, or hold?${conflictedPrRoute(pr_number, protectedBranch(workspace))}`,
              reason: "merge_failed",
              recommendation: "hold",
            });
            // merge を待つ間に変わりうるので、question の前に読み直す
            if (!stop(askFailure, after)) askFailure();
          });
        } catch (error) {
          if (error instanceof WorkspaceRepoMismatchError || error instanceof LandingRefsRefusedError) continue;
          console.error(`[landing] auto-merge of PR #${pr_number} (task ${task_id}) failed; it stays queued:`, error);
        } finally {
          release?.();
        }
      }
    },
    isMarked,
    takeInFlightMark,
  };
  return landing;
}
