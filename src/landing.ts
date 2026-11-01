import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "./actor-id.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { DEFAULT_AUDITOR_NAME, DEFAULT_INTERVIEWER_NAME } from "./defaults.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, latestEventOfTask, type TaskScopedPayload } from "./events.js";
import { git } from "./git.js";
import type { GitHubClient, PrStateRead } from "./github.js";
import { type GitHubAuth, remoteTrackingRef } from "./github-auth.js";
import { GITHUB_APP_SLUG } from "./github-login.js";
import { isRemoteBacked } from "./pickup-predicates.js";
import { type QuarantineKind, quarantineAgent } from "./quarantine.js";
import { type QuestionColumns, questionKindOf } from "./question-kind.js";
import { type AuthorityProfile, isUnresolvableAgentError } from "./registry.js";
import {
  ancestorsSql,
  type ClosedRootOf,
  contentSourceFor,
  countUnsettledAttachedChildren,
  derivedWorkspace,
  getTask,
  landingSurface,
  localLandingOpenOrExecutedSql,
  logDecision,
  MERGE_QUESTION_OPTIONS,
  PR_PROMOTION_FAILURE_OPTIONS,
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
  taskIdForPr,
} from "./tasks.js";
import { activeTriageSession } from "./triage.js";
import type { LandingState, RootSettledByObservation, SettledByObservation } from "./wire-contract.js";
import {
  boardRefWriter,
  branchMergeEffect,
  buildWorkspaceResolver,
  catchUpTaskBranch,
  fetchCommitIfMissing,
  lineageTaskBranch,
  protectedBranch,
  protectedBranchRef,
  quarantineWorkspace,
  refreshProtectedBranch,
  resolveOrQuarantine,
  resolveTaskBranchLineage,
  taskBranch,
  taskBranchExists,
  taskBranchTip,
  UnknownWorkspaceError,
  type WorkspaceConfig,
  type WorkspaceResolver,
  workspaceNeedsHuman,
} from "./workspace.js";

export type LandingVerdict =
  | { kind: "nothing_to_land"; base: string }
  | { kind: "deferred"; reason: LandingBlock["kind"]; count: number }
  | {
      kind: "landed";
      form: "local_merge_question" | "pull_request_opened" | "open_pull_request_updated";
      prNumber?: number;
    }
  // 開いている PR に積み残しが無い —— push も GitHub の読み取りもしない(ADR 0241)
  | { kind: "up_to_date"; prNumber: number }
  // retry が答えている根を、この回の収束は撃たなかった(ADR 0241 決定5)。error は回答の拒否文
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
        | "promotion_failed";
      error: string;
    };

export type LandingBlock = { kind: "attached_children" | "objections"; count: number };

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
      const held = holdEventInForce(db, task.id);
      return (
        task.pr_number === null &&
        // ADR 0289 決定3: hold した内容のままの根は、断念の根と同じく着地を待たない。変わった根は立て直しを待つ
        ((!abandonEventInForce(db, task.id) && !(held && !contentChangedSince(resolve, task, held.payload.head))) ||
          openPrPromotionQuestionIds(db, task.id).length > 0)
      );
    });
  return [...roots, ...listPendingAutoMerges(db).map(({ task_id }) => getTask(db, task_id)!)];
}

/** ADR 0225 決定1: 刻んだ head から内容が変わったか(ADR 0105 と同じ比較)。読めなければ「変わった」—— 修理を捨てない側。
 *  workspace を解決できない場合も「変わった」と読むのは ADR 0234 決定3。ローカル着地の hold も同じ比較で読む(ADR 0289 決定3) */
function contentChangedSince(resolve: WorkspaceResolver | undefined, task: Task, head: string | null): boolean {
  if (head === null || !resolve) return true;
  try {
    return branchMergeEffect(resolve(task.workspace), head, taskBranch(task.id)).changesCandidate;
  } catch {
    return true;
  }
}

/** ADR 0289 決定1・3: ローカル着地の hold は、merge を執行していない間、最新のものが効く —— 立て直した question への
 *  hold は head を刻み直し、merge は執行の記録で根を終わらせる */
function holdEventInForce(db: Db, taskId: string) {
  if (latestEventOfTask(db, taskId, "local_merge_executed")) return undefined;
  return latestEventOfTask(db, taskId, "local_merge_held");
}

/** ADR 0225 決定2: 断念は人間の最新の明示の判断である間だけ効く。その間は断念の event を返す —— 後の retry が
 *  PR を開くか push していれば、断念はその retry に置き換わっている */
function abandonEventInForce(db: Db, taskId: string) {
  const abandoned = latestEventOfTask(db, taskId, "pr_promotion_abandoned");
  if (!abandoned) return undefined;
  const landedAfter = db
    .prepare("SELECT 1 FROM events WHERE task_id = ? AND kind IN ('pr_opened', 'pr_branch_pushed') AND id > ?")
    .get(taskId, abandoned.id);
  return landedAfter === undefined ? abandoned : undefined;
}

export function landingBlock(db: Db, taskId: string): LandingBlock | null {
  const attached = countUnsettledAttachedChildren(db, taskId);
  if (attached > 0) return { kind: "attached_children", count: attached };
  const objections = countUnbundledObjections(db, taskId);
  return objections > 0 ? { kind: "objections", count: objections } : null;
}

/** ADR 0231 決定2 / ADR 0239 / ADR 0242: 積み残し —— 盤面が持つ着地の内容が、まだ PR の head に載っていない。着地する
 *  タスク自身と、cancelled の祖先を挟まない done の work の子孫それぞれのブランチを、呼び手が渡す head(candidate)と
 *  ADR 0105 の内容の述語で比べ、1つでも candidate を変えれば積み残しとする。merge の門は GitHub が報告した head を
 *  `fetchMissing` 付きで、収束は盤面が最後に push した head を渡す。head を candidate に置くので、盤面の外の push で先へ
 *  進んでいても積み残しと読まない。ブランチが無ければ運ぶ内容も無い。比べられなければ積み残しとする(fail-closed)。
 *  門(`landingBlock`)とは別の述語である(ADR 0231 決定3)。 */
async function hasContentLeftBehind(
  db: Db,
  workspace: WorkspaceConfig,
  taskId: string,
  candidate: string | undefined,
  fetchMissing?: { auth: GitHubAuth | undefined },
): Promise<boolean> {
  try {
    return (await contentLeftBehind(db, workspace, taskId, candidate, fetchMissing)).length > 0;
  } catch {
    return true;
  }
}

/** 積み残しを運ぶタスクの id —— 比べられなければ throw する。比べるブランチがあるときだけ candidate を読み、`fetch` が
 *  あれば手元に無い candidate を origin から取る。 */
export async function contentLeftBehind(
  db: Db,
  workspace: WorkspaceConfig,
  taskId: string,
  candidate: string | undefined,
  fetchMissing?: { auth: GitHubAuth | undefined },
): Promise<string[]> {
  const targets = leftBehindTargets(db, workspace, taskId);
  if (fetchMissing && candidate !== undefined && targets.length > 0) {
    await fetchCommitIfMissing(workspace, candidate, fetchMissing.auth);
  }
  return targetsLeftBehind(workspace, taskId, targets, candidate);
}

/** `contentLeftBehind` の fetch 無しの経路 —— 同期で、I/O の await を挟まない(ADR 0289 決定2 / ADR 0288 決定2)。 */
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
  ).filter((id) => taskBranchExists(workspace, id));
}

/** ADR 0242 決定2: 盤面が最後に push した head(`pr_opened` / `pr_branch_pushed` の sha)—— 収束が積み残しを比べる相手 */
function lastPushedHead(db: Db, taskId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT json_extract(payload, '$.sha') AS sha FROM events
        WHERE task_id = ? AND kind IN ('pr_opened', 'pr_branch_pushed') ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { sha: string | null } | undefined;
  return row?.sha ?? undefined;
}

/** ADR 0242 決定4: GitHub の head に無い内容(`left`)があり、盤面が最後に push した head と比べれば積み残しが無いなら、
 *  盤面の外の push が落としたもので盤面には運ぶ手が無い。そのとき、外の push の事実・届いていない子孫のブランチ(子孫が
 *  無ければ着地するタスク自身)・直す手段2つ(捨てる側は GitHub の head から始め直す)を言う文を返す。最後に push した
 *  head とも比べられなければ、落としたとは読まない(盤面がまだ運ぶ側) */
export async function outsidePushDropNotice(
  db: Db,
  workspace: WorkspaceConfig,
  taskId: string,
  left: string[],
  pr: { number: number; head: string },
): Promise<string | undefined> {
  if (left.length === 0 || (await hasContentLeftBehind(db, workspace, taskId, lastPushedHead(db, taskId)))) return undefined;
  const descendants = left.filter((id) => id !== taskId);
  const branches = (descendants.length > 0 ? descendants : left).map(taskBranch).join(", ");
  return (
    `PR #${pr.number}'s head ${pr.head} was pushed outside the board and lacks the content of ${branches} — push that ` +
    `content back onto ${taskBranch(taskId)}, or, to discard it, reset ${taskBranch(taskId)} in the workspace to that head ` +
    `(\`git fetch origin\` then \`git reset --hard origin/${taskBranch(taskId)}\`), record \`git merge -s ours\` of it there ` +
    `and push`
  );
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
      // `recordPrOpened` が PR 番号を記録してから merge question を立てるので、根は必ず引ける(`taskIdForPr`)
      landingTaskId = taskIdForPr(db, kind.pr, task.workspace);
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
    case "cli_auth_expiry_warning":
      return null;
  }
  return { blocked_by: landingBlock(db, landingTaskId)?.kind ?? null };
}

export type RootVerdict = { taskId: string; verdict: LandingVerdict };

/** 盤面がまだ着地を運ぶ根(GLOSSARY.md「着地」)。`outlivedForkSource` は lineage が読んだ事実で、PR を開く前の追いつきに
 *  使う。`lineageError` は lineage が読めなかった候補 —— 根かどうか分からないので、根として人間に失敗を見せる。 */
interface LandingRoot {
  task: Task;
  outlivedForkSource: boolean;
  lineageError?: unknown;
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
      for (let current: Pick<Task, "type" | "parent_id"> = task; ; ) {
        const branch = lineageTaskBranch(db, workspace, current);
        const target = ancestors.find((a) => taskBranch(a.id) === branch);
        if (!target) return null;
        const outcome = rootPrOutcome(db, target.id);
        if (outcome?.state === "CLOSED") {
          return taskHasContentToLand(workspace, target.id) ? { task_id: target.id, pr_number: outcome.prNumber } : null;
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
export function settledByObservation(db: Db, question: Pick<Task, "id" | "workspace" | "question_pending_merge_pr">): SettledByObservation | null {
  const row = db
    .prepare(
      `SELECT status = 'done' AND NOT EXISTS (SELECT 1 FROM events WHERE task_id = tasks.id AND kind = 'question_answered') AS observed,
         (SELECT kind FROM events WHERE task_id = tasks.id AND kind IN (${QUESTION_RECORDED_SQL}) ORDER BY id DESC LIMIT 1) AS kind
         FROM tasks WHERE id = ?`,
    )
    .get(question.id) as { observed: number; kind: SettledByObservation | null };
  if (!row.observed) return null;
  if (question.question_pending_merge_pr === null) return row.kind;
  const outcome = rootPrOutcome(db, taskIdForPr(db, question.question_pending_merge_pr, question.workspace));
  return outcome && (outcome.observed ? OBSERVED[outcome.state] : "pr_merged");
}

/** done の work の着地の状態(ADR 0265 決定7): 根の PR の決着 → 無人 merge キュー → 開いた merge question → 内容で
 *  終わった(`landing_finished`)→ キューからの取り下げ、の順に記録から導く。内容で終わっても決裁は残る(決定3)ので、
 *  生きているキューの行と merge question を先に言う。done の work でない行と、どれも無い行(PR を開く前で止まっている根・
 *  根でない行)は null。キューに残る理由は名指さない(#1866)。 */
export function landingState(db: Db, task: Pick<Task, "id" | "type" | "workspace" | "pr_number"> & { status: string }): LandingState | null {
  if (task.type !== "work" || task.status !== "done") return null;
  const outcome = rootPrOutcome(db, task.id);
  if (outcome) return outcome.state === "CLOSED" ? "close_observed" : outcome.observed ? "merge_observed" : "merged";
  if (isQueuedForAutoMerge(db, task.id)) return "auto_merge_queue";
  if (listOpenMergeQuestions(db).some((q) => q.pr_number === task.pr_number && q.workspace === task.workspace)) return "merge_question";
  if (latestEventOfTask(db, task.id, "landing_finished")) return "landed";
  return latestEventOfTask(db, task.id, "auto_merge_withdrawn") ? "withdrawn" : null;
}

/** 着地が終わった根の記録(ADR 0265 決定3 の内容で終わった根を含む)。これを持つ行は候補にも、子孫を外す根にもならない。 */
const LANDING_ENDED_KINDS = "('landing_finished', 'nothing_to_land')";

/** 収束の根の候補の id を rowid の順(祖先が子孫より先)に返す —— SQL だけで、git は読まない。候補を SQL で先に絞り、
 *  lineage は候補にだけ解く(`landingRootOf`)ので、1回の git の呼び出しの数は着地の終わっていない木の大きさに比例し、
 *  盤面の歴史の長さには比例しない。外すのは、着地が終わった根(merge の記録か内容で終わった PR の根の `landing_finished`
 *  (ADR 0265 決定3) / `nothing_to_land`)と、ローカル着地が人間の手にあるか執行した根(ADR 0289 決定1)である。hold した根は
 *  候補に残り、撃つ側が hold の head と比べる(`landRoot`)。人間が担当した work は盤面の
 *  タスクブランチに内容を持たないので、根にしない(人間の完了は祖先の着地の契機である)。Interview の子(pin を持つ
 *  work)は使い捨てブランチで走り、ブランチを残すだけで着地しない(ADR 0199)。 */
function landingCandidateIds(db: Db): string[] {
  return db
    .prepare(
      `SELECT t.id FROM tasks t
        WHERE t.type = 'work' AND t.status = 'done' AND t.assignee IS NOT '${HUMAN_ACTOR_ID}'
          AND t.interview_target_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.kind IN ${LANDING_ENDED_KINDS})
          AND NOT ${localLandingOpenOrExecutedSql("t.id")}
        ORDER BY t.rowid`,
    )
    .pluck()
    .all() as string[];
}

/** ADR 0241 決定1 / ADR 0240 決定2: 候補が収束の根ならその根を返す —— 記録と内容から導き、読むだけで書かない
 *  (quarantine にも落とさない)。収束の回と着地を待つ完了タスクの数えはどちらもこれを通る。盤面の外で閉じた PR の根は
 *  lineage の前に根の PR の決着の読み(`rootPrOutcome`)で外す。PR が開いている根の子孫も lineage の前に記録で外す
 *  (`openPrRootAbove`、ADR 0265 帰結 —— ADR 0250 決定3 を置き換えた): 根の内容が別の経路で保護ブランチに届けば根は
 *  内容で終わり(ADR 0265 決定3)、子孫は次に導くとき自分で根になる。今の記録を読むので、同じ回で先に終わった根の子孫は
 *  その回で自分で根になる。閉じた根と断念した根の子孫は記録で外さず、lineage に任せる(ADR 0250 決定1・2)—— 閉じた根には
 *  push せず、断念した根には撃たないので、どちらの根も子孫を運ばない。lineage が祖先のブランチへ帰る done の work は根では
 *  ない。workspace を解決できない候補と lineage が読めない候補は根かどうか分からないので根として返し、撃つ側がその根の
 *  失敗として人間に見せる。後始末が未了の木は、撃つ直前に根ごとに読む(`landRoot`)。 */
function landingRootOf(db: Db, resolve: WorkspaceResolver | undefined, id: string): LandingRoot | undefined {
  if (rootPrOutcome(db, id)?.state === "CLOSED" || openPrRootAbove(db, id)) return undefined;
  const task = getTask(db, id)!;
  let workspace: WorkspaceConfig | undefined;
  try {
    workspace = resolve?.(task.workspace);
  } catch {}
  if (!workspace) return { task, outlivedForkSource: false };
  try {
    const lineage = resolveTaskBranchLineage(db, workspace, task);
    return lineage.branch ? undefined : { task, outlivedForkSource: lineage.outlivedForkSource };
  } catch (lineageError) {
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
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.kind IN ${LANDING_ENDED_KINDS})`,
    )
    .all(id) as Array<{ id: string; prNumber: number }>;
  return unfinishedPrAncestors.find(
    (ancestor) =>
      rootPrOutcome(db, ancestor.id) === null &&
      !abandonEventInForce(db, ancestor.id) &&
      openPrPromotionQuestionIds(db, ancestor.id).length === 0,
  );
}

/** retry が答えている根を回が候補にしなかった理由(ADR 0241 決定5)。error は回答の拒否文。 */
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
  return { kind: "excluded", reason: "not_a_root", error: `task ${taskId} is no longer awaiting PR promotion` };
}

/** 根の木(根自身を含む)に、後始末が未了の行があるか —— その後始末の merge back がまだ根へ帰っていない(ADR 0240 決定2)。 */
function teardownUnfinishedUnder(db: Db, taskId: string): boolean {
  return (
    db.prepare(`${subtreeSql("?")} SELECT 1 FROM tasks WHERE id IN (SELECT id FROM subtree) AND teardown_started_at IS NOT NULL`).get(taskId) !==
    undefined
  );
}

export interface Landing {
  /** ADR 0241 決定1・2・5: 収束を突き、その回で扱った根ごとの verdict を返す。走っている回があれば、その後に
   *  ちょうど1回走る回の結果を返す。retry だけが `answering`(答えている PR 昇格失敗 question)を渡す —— その回は
   *  その question を開いていないと読み、引退の対象からも除く(ADR 0106 決定5)。 */
  converge(options?: { answering?: string }): Promise<RootVerdict[]>;
  /** 回答受理直前のバックストップ(ADR 0079 決定3)。merge 済み・閉じた PR を観測で決着させたら true、該当しない
   *  (PR 番号・GitHub・workspace が無い)か PR が開いている・印が付いていれば false。PR を読めなければ DomainError を
   *  投げる(ADR 0265 決定4)。 */
  observePullRequestOutcome(question: Task): Promise<boolean>;
  observeAutoMergeOutcomes(agentName: string): Promise<void>;
  tick(kind: "auto_merge" | "outside_merge", now: Date): Promise<void>;
  /** ADR 0236 決定2・3: 執行する経路が PR に処理中の印を取り、印を放す関数を返す。既に印が付いていれば取らずに
   *  null を返す。`workspace` はタスクの `workspace` 列の値(未解決のまま)。 */
  takeInFlightMark(workspace: string | null, prNumber: number): (() => void) | null;
  /** 印が付いているかを読むだけ —— 執行しない回答が印の付いた PR を拒むための口(ADR 0288 決定2)。 */
  isMarked(workspace: string | null, prNumber: number): boolean;
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
      question_kind: { kind: "pr_promotion_retry", task_id: task.id },
      workspace: task.workspace ?? undefined,
    },
    now,
    BOARD_ACTOR_ID,
    "board",
  );
}

export function openPrPromotionQuestionIds(db: Db, taskId: string): string[] {
  return (
    db.prepare("SELECT id FROM tasks WHERE question_pending_pr_promotion_task_id = ? AND status = 'todo'").all(taskId) as Array<{
      id: string;
    }>
  ).map(({ id }) => id);
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
  appendEvent(db, {
    taskId,
    actorId: BOARD_ACTOR_ID,
    origin: "board",
    payload: { kind: "pr_promotion_abandoned", head: taskBranchHeadOrNull(resolve, taskWorkspace, taskId) },
    at: now,
  });
}

/** 断った内容として刻むタスクブランチの今の tip(ADR 0225 決定1 / ADR 0289 決定3)。workspace もブランチも読めなければ null。 */
export function taskBranchHeadOrNull(
  resolve: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined,
  taskWorkspace: string | null,
  taskId: string,
): string | null {
  try {
    if (resolve) return git(resolve(taskWorkspace).path, "rev-parse", "--verify", "--quiet", `refs/heads/${taskBranch(taskId)}`);
  } catch {}
  return null;
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
  question: Pick<Task, "id" | "workspace">,
  prNumber: number,
  kind: ReturnType<typeof prOutcomeKind>,
  now: Date,
): string | null {
  // ADR 0265 決定1: 決着(観測、または盤面の名義の merge の執行)は PR を開いた根に1回だけ刻み(収束が先に刻んでいれば
  // 重ねない)、question は回答なしの done で閉じる
  const root = taskIdForPr(db, prNumber, question.workspace);
  const recordOn = rootPrOutcome(db, root) === null ? root : null;
  return settleQuestionAsObserved(db, question.id, { kind, pr_number: prNumber }, now, recordOn) ? root : null;
}

/** 収束が着地を成立させたら、同じタスクを指す PR 昇格失敗の question はもう誰にも訊く
 *  ことがない(issue #406)。開いたままにすると `retry` が既に開いている PR へ `gh pr create`
 *  を撃ち、`abandon promotion` は「PR は無い」と事実と逆の決定を記録する。引退は上と同じ
 *  観測決着 —— 収束は人間の決定ではない。失敗 question が積み上がっている場合もあるので、
 *  答えている question(ADR 0106 決定5)を除く todo の行はすべて引退させる。 */
function settlePrPromotionQuestionsAsObserved(
  db: Db,
  taskId: string,
  now: Date,
  answering: ReadonlySet<string>,
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
      question_kind: { kind: "local_merge", task_id: task.id },
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
  /** ADR 0217 決定3: 解決できない profile はダイヤルを推測せず、agent 名の quarantine に落として
   *  その名前を返す。registry の無い盤面(resolver 無し)は profile 無しで解決する。 */
  const readAuthority = (
    task: Task,
    now: Date,
  ): { profile: AuthorityProfile | undefined } | { quarantinedAgent: string } => {
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
      }[landing.reason];
      askQuestion(changed);
    })();
    return true;
  };
  /** 収束の1回の、根ごとの文脈。`answered` は、その根の PR 昇格失敗 question に retry が答えている途中であること
   *  (ADR 0106 決定5) —— 失敗 question を立て直さず、答えている question を引退の対象から除く。 */
  type RootContext = { answering: ReadonlySet<string>; answered: boolean };
  const retireFailures = (taskId: string, ctx: RootContext) =>
    settlePrPromotionQuestionsAsObserved(deps.db, taskId, deps.clock.now(), ctx.answering);
  const failed = (
    task: Task,
    reason: LandingFailureReason,
    error: unknown,
    ctx: RootContext,
  ): Extract<LandingVerdict, { kind: "failed" }> => {
    const message = error instanceof Error ? error.message : String(error);
    if (!ctx.answered) {
      registerPrPromotionFailureQuestion(deps.db, task, message, deps.clock.now());
    }
    return { kind: "failed", reason, error: message };
  };
  const quarantined = (quarantine: Extract<QuarantineKind, "workspace" | "agent">, name: string): LandingVerdict => ({
    kind: "quarantined",
    error:
      quarantine === "workspace"
        ? `workspace "${name}" is quarantined and needs human attention before landing; answer its quarantine question`
        : `agent "${name}" is quarantined: its authority profile cannot be resolved for landing; repair the registry and answer its quarantine question`,
  });
  const changedSince = (task: Task, head: string | null) =>
    contentChangedSince(buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace), task, head);
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
  const settleObserved = (
    question: Pick<Task, "id" | "workspace">,
    prNumber: number,
    kind: ReturnType<typeof prOutcomeKind>,
    now: Date,
  ) => {
    const root = settleMergeQuestionAsObserved(deps.db, question, prNumber, kind, now);
    if (root !== null && kind === OBSERVED.CLOSED) announceClosed(root, prNumber, now);
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
    return taskHasContentToLand(workspace, task.id)
      ? alreadyMerged(task, prNumber, ctx)
      : finishLanding(task, workspace, prNumber, "merge", ctx);
  };
  // ADR 0236: 処理中の印。決着を書く経路はすべてこのプロセスの中にあるので、DB には持たない
  const inFlight = new Set<string>();
  const markKey = (workspace: string | null, prNumber: number) => JSON.stringify([workspace, prNumber]);
  const isMarked = (workspace: string | null, prNumber: number) => inFlight.has(markKey(workspace, prNumber));
  /** 根ごとの手順(ADR 0241 決定1・3、spec #1839 A): 除外 → workspace の解決 → 運ぶ内容 → 門 → workspace の
   *  quarantine → ローカルか remote か → PR の有無と状態 → profile。lineage は導出(`landingRootOf`)が解いた。
   *  撃たずに外した根は undefined を返す。 */
  const landRoot = async (
    { task, outlivedForkSource, lineageError }: LandingRoot,
    answering: ReadonlySet<string>,
  ): Promise<LandingVerdict | undefined> => {
    const open = openPrPromotionQuestionIds(deps.db, task.id);
    const ctx: RootContext = { answering, answered: open.some((id) => answering.has(id)) };
    // ADR 0240 決定2: 人間がまだ答えていない失敗 question を、盤面が先回りして潰さない
    if (open.length > 0 && !ctx.answered) return undefined;
    // 後始末が未了の木は、その merge back がまだ帰っていない(ADR 0240 決定2)。回の途中で後始末に入ることがあるので、撃つ直前に読む
    if (teardownUnfinishedUnder(deps.db, task.id)) {
      return ctx.answered
        ? {
            kind: "excluded",
            reason: "teardown_unfinished",
            error: `a task under ${taskBranch(task.id)} is still in its teardown; answer again once it has finished`,
          }
        : undefined;
    }
    // ADR 0225 / ADR 0241 決定3: 断念した根には PR の有無によらず撃たない。門が開き、刻んだ head から
    // 内容が変わっていれば、PR を開かず(profile も読まず)昇格の question を立て直す。retry はこの守りを外す
    const abandoned = ctx.answered ? undefined : abandonEventInForce(deps.db, task.id);
    if (abandoned) {
      // 門が閉じていれば他の理由より先に待つ(GLOSSARY.md「収束」)。待った記録は刻まない —— 立て直しは門が開いてから(ADR 0225 決定2)
      const block = landingBlock(deps.db, task.id);
      if (block) return { kind: "deferred", reason: block.kind, count: block.count };
      if (!changedSince(task, abandoned.payload.head)) return undefined;
      registerPrPromotionQuestion(
        deps.db,
        task,
        `PR promotion re-asked: ${task.title}`,
        `PR promotion for completed task "${task.title}" was abandoned. An attached child ` +
          `settled afterwards, and ${taskBranch(task.id)} no longer matches (or could not be ` +
          `compared with) the content abandoned then. Promote the current content?`,
        deps.clock.now(),
      );
      return {
        kind: "failed",
        reason: "promotion_failed",
        error: `the content of ${taskBranch(task.id)} changed after PR promotion was abandoned`,
      };
    }
    // ADR 0289 決定3: ローカル着地の hold は断念と同じ形で読む —— 門が閉じていれば待ち(記録は刻まない)、hold した内容のままなら
    // 撃たず、変わっていれば通常の経路を進んで local merge question を立て直す。merge を執行した根は候補に入らない
    const held = ctx.answered ? undefined : holdEventInForce(deps.db, task.id);
    if (held) {
      const block = landingBlock(deps.db, task.id);
      if (block) return { kind: "deferred", reason: block.kind, count: block.count };
      if (!changedSince(task, held.payload.head)) return undefined;
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
      // ADR 0241 決定7: push しても積み残しが消えなければ、着地したとは言わない —— quarantine が抱えていなければ失敗 question を1回立てる
      const afterPush = async (landed: LandingVerdict, pushed: string): Promise<LandingVerdict> => {
        const left = await contentLeftBehind(deps.db, workspace, task.id, pushed);
        if (left.length === 0) {
          retireFailures(task.id, ctx);
          return landed;
        }
        if (workspaceNeedsHuman(deps.db, workspace.name)) return quarantined("workspace", workspace.name);
        const [root, branches] = [taskBranch(task.id), left.map(taskBranch).join(", ")];
        if (!ctx.answered) {
          registerPrPromotionQuestion(
            deps.db,
            task,
            `PR promotion left content behind: ${task.title}`,
            `Pushing ${root} for completed task "${task.title}" left content behind: the content of ${branches} ` +
              `has not reached ${root}. Merge it back into ${root}, then retry.`,
            deps.clock.now(),
          );
        }
        return { kind: "failed", reason: "content_left_behind", error: `pushed ${root}, but the content of ${branches} has not reached it` };
      };
      // lineage が読めなかった候補は、根かどうか分からないまま人間に見せる(根ごとの失敗)
      if (lineageError !== undefined) return failed(task, "promotion_failed", lineageError, ctx);
      const outcome = rootPrOutcome(deps.db, task.id);
      const mergedPr = outcome?.state === "MERGED" ? outcome.prNumber : undefined;
      // merge 済みの根は、保護ブランチの写しを読み直してから比べる —— merge の直後の写しは merge された内容をまだ持たない
      if (mergedPr !== undefined) await refreshProtectedBranch(deps.db, workspace, deps.githubAuth);
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
      if (!isRemoteBacked(workspace)) {
        const resolved = readAuthority(task, deps.clock.now());
        if (!("profile" in resolved)) return quarantined("agent", resolved.quarantinedAgent);
        const purpose = held
          ? reaskedLocalMergePurpose(deps.db, workspace, task, held.payload.head)
          : resolved.profile?.merge === "auto_if_ci_green"
            ? `Workspace "${workspace.name}" is purely-local, so CI cannot be observed and ` +
              `auto_if_ci_green cannot auto-merge "${task.title}". Land its task branch on the ` +
              `protected branch now?`
            : `Workspace "${workspace.name}" is purely-local and has no GitHub merge surface ` +
              `for "${task.title}". Land its task branch on the protected branch now?`;
        registerLocalMergeQuestion(deps.db, task, purpose, deps.clock.now());
        retireFailures(task.id, ctx);
        return { kind: "landed", form: "local_merge_question" };
      }
      // ADR 0241: 開いている PR の根は、積み残しがあるときだけ push する —— 無ければ GitHub を呼ばない
      if (task.pr_number !== null && !(await hasContentLeftBehind(deps.db, workspace, task.id, lastPushedHead(deps.db, task.id)))) {
        retireFailures(task.id, ctx);
        return { kind: "up_to_date", prNumber: task.pr_number };
      }
      if (!deps.github) {
        return failed(task, "github_not_configured", "GitHub is not configured for PR promotion", ctx);
      }
      // 追いつきは PR の状態を読んだ後に置く —— 閉じた・merge 済みの PR の根のタスクブランチは動かさない
      const catchUp = () => {
        if (outlivedForkSource) catchUpTaskBranch(deps.db, workspace, task.id);
      };
      // 盤面の push は写しを動かすので、口を通す(ADR 0243)
      const { github } = deps;
      let authority: AuthorityProfile | undefined;
      const push = async (sha: string) => {
        const pushBranch = await github.preparePush({ path: workspace.path, branch: taskBranch(task.id) });
        return actIfGateOpen<null, LandingVerdict>(() => {
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
        const { state, mergedBy } = await deps.github.getPullRequestState({ path: workspace.path, number: task.pr_number });
        // 決着した PR は1回だけ刻み、キューからも外す —— tick が同じ観測を重ねない。盤面の外の決着は観測、落ちた盤面
        // 自身の merge は執行(ADR 0265 決定5)。
        // 印の付いた PR の決着は執行側が書く。印と根の決着は await の後に見る —— 読んでいる間に遅い走査が
        // 根へ刻んだ観測を重ねない(ADR 0236 決定3)
        if (state !== "OPEN" && !isMarked(task.workspace, task.pr_number) && rootPrOutcome(deps.db, task.id) === null) {
          retire(task.id, { kind: prOutcomeKind(state, mergedBy), pr_number: task.pr_number }, deps.clock.now());
        }
        if (state === "MERGED") return await settleMerged(task, workspace, task.pr_number, ctx);
        // ADR 0241 決定3: 盤面の外で閉じられた PR には push しない。人間の close を question で問い返さない
        if (state === "CLOSED") {
          return {
            kind: "failed",
            reason: "pull_request_closed",
            error: `PR #${task.pr_number} was closed outside the board, so ${taskBranch(task.id)} is not pushed to it`,
          };
        }
        catchUp();
        const sha = taskBranchTip(workspace, task.id);
        const refusal = await push(sha);
        if (refusal) return refusal;
        // push の直後に刻む —— 後段が throw しても、GitHub に載った head の猶予の起点は失わない(ADR 0227 決定2)
        recordBoardFact(task.id, { kind: "pr_branch_pushed", pr_number: task.pr_number, sha });
        return await afterPush({ kind: "landed", form: "open_pull_request_updated", prNumber: task.pr_number }, sha);
      }
      // ADR 0241 決定4: 作る前に同じタスクブランチの PR を探す —— 作成の後・記録の前に落ちた盤面が2つ目を作らない
      const found = await deps.github.findPullRequestByHead({ path: workspace.path, branch: taskBranch(task.id) });
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
        const { title } = await contentSourceFor(task, deps.github, () => workspace?.path).expand();
        // PR の作成は push 済みのブランチに `gh pr create` だけを撃つ —— その失敗や所要時間は予告の範囲に入らない
        const refusal = await push(sha);
        if (refusal) return refusal;
        const created = await deps.github.createPullRequest({
          path: workspace.path,
          branch: taskBranch(task.id),
          base: protectedBranch(workspace),
          title,
          body: prBody(task.handoff_doc, task.github_issue_number),
        });
        prNumber = created.number;
      }
      recordPrOpened(
        deps.db,
        task,
        prNumber,
        sha,
        resolveTaskAgent(task, deps.defaultAgentName, deps.auditorName ?? DEFAULT_AUDITOR_NAME, deps.interviewerName ?? DEFAULT_INTERVIEWER_NAME),
        deps.clock.now(),
        authority,
        deps.isProtectedWorkspace?.(workspace.name),
        "worker",
      );
      return await afterPush({ kind: "landed", form: "pull_request_opened", prNumber }, sha);
    } catch (error) {
      // 読めなかった根を workspace の quarantine が抱えていれば、失敗 question を重ねない(ADR 0241 決定6)
      if (resolvedWorkspace !== undefined && workspaceNeedsHuman(deps.db, resolvedWorkspace)) {
        return quarantined("workspace", resolvedWorkspace);
      }
      return failed(task, "promotion_failed", error, ctx);
    }
  };
  /** 収束の1回(ADR 0241 決定1): 根を導き、根ごとに撃つ。根ごとの失敗はその根に閉じ込め、回は残りの根へ進む。
   *  候補の読み取りそのものの失敗はログに出して回を終え、次の突きで走り直す。 */
  const pass = async (answering: ReadonlySet<string>): Promise<RootVerdict[]> => {
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
      try {
        const root = landingRootOf(deps.db, resolve, id);
        const verdict = root && (await landRoot(root, answering));
        if (verdict) verdicts.push({ taskId: id, verdict });
      } catch (error) {
        console.error(`[landing] landing root ${id} failed; the pass goes on with the rest:`, error);
      }
    }
    // retry が答えている根をこの回が候補にしなかったなら、なぜかを verdict にする —— 回答はそれで拒まれる
    for (const questionId of answering) {
      const taskId = getTask(deps.db, questionId)?.question_pending_pr_promotion_task_id;
      if (!taskId || verdicts.some((root) => root.taskId === taskId)) continue;
      verdicts.push({ taskId, verdict: exclusionOf(deps.db, taskId) });
    }
    return verdicts;
  };
  // ADR 0241 決定2: 着地の書き込みの列。プロセス内の状態として持つ(ADR 0236 の印と同じ理由で DB には持たない)。
  // 走っている間の突きは捨てず、まだ始まっていない次の1回に束ねる —— 呼び手は自分の呼び出しより後に始まる回の結果を受け取る
  let tail: Promise<unknown> = Promise.resolve();
  let queued: { answering: Set<string>; run: Promise<RootVerdict[]> } | undefined;
  let stopped = false;
  const landing: Landing = {
    converge(options) {
      if (!queued) {
        if (stopped) return Promise.resolve([]);
        const answering = new Set<string>();
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
      if (options?.answering !== undefined) queued.answering.add(options.answering);
      return queued.run;
    },
    async stop() {
      stopped = true;
      await tail;
    },
    async observePullRequestOutcome(question) {
      const prNumber = question.question_pending_merge_pr;
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      if (prNumber === null || !resolve || !deps.github) return false;
      // ADR 0265 決定4: 読めなければ回答を拒む(「観測しなかった」に倒すと merge 済みの PR への hold が残る)。
      // 決着の書き込みの失敗も呼び手(回答)へ投げる
      let read: PrStateRead;
      try {
        read = await deps.github.getPullRequestState({ path: resolve(question.workspace).path, number: prNumber });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new DomainError(`PR #${prNumber}'s state could not be read (${reason}), so the answer was not accepted`);
      }
      // 印の付いた PR の決着は執行側が書く。印は await の後に見る(ADR 0236 決定3)
      if (read.state === "OPEN" || isMarked(question.workspace, prNumber)) return false;
      settleObserved(question, prNumber, prOutcomeKind(read.state, read.mergedBy), deps.clock.now());
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
          read = await github.getPullRequestState({ path: resolve(task.workspace).path, number: pr_number });
        } catch {
          continue;
        }
        // 印は await の後に見る —— 前に見ると、await の間に執行側が印を取れる。印の付いた PR の決着は
        // 執行側が書く(ADR 0236 決定3)。キューの確認は、quarantine 回答が重なったときの観測同士の競合を防ぐ
        if (read.state === "OPEN" || isMarked(task.workspace, pr_number) || !isQueuedForAutoMerge(deps.db, task_id)) continue;
        retire(task_id, { kind: prOutcomeKind(read.state, read.mergedBy), pr_number }, deps.clock.now());
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
          try {
            const workspace = resolveOrQuarantine(deps.db, resolve, taskWorkspace, now);
            if (!workspace) continue;
            // 状態が読めない(網・認証)回は黙って次の tick へ回す —— 瞬断のたびにログを出さない
            const read = await github
              .getPullRequestState({ path: workspace.path, number: pr_number })
              .catch(() => null);
            // 印は await の後に見る —— merge 回答が merge 中の PR の決着は回答が書く(ADR 0236 決定3)
            if (read && read.state !== "OPEN" && !isMarked(taskWorkspace, pr_number)) {
              settleObserved({ id, workspace: taskWorkspace }, pr_number, prOutcomeKind(read.state, read.mergedBy), now);
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
          release = landing.takeInFlightMark(task.workspace, pr_number);
          if (!release || !isQueuedForAutoMerge(deps.db, task_id)) continue;
          const workspace = resolveOrQuarantine(deps.db, resolve, task.workspace, now);
          if (!workspace) continue;
          // 盤面の名義の行為(merge / merge question)の直前に profile → 門 → 着地の面の順で読み直す(ADR 0217 決定1・
          // ADR 0232)。CI を読む前は profile と門だけを読み、面は PR の状態の後で読む —— 閉じた PR は面に依らず観測になり、
          // CI 赤の PR に立つのは CI 赤の question になる(ADR 0238 決定1)。門に当たった PR はキューに残り、面が変わった
          // PR はキューを外れる。profile が読めなければ agent を quarantine に落とし、キューに残してこの回は飛ばす(ADR 0217 決定3)
          const authorityIfGateOpen = () => {
            const resolved = readAuthority(task, now);
            return "profile" in resolved && !landingBlock(deps.db, task_id) ? resolved : undefined;
          };
          const stop = (askQuestion?: (changed: string) => void) => {
            const resolved = authorityIfGateOpen();
            return !resolved || withdrawIfSurfaceChanged(task, resolved.profile, pr_number, workspace.name, now, askQuestion);
          };
          if (!authorityIfGateOpen()) continue;
          const ref = { path: workspace.path, number: pr_number };
          // 状態は CI と同じ読み取りで、行為の前に読む(ADR 0229 決定2)。閉じた PR は CI の色に依らず観測になる
          const pr = await github.readPullRequest(ref);
          if (pr.state === "MERGED" || pr.state === "CLOSED") {
            retire(task_id, { kind: prOutcomeKind(pr.state, pr.mergedBy), pr_number }, now);
            continue;
          }
          // 状態が読めなければ、面が変わっていてもキューに残す(ADR 0238 決定3)
          if (pr.state === "unreadable") continue;
          observePrHead(deps.db, task_id, pr_number, pr.head, now);
          const { ci, head } = pr;
          const red = ci === "failure" || (ci === "unreported" && unreportedCiGraceElapsed(deps.db, task_id, head, now));
          const hold = (purpose: string) => () =>
            registerMergeQuestion(deps.db, task, pr_number, purpose, "hold", now);
          const askCiRed = red
            ? hold(
                `"${task.title}"'s auto_if_ci_green auto-merge ` +
                  (ci === "failure"
                    ? `found CI red on PR #${pr_number}`
                    : `found no CI check reported on PR #${pr_number} in the ${UNREPORTED_CI_GRACE_TEXT} since ` +
                      `${UNREPORTED_CI_GRACE_ORIGIN_TEXT}, so its CI-green condition cannot be observed`) +
                  ". Merge anyway, or hold?",
              )
            : undefined;
          // 積み残しは門と同じくキューに残す(ADR 0231 決定3)。CI を読んだ head と比べ、手元に無ければ sha で取る
          // (ADR 0242 決定1)。比べられなければ null(積み残し)。fetch を待つので面の読み直しより前に読む
          const left =
            ci === "success"
              ? await contentLeftBehind(deps.db, workspace, task_id, head, { auth: deps.githubAuth }).catch(() => null)
              : [];
          // 盤面の外の push が落とした内容は、キューを外して推奨 hold の question に倒す(ADR 0242 決定4)
          const dropped = left && (await outsidePushDropNotice(deps.db, workspace, task_id, left, { number: pr_number, head }));
          const askDropped = dropped
            ? hold(`"${task.title}"'s auto_if_ci_green auto-merge found that ${dropped}; then merge, or hold?`)
            : undefined;
          // 面が question 側へ変わっていれば、CI 赤 / 猶予を過ぎた未報告なら CI 赤の question、外の push が落とした内容は
          // その question、それ以外は推奨 merge の面変化の question(ADR 0217 決定2・ADR 0227 決定3)。CI が pending でも
          // 同じ tick で外す(ADR 0238 決定2)。ここから行為までに await は無いので、この読みが行為の直前の読みを兼ねる
          await actIfGateOpen(() => stop(askCiRed ?? askDropped) ? true : null, async () => {
            let askHuman: () => void;
            if (askCiRed) {
              askHuman = askCiRed;
            } else if (ci !== "success") {
              return;
            } else if (askDropped) {
              askHuman = askDropped;
            } else {
              if (left === null || left.length > 0) return;
              // merge は CI を読んだ head に固定する(ADR 0231 決定1)
              const failure = await github.mergePullRequest(ref, head).then(
                () => null,
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
              );
              if (failure === null) {
                retire(task_id, { kind: "pr_merged", pr_number }, now);
                return;
              }
              // merge の失敗の後に状態と head を読み直す。読めなければ分類できない失敗(ADR 0229 決定3)
              const after = await github.readPullRequest(ref);
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
              askHuman = hold(
                `"${task.title}"'s auto_if_ci_green auto-merge could not merge PR #${pr_number}: ${failure}. ` +
                  "Merge once it is fixed, or hold?",
              );
              // merge を待つ間に変わりうるので、question の前に読み直す
              if (stop(askHuman)) return;
            }
            // 外すことと問うことを1つにする — 片方だけで無言で消える経路を残さない(ADR 0105 決定3)
            deps.db.transaction(() => {
              clearPendingAutoMerge(deps.db, task_id);
              askHuman();
            })();
          });
        } catch (error) {
          console.error(`[landing] auto-merge of PR #${pr_number} (task ${task_id}) failed; it stays queued:`, error);
        } finally {
          release?.();
        }
      }
    },
    isMarked,
    takeInFlightMark(workspace, prNumber) {
      const key = markKey(workspace, prNumber);
      if (inFlight.has(key)) return null;
      inFlight.add(key);
      return () => inFlight.delete(key);
    },
  };
  return landing;
}
