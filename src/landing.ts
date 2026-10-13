import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { DEFAULT_AUDITOR_NAME } from "./defaults.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, latestEventOfTask, type TaskScopedPayload } from "./events.js";
import { git } from "./git.js";
import type { GitHubClient, PrState } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import { type QuarantineKind, quarantineAgent } from "./quarantine.js";
import { type AuthorityProfile, isUnresolvableAgentError, remoteTrackingRef } from "./registry.js";
import {
  contentSourceFor,
  countUnsettledAttachedChildren,
  getTask,
  isLandingQuestion,
  landingSurface,
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
  taskIdForPr,
} from "./tasks.js";
import { activeTriageSession } from "./triage.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID } from "./worker-id.js";
import {
  boardRefWriter,
  branchMergeEffect,
  buildWorkspaceResolver,
  catchUpTaskBranch,
  fetchCommitIfMissing,
  isRemoteBacked,
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
  | { kind: "excluded"; reason: "pull_request_closed" | "teardown_unfinished" | "not_a_root"; error: string }
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

/** 着地を待つ完了タスクを agent 名の参照で数える(ADR 0217 決定4)—— agent 名の quarantine の解除と
 *  agent 削除の扉。集合の定義は `tasksAwaitingLanding` にある。 */
export function countTasksAwaitingLanding(
  db: Db,
  resolve: WorkspaceResolver | undefined,
  agentName: string,
  defaultAgentName?: string,
): number {
  return tasksAwaitingLanding(db, resolve).filter((task) => (task.assignee ?? defaultAgentName) === agentName).length;
}

/** 同じ集合を、タスクの `workspace` の参照で数える —— workspace の削除の扉(ADR 0226)。 */
export function countTasksAwaitingLandingInWorkspace(
  db: Db,
  resolve: WorkspaceResolver | undefined,
  workspaceName: string,
): number {
  return tasksAwaitingLanding(db, resolve).filter((task) => task.workspace === workspaceName).length;
}

/** 着地を待つ完了タスク(ADR 0217 決定4 / ADR 0226 / ADR 0241 決定6): 収束の導出を1回走らせ、PR をまだ開いていない
 *  未着地の根と、無人 merge キューにいるものを返す。何も書かない。profile を読むのは面を開くとき(PR の作成)と無人
 *  merge の瞬間だけなので(ADR 0217 決定3・4)、この2つに絞る —— 開いている PR への push は profile を読まない。
 *  根は、門・quarantine・開いた失敗 question で止まっているものを含み、断念が効いている根(ADR 0225)は除く。立て直した
 *  昇格の question が開いていれば、その retry が profile を読むので数える。 */
function tasksAwaitingLanding(db: Db, resolve: WorkspaceResolver | undefined): Task[] {
  const roots = deriveLandingRoots(db, resolve)
    .map(({ task }) => task)
    .filter(
      (task) =>
        task.pr_number === null &&
        (!abandonEventInForce(db, task.id) || openPrPromotionQuestionIds(db, task.id).length > 0),
    );
  return [...roots, ...listPendingAutoMerges(db).map(({ task_id }) => getTask(db, task_id)!)];
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
  const targets = (
    db
      .prepare(
        `${subtreeSql("@root", true)}
       SELECT id FROM tasks
        WHERE id IN (SELECT id FROM subtree) AND (id = @root OR (type = 'work' AND status = 'done'))`,
      )
      .all({ root: taskId }) as Array<{ id: string }>
  ).filter(({ id }) => taskBranchExists(workspace, id));
  if (targets.length === 0) return [];
  if (candidate === undefined) throw new Error(`the board has no record of pushing ${taskBranch(taskId)}`);
  if (fetchMissing) await fetchCommitIfMissing(workspace, candidate, fetchMissing.auth);
  return targets
    .filter(({ id }) => branchMergeEffect(workspace, candidate, taskBranch(id)).changesCandidate)
    .map(({ id }) => id);
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
 *  無ければ着地するタスク自身)・直す手段2つ(ADR 0239 帰結)を言う文を返す。最後に push した head とも比べられなければ、
 *  落としたとは読まない(盤面がまだ運ぶ側) */
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
    `content back onto ${taskBranch(taskId)}, or, to discard it, record \`git merge -s ours\` of it in the workspace and push`
  );
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

export type RootVerdict = { taskId: string; verdict: LandingVerdict };

/** 盤面がまだ着地を運ぶ根(CONTEXT.md「着地」)。`outlivedForkSource` は lineage が読んだ事実で、PR を開く前の追いつきに
 *  使う。`lineageError` は lineage が読めなかった候補 —— 根かどうか分からないので、根として人間に失敗を見せる。 */
interface LandingRoot {
  task: Task;
  outlivedForkSource: boolean;
  lineageError?: unknown;
}

/** PR の merge を記録した(盤面が merge した・merge を観測した)SQL 述語。人間の merge 回答と merge question の観測は、
 *  記録を question の側に刻む。 */
function prMergedSql(t: string): string {
  return `(${t}.pr_number IS NOT NULL AND EXISTS (SELECT 1 FROM events m
             WHERE m.kind IN ('pr_merged', 'pr_merge_observed')
               AND json_extract(m.payload, '$.pr_number') = ${t}.pr_number
               AND (m.task_id = ${t}.id OR m.task_id IN (SELECT q.id FROM tasks q
                      WHERE q.question_pending_merge_pr = ${t}.pr_number AND q.workspace IS ${t}.workspace))))`;
}

/** ADR 0241 決定1 / ADR 0240 決定2: 収束の根を記録と内容から導く。読むだけで、書かない(quarantine にも落とさない)。
 *  候補は SQL で先に絞り、lineage は候補にだけ解く —— 1回の git の呼び出しの数を、着地の終わっていない木の大きさに
 *  比例させ、盤面の歴史の長さには比例させない。候補から外すのは、着地が終わった根(`landing_finished` /
 *  `nothing_to_land`)、盤面の外で閉じた PR の根、ローカル着地の question を持つ根、閉じた PR の根と断念した根の
 *  子孫である —— 子孫はその根が運ぶ。PR が開いている根の子孫は候補に残し、lineage に任せる —— 盤面の外の merge を
 *  盤面が観測していない間(`external` のダイヤルは観測しない)、記録の上で「開いている」根の子孫は、merge の後に完了して
 *  自分で根になっている。人間が担当した work は盤面のタスクブランチに内容を持たないので、根にしない(人間の完了は祖先の
 *  着地の契機である)。Interview の子(pin を持つ work)は使い捨てブランチで走り、ブランチを残すだけで着地しない(ADR 0199)。
 *  lineage が祖先のブランチへ帰る done の work は根ではない。workspace を解決できない候補と lineage が
 *  読めない候補は根かどうか分からないので根として返し、撃つ側がその根の失敗として人間に見せる。後始末が未了の木は、
 *  撃つ直前に根ごとに読む(`landRoot`)。 */
function deriveLandingRoots(db: Db, resolve: WorkspaceResolver | undefined): LandingRoot[] {
  const ids = db
    .prepare(
      `WITH RECURSIVE
         carried(id) AS (
           SELECT c.id FROM tasks c JOIN tasks r ON c.parent_id = r.id
            WHERE r.type = 'work' AND r.status = 'done'
              AND (EXISTS (SELECT 1 FROM events x WHERE x.task_id = r.id AND x.kind = 'pr_close_observed')
                   OR EXISTS (SELECT 1 FROM events a WHERE a.task_id = r.id AND a.kind = 'pr_promotion_abandoned'
                                AND NOT EXISTS (SELECT 1 FROM events l WHERE l.task_id = r.id
                                                  AND l.kind IN ('pr_opened', 'pr_branch_pushed') AND l.id > a.id)))
           UNION
           SELECT c.id FROM tasks c JOIN carried p ON c.parent_id = p.id)
       SELECT t.id FROM tasks t
        WHERE t.type = 'work' AND t.status = 'done' AND t.assignee IS NOT '${HUMAN_WORKER_ID}'
          AND t.interview_target_id IS NULL
          AND t.id NOT IN (SELECT id FROM carried)
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id
                            AND e.kind IN ('landing_finished', 'nothing_to_land', 'pr_close_observed'))
          AND NOT EXISTS (SELECT 1 FROM tasks q WHERE q.question_pending_local_merge_task_id = t.id)
        ORDER BY t.rowid`,
    )
    .all() as Array<{ id: string }>;
  const roots: LandingRoot[] = [];
  for (const { id } of ids) {
    const task = getTask(db, id)!;
    let workspace: WorkspaceConfig | undefined;
    try {
      workspace = resolve?.(task.workspace);
    } catch {}
    if (!workspace) {
      roots.push({ task, outlivedForkSource: false });
      continue;
    }
    try {
      const lineage = resolveTaskBranchLineage(db, workspace, task);
      if (!lineage.branch) roots.push({ task, outlivedForkSource: lineage.outlivedForkSource });
    } catch (lineageError) {
      roots.push({ task, outlivedForkSource: false, lineageError });
    }
  }
  return roots;
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
  observePullRequestOutcome(question: Task): Promise<boolean>;
  observeAutoMergeOutcomes(agentName: string): Promise<void>;
  tick(kind: "auto_merge" | "outside_merge", now: Date): Promise<void>;
  /** ADR 0236 決定2・3: 執行する経路が PR に処理中の印を取り、印を放す関数を返す。既に印が付いていれば取らずに
   *  null を返す。`workspace` はタスクの `workspace` 列の値(未解決のまま)。 */
  takeInFlightMark(workspace: string | null, prNumber: number): (() => void) | null;
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
  isProtectedWorkspace?: (name: string) => boolean;
  /** merge 済みの根を比べる前の保護ブランチの fetch(ADR 0241 決定1)が使う盤面の GitHub 身元(ADR 0093)。 */
  githubAuth?: GitHubAuth;
  /** 走っている pickup の poll が終わると解ける。収束の回はこれを待ってから始まる —— 同じ checkout で pickup の
   *  fetch・checkout と着地の push が重ならない(CONTEXT.md「収束」)。Absent → pickup を持たない盤面。 */
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
      pending_pr_promotion_task_id: task.id,
      workspace: task.workspace ?? undefined,
    },
    now,
    BOARD_WORKER_ID,
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

/** 盤面の外で決着した PR の観測の綴り —— merge と閉じたことを、互いにも執行とも区別する(ADR 0079 決定4 / ADR 0229 決定4)。 */
const OBSERVED = { MERGED: "pr_merge_observed", CLOSED: "pr_close_observed" } as const;

/** ADR 0079 決定3/4 / ADR 0229 決定4: retires a merge question whose PR turned out to be
 *  already merged or closed outside the board. Deliberately not `answerQuestion`:
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
  state: keyof typeof OBSERVED,
  now: Date,
): void {
  settleQuestionAsObserved(db, questionId, { kind: OBSERVED[state], pr_number: prNumber }, now);
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
    appendEvent(db, { taskId, workerId: BOARD_WORKER_ID, origin: "board", payload, at: now });
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
    workerId: BOARD_WORKER_ID,
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
    workerId: BOARD_WORKER_ID,
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
  /** ADR 0225 決定1: 刻んだ head から内容が変わったか(ADR 0105 と同じ比較)。読めなければ「変わった」—— 修理を捨てない側。
   *  workspace を解決できない場合も「変わった」と読むのは ADR 0234 決定3 */
  const changedSince = (task: Task, head: string | null): boolean => {
    const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
    if (head === null || !resolve) return true;
    try {
      return branchMergeEffect(resolve(task.workspace), head, taskBranch(task.id)).changesCandidate;
    } catch {
      return true;
    }
  };
  const recordBoardFact = (taskId: string, payload: TaskScopedPayload) =>
    appendEvent(deps.db, { taskId, workerId: BOARD_WORKER_ID, origin: "board", payload, at: deps.clock.now() });
  /** merge 済みの PR の根の着地は終わった —— 事実を1回刻み、以後この根は候補に入らない(ADR 0241 決定1)。 */
  const finishLanding = (task: Task, workspace: WorkspaceConfig, prNumber: number, ctx: RootContext): LandingVerdict => {
    recordBoardFact(task.id, { kind: "landing_finished", pr_number: prNumber });
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
      : finishLanding(task, workspace, prNumber, ctx);
  };
  // ADR 0236: 処理中の印。決着を書く経路はすべてこのプロセスの中にあるので、DB には持たない
  const inFlight = new Set<string>();
  const markKey = (workspace: string | null, prNumber: number) => JSON.stringify([workspace, prNumber]);
  const isMarked = (workspace: string | null, prNumber: number) => inFlight.has(markKey(workspace, prNumber));
  /** 根ごとの手順(ADR 0241 決定1・3、spec #1839 A): 除外 → workspace の解決 → 運ぶ内容 → 門 → workspace の
   *  quarantine → ローカルか remote か → PR の有無と状態 → profile。lineage は導出(`deriveLandingRoots`)が解いた。
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
      // 門が閉じていれば他の理由より先に待つ(CONTEXT.md「収束」)。待った記録は刻まない —— 立て直しは門が開いてから(ADR 0225 決定2)
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
      const merged = deps.db.prepare(`SELECT 1 FROM tasks t WHERE t.id = ? AND ${prMergedSql("t")}`).get(task.id) !== undefined;
      // merge 済みの根は、保護ブランチの写しを読み直してから比べる —— merge の直後の写しは merge された内容をまだ持たない
      if (merged) await refreshProtectedBranch(deps.db, workspace, deps.githubAuth);
      if (!taskHasContentToLand(workspace, task.id)) {
        if (merged) return finishLanding(task, workspace, task.pr_number!, ctx);
        const base = protectedBranchRef(workspace);
        if (task.pr_number === null) recordBoardFact(task.id, { kind: "nothing_to_land", base });
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
      if (merged) return alreadyMerged(task, task.pr_number!, ctx);
      if (!isRemoteBacked(workspace)) {
        const resolved = readAuthority(task, deps.clock.now());
        if (!("profile" in resolved)) return quarantined("agent", resolved.quarantinedAgent);
        const purpose =
          resolved.profile?.merge === "auto_if_ci_green"
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
      const push = async (sha: string) => {
        const pushBranch = await github.preparePush({ path: workspace.path, branch: taskBranch(task.id) });
        boardRefWriter(deps.db, workspace)(remoteTrackingRef(taskBranch(task.id)), sha, pushBranch);
      };
      if (task.pr_number !== null) {
        const state = await deps.github.getPullRequestState({ path: workspace.path, number: task.pr_number });
        // 盤面の外で決着した PR は観測として1回だけ刻み、キューからも外す —— tick が同じ観測を重ねない。
        // 印の付いた PR の決着は執行側が書く。印は await の後に見る(ADR 0236 決定3)
        if (
          state !== "OPEN" &&
          !isMarked(task.workspace, task.pr_number) &&
          latestEventOfTask(deps.db, task.id, OBSERVED[state])?.payload.pr_number !== task.pr_number
        ) {
          retireAutoMerge(deps.db, task.id, { kind: OBSERVED[state], pr_number: task.pr_number }, deps.clock.now());
        }
        if (state === "MERGED") return settleMerged(task, workspace, task.pr_number, ctx);
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
        await push(sha);
        // push の直後に刻む —— 後段が throw しても、GitHub に載った head の猶予の起点は失わない(ADR 0227 決定2)
        recordBoardFact(task.id, { kind: "pr_branch_pushed", pr_number: task.pr_number, sha });
        return await afterPush({ kind: "landed", form: "open_pull_request_updated", prNumber: task.pr_number }, sha);
      }
      // ADR 0241 決定4: 作る前に同じタスクブランチの PR を探す —— 作成の後・記録の前に落ちた盤面が2つ目を作らない
      const found = await deps.github.findPullRequestByHead({ path: workspace.path, branch: taskBranch(task.id) });
      if (found && found.state !== "OPEN") {
        const observed = { kind: OBSERVED[found.state], pr_number: found.number };
        deps.db.transaction(() => {
          recordPrNumber(deps.db, task.id, found.number);
          retireAutoMerge(deps.db, task.id, observed, deps.clock.now());
        })();
        if (found.state === "MERGED") return settleMerged(task, workspace, found.number, ctx);
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
        await push(sha);
        prNumber = found.number;
      } else {
        const { title } = await contentSourceFor(task, deps.github, () => workspace?.path).expand();
        // PR の作成は push 済みのブランチに `gh pr create` だけを撃つ —— その失敗や所要時間は予告の範囲に入らない
        await push(sha);
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
        resolveTaskAgent(task, deps.defaultAgentName, deps.auditorName ?? DEFAULT_AUDITOR_NAME),
        deps.clock.now(),
        resolved.profile,
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
    let roots: LandingRoot[];
    try {
      roots = deriveLandingRoots(deps.db, buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace));
    } catch (error) {
      console.error("[landing] reading the landing roots failed; the next trigger runs the convergence again:", error);
      return [];
    }
    const verdicts: RootVerdict[] = [];
    for (const root of roots) {
      try {
        const verdict = await landRoot(root, answering);
        if (verdict) verdicts.push({ taskId: root.task.id, verdict });
      } catch (error) {
        console.error(`[landing] landing root ${root.task.id} failed; the pass goes on with the rest:`, error);
      }
    }
    // retry が答えている根をこの回が候補にしなかったなら、なぜかを verdict にする —— 回答はそれで拒まれる
    for (const questionId of answering) {
      const taskId = getTask(deps.db, questionId)?.question_pending_pr_promotion_task_id;
      if (!taskId || verdicts.some((root) => root.taskId === taskId)) continue;
      const closed = latestEventOfTask(deps.db, taskId, OBSERVED.CLOSED);
      verdicts.push({
        taskId,
        verdict: closed
          ? {
              kind: "excluded",
              reason: "pull_request_closed",
              error: `PR #${closed.payload.pr_number} was closed outside the board, so ${taskBranch(taskId)} is not pushed to it`,
            }
          : { kind: "excluded", reason: "not_a_root", error: `task ${taskId} is no longer awaiting PR promotion` },
      });
    }
    return verdicts;
  };
  // ADR 0241 決定2: 着地の書き込みの列。プロセス内の状態として持つ(ADR 0236 の印と同じ理由で DB には持たない)。
  // 走っている間の突きは捨てず、まだ始まっていない次の1回に束ねる —— 呼び手は自分の呼び出しより後に始まる回の結果を受け取る
  let tail: Promise<unknown> = Promise.resolve();
  let queued: { answering: Set<string>; run: Promise<RootVerdict[]> } | undefined;
  const landing: Landing = {
    converge(options) {
      if (!queued) {
        const answering = new Set<string>();
        const run = tail.then(async () => {
          await deps.pickupIdle?.();
          queued = undefined;
          return pass(answering);
        });
        queued = { answering, run };
        tail = run;
      }
      if (options?.answering !== undefined) queued.answering.add(options.answering);
      return queued.run;
    },
    async observePullRequestOutcome(question) {
      const prNumber = question.question_pending_merge_pr;
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      if (prNumber === null || !resolve || !deps.github) return false;
      try {
        const workspace = resolve(question.workspace);
        const state = await deps.github.getPullRequestState({ path: workspace.path, number: prNumber });
        // 印の付いた PR の決着は執行側が書く。印は await の後に見る(ADR 0236 決定3)
        if (state === "OPEN" || isMarked(question.workspace, prNumber)) return false;
        settleMergeQuestionAsObserved(deps.db, question.id, prNumber, state, deps.clock.now());
        return true;
      } catch {
        return false;
      }
    },
    // ADR 0217 決定5: agent 名の quarantine に落ちた agent のキューの PR は、tick の観測
    // (ADR 0079 決定3)に届かない。盤面の外で merge された・閉じられたもの(ADR 0229 決定4)は
    // 回答の受理直前にここで観測する。読めない PR は飛ばす —— キューに残り、着地待ちに数えられる。
    async observeAutoMergeOutcomes(agentName) {
      const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
      const github = deps.github;
      if (!resolve || !github) return;
      for (const { task_id, pr_number } of listPendingAutoMerges(deps.db)) {
        const task = getTask(deps.db, task_id);
        if (task?.type !== "work" || (task.assignee ?? deps.defaultAgentName) !== agentName) continue;
        let state: PrState;
        try {
          state = await github.getPullRequestState({ path: resolve(task.workspace).path, number: pr_number });
        } catch {
          continue;
        }
        // 印は await の後に見る —— 前に見ると、await の間に執行側が印を取れる。印の付いた PR の決着は
        // 執行側が書く(ADR 0236 決定3)。キューの確認は、quarantine 回答が重なったときの観測同士の競合を防ぐ
        if (state === "OPEN" || isMarked(task.workspace, pr_number) || !isQueuedForAutoMerge(deps.db, task_id)) continue;
        retireAutoMerge(deps.db, task_id, { kind: OBSERVED[state], pr_number }, deps.clock.now());
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
            const state = await github
              .getPullRequestState({ path: workspace.path, number: pr_number })
              .catch(() => null);
            // 印は await の後に見る —— merge 回答が merge 中の PR の決着は回答が書く(ADR 0236 決定3)
            if (state && state !== "OPEN" && !isMarked(taskWorkspace, pr_number)) {
              settleMergeQuestionAsObserved(deps.db, id, pr_number, state, now);
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
            retireAutoMerge(deps.db, task_id, { kind: OBSERVED[pr.state], pr_number }, now);
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
          if (stop(askCiRed ?? askDropped)) continue;
          let askHuman: () => void;
          if (askCiRed) {
            askHuman = askCiRed;
          } else if (ci !== "success") {
            continue;
          } else if (askDropped) {
            askHuman = askDropped;
          } else {
            if (left === null || left.length > 0) continue;
            // merge は CI を読んだ head に固定する(ADR 0231 決定1)
            const failure = await github.mergePullRequest(ref, head).then(
              () => null,
              (error: unknown) => (error instanceof Error ? error.message : String(error)),
            );
            if (failure === null) {
              retireAutoMerge(deps.db, task_id, { kind: "pr_merged", pr_number }, now);
              continue;
            }
            // merge の失敗の後に状態と head を読み直す。読めなければ分類できない失敗(ADR 0229 決定3)
            const after = await github.readPullRequest(ref);
            if (after.state === "unreadable") {
              throw new Error(`merge failed (${failure}) and PR #${pr_number} could not be re-read`);
            }
            if (after.state !== "OPEN") {
              retireAutoMerge(deps.db, task_id, { kind: OBSERVED[after.state], pr_number }, now);
              continue;
            }
            observePrHead(deps.db, task_id, pr_number, after.head, now);
            // head が動いただけなら、次の tick で新しい head の CI を読む(ADR 0231 決定1)。gh の文面では見分けない
            if (after.head !== head) continue;
            askHuman = hold(
              `"${task.title}"'s auto_if_ci_green auto-merge could not merge PR #${pr_number}: ${failure}. ` +
                "Merge once it is fixed, or hold?",
            );
            // merge を待つ間に変わりうるので、question の前に読み直す
            if (stop(askHuman)) continue;
          }
          // 外すことと問うことを1つにする — 片方だけで無言で消える経路を残さない(ADR 0105 決定3)
          deps.db.transaction(() => {
            clearPendingAutoMerge(deps.db, task_id);
            askHuman();
          })();
        } catch (error) {
          console.error(`[landing] auto-merge of PR #${pr_number} (task ${task_id}) failed; it stays queued:`, error);
        } finally {
          release?.();
        }
      }
    },
    takeInFlightMark(workspace, prNumber) {
      const key = markKey(workspace, prNumber);
      if (inFlight.has(key)) return null;
      inFlight.add(key);
      return () => inFlight.delete(key);
    },
  };
  return landing;
}
