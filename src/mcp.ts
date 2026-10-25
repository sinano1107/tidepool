import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import type { AgentAdmin } from "./agent-create.js";
import { assertAssigneeCanTake } from "./assignee.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { DEFAULT_AUDITOR_NAME, DEFAULT_INTERVIEWER_NAME } from "./defaults.js";
import { DomainError } from "./domain-error.js";
import { EFFORT_LEVELS } from "./effort.js";
import { INTERVIEW_OUTCOMES } from "./events.js";
import { PRIORITY_FIELD_DESCRIPTION, rowKeySchema, tierFieldDescriptions } from "./execution-setting.js";
import type { GitHubClient } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import { assertMemoryReferencesKnown, assertReviewersKnown, assertWorkspaceKnown } from "./human-verbs.js";
import {
  browseMemory,
  completeMemoryReview,
  defineMemoryBranch,
  defineMemoryByMetaReview,
  foldMemory,
  invalidateMemoryByMetaReview,
  invalidationSchema,
  listPrecedents,
  memoryListFilterSchema,
  memoryRepairKinds,
  memoryScope,
  metaReviewAnnotationSchema,
  metaReviewInvalidationSchema,
  moveMemoryBranchByMetaReview,
  moveMemoryByMetaReview,
  proposeMemoryChange,
  pullMemoryBranches,
  pullMemoryList,
  pullMemoryProposals,
  readMemory,
  readMemoryEntries,
  recordKnowledge,
  repairMoveBranchBack,
  repairReplace,
  repairRestore,
  routingPrecedents,
  searchMemory,
  searchMemoryEntries,
} from "./memory.js";
import { type MetaReviewSubject, PROMOTION_RULE, TIER_DEFINITION_RULE } from "./meta-review.js";
import type { ProcessContainers } from "./process-container.js";
import { quarantineAgent } from "./quarantine.js";
import {
  type AuthorityProfile,
  isUnresolvableAgentError,
  REVIEWER_AUTHORITY_PROFILE,
  type RosterAgent,
} from "./registry.js";
import { requiredTextSchema } from "./required-text-schema.js";
import { nextDescription, packItems, readPosition } from "./response-budget.js";
import { completeRca, materialStop, proposeFromObjection, stopMaterialActions } from "./retrospective.js";
import { completeRoutingReview, listAllocations, listRoutingCells, listRoutingShadow, proposeRoutingChange, readRoutingSettings, routingRepairVerbs } from "./routing-review.js";
import type { TaskExecutionCandidates } from "./scheduler.js";
import type { Slot } from "./slot.js";
import { createStatelessMcpRouter, floorEveryResponse, rejectUnknownArguments } from "./stateless-mcp.js";
import {
  assertPosable,
  assertTargetsRunnable,
  assigneeNeedsApproval,
  auditedPosedEventId,
  completeAudit,
  completeIntegrationReview,
  completeInterview,
  completeTask,
  contentSourceFor,
  continueDecomposition,
  declarePremiseBreach,
  decomposeTask,
  describeHandoffFields,
  escalateTask,
  evidenceHistoryRows,
  getTask,
  HANDOFF_FIELDS,
  type HistoryRow,
  HUMAN_ROSTER_AGENT,
  interviewFields,
  interviewRoomPath,
  interviewTargets,
  isRepairType,
  isSubjectReaderRca,
  joinHistory,
  listExaminees,
  logDecision,
  metaReviewSubjectOf,
  posedProbe,
  poseProbe,
  REPAIR_NOTICES,
  redecompose,
  reportBrokenProbe,
  resolveTaskAgent,
  type Task,
  type TaskType,
  taskHistoryRows,
  taskVerbSwap,
  type Unstored,
} from "./tasks.js";
import { markTeardown, runTeardown, type TeardownDeps, teardownStep } from "./teardown.js";
import { readTiers } from "./tier.js";
import {
  buildWorkspaceResolver,
  commitRoomCopy,
  completionTreeGateApplies,
  resolveOrQuarantine,
  safeRealpath,
  taskRunPlace,
  treeIsDirty,
  UnknownWorkspaceError,
  type WorkspaceConfig,
} from "./workspace.js";

/** ADR 0015 (2026-08-21 addendum) / issue #415: the board-language rule lives
 *  on each board-write verb's own description, not in the worker's system
 *  prompt — a front-loaded instruction was losing to a task's own non-English
 *  payload by the time the worker reached these verbs. */
export const BOARD_WRITE_LANGUAGE_RULE =
  "Write in English even when the task's payload is in another language; " +
  "human-authored text you quote stays in its original language.";

/** 枝の一覧(ADR 0122 追記 #1209): meta-review と管理MCP が同じ説明を載せる。 */
export const MEMORY_BRANCHES_DESCRIPTION =
  "List every branch of the board's memory in tree order: its path, the Definitions at that path (id, scope, text), and the scopes " +
  "that hold approved entries at or under it (null = the whole board). A whole-board Definition defines the branch for every scope; " +
  "a branch is undefined for a scope that holds entries under it and has neither its own Definition there nor a whole-board one. " +
  "Candidates and invalidated entries make no branch.";

/** ADR 0109 決定6: 最終 verb の返り値に置く終了の指示。**送達であって保証ではない**
 *  —— 不変条件は attribution の門・完了経路の検査・強制回収が持ち、この一文が守るのは
 *  トークンだけである(締めのターンだけは機械で殺せないことが実測で確定している)。
 *  3経路で1つの定数を共有する。 */
const SESSION_OVER_NOTICE =
  "Session over. End your turn now: no further tool calls, no file edits, no closing " +
  "summary. Nothing reads anything you produce after this point, and the board is " +
  "waiting for this session's processes to exit before it releases the workspace.";

/** 後始末に入った session からの以降の呼び出しに返すもの(ADR 0109 決定6)。失敗として
 *  読ませると別の手を試されるので、上の一文と同じことを言わせる。 */
const SESSION_OVER_TOOL_ERROR =
  "this session is over; stop and end your turn — no further tool calls, no file edits, " +
  "no closing summary. Nothing reads anything you produce after this point.";

export interface McpDeps {
  db: Db;
  slot: Slot;
  clock: Clock;
  /** 盤面側 supervisor(ADR 0099 決定2)。最終 verb の着地後、後始末はこの
   *  **回収済み観測**の後ろでしか走らない(ADR 0109 決定1)。Absent → 容器を
   *  持たない盤面なので、観測は即座に解決したものとして扱う。 */
  containers?: ProcessContainers;
  pollNow: () => void;
  workspace?: WorkspaceConfig;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009), read fresh every call. Absent → every task releases against
   *  the board's single fixed `workspace` (pre-#26 behavior). */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** The GitHub-facing seam (issue #19): a work task's completion is promoted
   *  to a PR through here. Absent → no PR is ever opened (e.g. a workspaceless
   *  board). */
  github?: GitHubClient;
  /** The board's GitHub identity (ADR 0093) for completion-time workspace refresh. */
  githubAuth?: GitHubAuth;
  /** watchdog の `heldForContainment`(ADR 0099 決定3)。梯子の底で保留されている
   *  session の後始末は、遅れて届いた回収済み観測ではなく確認回答だけが進める。
   *  Absent → watchdog を持たない盤面(梯子そのものが無い)。 */
  heldForContainment?: (taskId: string) => boolean;
  /** This board's one configured worker's authority profile (issue #11).
   *  Absent → assignable_to and allowed_workspaces are both unrestricted.
   *  Superseded by `resolveAuthority` below when both are given. */
  authority?: AuthorityProfile;
  /** Resolves the executing task's own agent's authority profile (ADR 0012 /
   *  issue #36), read fresh every call from the task's own `assignee` (null →
   *  the board's default agent) — the delegation-aware successor to the
   *  single fixed `authority` above, which every task shared regardless of
   *  who it was actually assigned to. Absent → falls back to `authority`. */
  resolveAuthority?: (assignee: string | null, taskType: TaskType) => AuthorityProfile | undefined;
  /** The board's default agent name (ADR 0012 / issue #36): every MCP call is
   *  attributed to a real agent session (never human — that's the separate
   *  /answer route), so a task's unspecified (null) `assignee` resolves here,
   *  not to `HUMAN_WORKER_ID`. Required: no default actor (ADR 0194). */
  defaultAgentName: string;
  /** The board's Auditor pointer (CONTEXT.md / issue #15 layer 2), same shape
   *  as `defaultAgentName` above — the fallback a `review` task's unset
   *  `assignee` attributes to instead (issue #42), never `defaultAgentName`.
   *  Absent → `DEFAULT_AUDITOR_NAME` (the pointer always resolves —
   *  CONTEXT.md's Auditor). */
  auditorName?: string;
  /** Interview の root の空の assignee が解決する先(ADR 0269 決定2)。Absent → `DEFAULT_INTERVIEWER_NAME`。 */
  interviewerName?: string;
  /** Whether an agent name is currently registered (ADR 0012 / issue #36),
   *  read fresh against the registry — used to reject a decompose child's
   *  unknown assignee outright (the registering agent's own mistake, same
   *  treatment as an unknown child workspace). Absent → no registry
   *  configured, so any assignee name is accepted, same as the workspace
   *  check's fallback. */
  agentRegistered?: (name: string) => boolean;
  /** Whether a name resolves to the built-in agent right now (ADR 0228): a
   *  decompose child assigned to it is rejected outright like an unknown name.
   *  Absent → no registry configured. */
  resolvesToBuiltIn?: (name: string) => boolean;
  /** Whether an explicitly named workspace is protected (CONTEXT.md's
   *  protected workspace / ADR 0013), read fresh against the registry — a
   *  decompose child naming a protected workspace converts to an approval
   *  question unconditionally, regardless of the registering worker's
   *  authority profile (v1's only protected workspace is the registry
   *  itself). Absent → no workspace is protected. */
  isProtectedWorkspace?: (name: string) => boolean;
  /** The pull half of the roster (issue #43 / ADR 0014): every registry
   *  agent's name + description, read fresh against the registry every call
   *  (same pattern as `agentRegistered`) — `list_agents` marks each one
   *  direct/needs-approval against the caller's own `assignable_to` via the
   *  same `assigneeNeedsApproval` decompose enforces, plus a fixed `human`
   *  line (CONTEXT.md's Roster: human is delegable but carries no registry
   *  definition). Absent → no registry configured, so `list_agents` reports
   *  only the fixed `human` line. */
  listAgents?: () => RosterAgent[];
  /** registry の agent 一覧(issue #920): routing meta-review の tier の提案が agent の定義を読む。Absent → registry の無い盤面。 */
  agentAdmin?: Partial<Pick<AgentAdmin, "list">>;
  /** pickup と同じ候補の口(ADR 0110 決定3): 出題と Interview の登録が対象の走れる候補を確かめる(ADR 0253 決定3)。Absent → 確かめない。 */
  taskExecutionCandidates?: TaskExecutionCandidates;
}

/** Every MCP call is attributed to a real agent session (never human — that's
 *  the separate /answer route), so an unspecified (null) assignee resolves to
 *  the board's default agent, not `HUMAN_WORKER_ID` (ADR 0012 / issue #36) —
 *  made type-aware for `review` tasks (issue #42 / CONTEXT.md's Auditor): a
 *  review task's unset assignee attributes to the Auditor pointer instead —
 *  or, for an Interview root, to the Interviewer pointer (ADR 0269 決定2) —
 *  neither of which is ever unset (each falls back to its `DEFAULT_*`). */
function attributedWorkerId(deps: McpDeps, task: Task): string {
  return resolveTaskAgent(
    task,
    deps.defaultAgentName,
    deps.auditorName ?? DEFAULT_AUDITOR_NAME,
    deps.interviewerName ?? DEFAULT_INTERVIEWER_NAME,
  );
}

/** The authority governing this task: a `review` task always runs under the
 *  fixed reviewer profile (registry.ts, ADR 0013), regardless of who it's assigned
 *  to. Otherwise `resolveAuthority` read fresh against the task's own
 *  `assignee` when configured (ADR 0012 / issue #36), else the board's single
 *  fixed `authority` (pre-#36 shape, and still today's shape for a board with
 *  no registry-backed resolver at all). An assignee the registry no longer
 *  resolves quarantines the agent name and refuses the verb with a domain
 *  error — neither unrestricted nor narrowest is guessed, and the slot stays
 *  (ADR 0224). */
function attributedAuthorityOrQuarantine(deps: McpDeps, task: Task): AuthorityProfile | undefined {
  if (task.type === "review" || task.type === "interview") return REVIEWER_AUTHORITY_PROFILE;
  try {
    return deps.resolveAuthority?.(task.assignee, task.type) ?? deps.authority;
  } catch (err) {
    if (!isUnresolvableAgentError(err)) throw err;
    quarantineAgent(deps.db, err.agentName, err, deps.clock.now());
    throw new DomainError(
      `the registry cannot resolve agent ${err.agentName}'s definition; ` +
        "the board has asked a human to repair the registry, and this call was not applied. " +
        "You do not need to escalate about this.",
    );
  }
}

/** 読み手へ出す口(ADR 0220): 解決を通っていない行は型で拒む。 */
export function toolResult<T>(payload: Unstored<T>) {
  // biome-ignore lint/plugin: the typed exit itself (ADR 0220)
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function toolError(message: string) {
  // biome-ignore lint/plugin: the error exit, which carries only a string (ADR 0220)
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** Resolve the caller's ?task= attribution against the slot; every agent-facing
 *  verb goes through this (also rejects stray calls from stale killed processes). */
function resolveAttributedTask(
  deps: McpDeps,
  attributedTaskId: string | null,
): { task: Task } | { error: string } {
  if (attributedTaskId === null || attributedTaskId !== deps.slot.currentTaskId) {
    return { error: "call is not attributed to the current slot task" };
  }
  // ADR 0109 決定2/6: 最終 verb が着地した session は、枠こそ握っているが盤面には
  // もう触れない —— 読取(`get_current_task`)も含めて全部ここで拒む。門が閉じるのは
  // verb の**着地の後**なので、最初の解放系 verb 自身はここに掛からない。
  if (deps.slot.inTeardown) return { error: SESSION_OVER_TOOL_ERROR };
  const task = getTask(deps.db, attributedTaskId);
  if (!task) return { error: "current task not found" };
  return { task };
}

/** The shape every agent verb shares: resolve attribution, run the domain
 *  verb, hand DomainError back as a tool error rather than a protocol one. */
export async function runVerb<R>(
  deps: McpDeps,
  attributedTaskId: string | null,
  verb: (task: Task) => Unstored<R> | Promise<Unstored<R>>,
) {
  const resolved = resolveAttributedTask(deps, attributedTaskId);
  if ("error" in resolved) return toolError(resolved.error);
  try {
    return toolResult<unknown>(await verb(resolved.task));
  } catch (err) {
    if (err instanceof DomainError) return toolError(err.message);
    throw err;
  }
}

/** タスク自身の実行 workspace(issue #26 / ADR 0009 —— 盤面の既定ではない)。解決できない
 *  名前は `resolveOrQuarantine` が quarantine する**副作用を持つ**ので、1つの verb 呼び出しで
 *  2度撃たない(2度目は同じ観測を cause として重ねて記録するだけである)。 */
function resolveTaskWorkspace(deps: McpDeps, task: Task): WorkspaceConfig | undefined {
  const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
  if (!resolve) return undefined;
  const workspace = resolveOrQuarantine(deps.db, resolve, task.workspace, deps.clock.now());
  // 門と後始末は走る場所に効く —— interview の root は面接室、受験者は自分の checkout(ADR 0273 決定1・8 / ADR 0276 決定1)
  return workspace && taskRunPlace(deps.db, task, workspace);
}

/** 完了の門(ADR 0084 決定1・2 / issue #240)。ここに立つのは `completeTask` を人間経路
 *  (/api・管理MCP)と共有しているからで、拒否は handoff invariant と同じ domain error
 *  —— セッション・slot・ツリーのどれも動かず、worker はコミットして呼び直せる。 */
function assertWorkTreeCommitted(deps: McpDeps, task: Task, workspace: WorkspaceConfig): void {
  if (!completionTreeGateApplies(deps.db, task, workspace)) return;
  if (!treeIsDirty(workspace)) return;
  throw new DomainError(
    "the task workspace has uncommitted changes — commit them on the task branch first, " +
      "with a message whose body says what changed and why in a few lines, readable from " +
      "the git history alone, then call complete_task again",
  );
}

/** 検査を持たない門: workspace を前倒しで解決するだけ(監査・Interview の完了には ADR 0084 の完了の門が無い)(`done` へ決着させる verb は門を持つ —— ADR 0274 決定3)。 */
const resolveOnly = (): void => {};

/** Verbs that end the slot session (complete, decompose, escalate, and the other
 *  releasing verbs registered below): run the
 *  domain verb attributed to the slot worker, then hand the release to the
 *  session's 後始末. Work completion opts into lineage merge-back; every other
 *  release only stashes WIP. A domain error keeps the slot — the session
 *  continues.
 *
 *  ADR 0109 決定1: verb は final MCP call の中で同期に着地し、response はすぐ返る ——
 *  workspace の解放と slot の解放**だけ**が回収済み観測の後ろへ移る。worker exit と
 *  回収済み観測を待つ循環待ちは作らない(待つのは `void` の先である)。
 *
 *  `gate` は verb の**前**に走る(ADR 0084 の完了の門、出題の面接室の写し —— ADR 0273 決定3)。workspace が解決できなければ
 *  門は飛ばす —— 出題の verb だけは head を記録できないので verb の側で拒む(追記5)。門を持つ verb だけが workspace を
 *  前倒しで解決するのは、解決自体が quarantine の副作用を持つため —— 前へ出すと、domain
 *  error で終わった escalate / decompose にまでその副作用が及ぶ。`done` へ決着させる verb は
 *  どれも門を持ち、持たずに `done` へ決着させれば記録ごと拒む(ADR 0274 決定3 —— 後始末は
 *  `done` から「門が既に観測した」と導く)。門が解決した走る場所は**解決できなかったとき
 *  (`null`)も含めて**そのまま後始末へ渡し、後始末は門が検査した場所を解放する(`null` なら
 *  完了の後始末は解決し直さないので撃ち直さない)。 */
function runReleasingVerb(
  deps: McpDeps,
  attributedTaskId: string | null,
  verb: (task: Task) => (workerId: string, now: Date) => object,
  gate?: (task: Task, workspace: WorkspaceConfig) => void,
) {
  return runVerb(deps, attributedTaskId, (task) => {
    const workspace = gate ? (resolveTaskWorkspace(deps, task) ?? null) : undefined;
    if (gate && workspace) gate(task, workspace);
    // `verb(task)` は transaction の外: 拒否でも残す副作用(authority の quarantine)はここに置き、返す記録だけが中で走る
    const record = verb(task);
    // 後始末に入った(CONTEXT.md「後始末」)。枠を握っているのは task ではなく
    // session であり、この事実は再起動をまたぐので行にも持つ(ADR 0109 決定5)。
    // 記録と印は同じ transaction(issue #2025)—— 間で落ちると印の無い決着済み session が残る。
    const result = deps.db.transaction(() => {
      const now = deps.clock.now();
      const recorded = record(attributedWorkerId(deps, task), now);
      // ADR 0274 決定3: 後始末は `done` から「門が workspace を既に観測した」と導く —— 門を渡さずに `done` へ決着させた verb は
      // その導出を偽にするので、記録ごと巻き戻す(門の callback が飛ばされたかではなく、解決が前倒しで走ったかを問う)
      if (!gate && getTask(deps.db, task.id)?.status === "done") {
        throw new Error(`task ${task.id}: a verb settled it done without the completion gate`);
      }
      markTeardown(deps.db, task.id, now);
      return recorded;
    })();
    deps.slot.enterTeardown();
    const teardown: TeardownDeps = {
      db: deps.db,
      clock: deps.clock,
      slot: deps.slot,
      resolve: buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace),
      githubAuth: deps.githubAuth,
      heldForContainment: deps.heldForContainment,
      pollNow: deps.pollNow,
    };
    const reclaimed = deps.containers?.reclaimed(task.id) ?? Promise.resolve();
    void reclaimed.then(() => runTeardown(teardown, task.id, { ...teardownStep(deps.db, task.id), workspace }));
    return { ...result, session_over: SESSION_OVER_NOTICE };
  });
}

/** A task's own briefing (issue #49, ADR 0016): the "spawn" moment content is
 *  live-resolved for — an issue-backed task's stored title/purpose/
 *  completion_criteria are only the "#N" placeholder (rowToTask), so
 *  contentSourceFor resolves the real thing here. The workspace thunk stays
 *  lazy: an ordinary task's briefing must not trigger workspace resolution
 *  (resolveOrQuarantine can quarantine a name as a side effect). An issue
 *  that dies *after* the scheduler's pickup gate passed (closed/deleted
 *  mid-slot) makes expand() reject and surfaces as a plain tool error — the
 *  worker can escalate itself, and the watchdog is the backstop; the
 *  retry/abandon failure question belongs to the pickup gate alone. */
async function taskContext(deps: McpDeps, task: Task) {
  const content = await contentSourceFor(task, deps.github, () => {
    const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
    const workspace =
      resolve && resolveOrQuarantine(deps.db, resolve, task.workspace, deps.clock.now());
    return workspace ? workspace.path : undefined;
  }).expand();
  return { id: task.id, ...content };
}

/** interview の root の envelope の構造欄(ADR 0273 決定2・9): 登録の欄、測る段の名前と説明、実環境の在り処(cwd の面接室の外で
 *  読みに開いている)と、その宣言のうち受験者に効く部分。 */
function interviewEnvelope(deps: McpDeps, task: Task) {
  const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
  const workspace = resolve && resolveOrQuarantine(deps.db, resolve, task.workspace, deps.clock.now());
  return {
    ...interviewFields(deps.db, task.id),
    measured_tier: readTiers(deps.db).find((tier) => tier.name === task.tier),
    ...(workspace && { real_environment: safeRealpath(workspace.path) }),
    allowed_domains: workspace?.allowed_domains ?? [],
  };
}

/** 監査 review の envelope(ADR 0273 決定3・4): 監査する出題の head と面接室の在り処、root の envelope の構造欄。 */
function auditedProbeEnvelope(deps: McpDeps, task: Task) {
  const posedId = auditedPosedEventId(deps.db, task.id);
  if (posedId === undefined) return undefined;
  const { head, root_id } = posedProbe(deps.db, posedId);
  return { interview_audit: { head, interview_room: interviewRoomPath(deps.db, root_id), ...interviewEnvelope(deps, getTask(deps.db, root_id)!) } };
}

/** 出題の root が自分では直せない拒否の結び —— 人間に渡す出口を指す。 */
const ESCALATE_UNFIXABLE = " — this task cannot fix that: escalate so a human decides";

/** 応答予算で読む読み口の続き(ADR 0195)。 */
const next = z.string().optional().describe("The next string from a previous response of this verb; pass it alone.");

/** decompose と redecompose が共有する。 */
function assertChildrenKnown(deps: McpDeps, children: z.infer<ReturnType<typeof decomposeChildrenSchema>>): void {
  // an explicitly named child workspace must exist in the registry
  // (issue #26) — this is the registering agent's own mistake, not an
  // authority question, so it's rejected outright before anything
  // registers rather than converted into an approval question (ADR
  // 0009). Absent a real registry, every name is accepted, same as
  // execution-time resolution's fallback.
  const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
  if (resolve) {
    for (const child of children) {
      if (child.workspace === undefined) continue;
      try {
        resolve(child.workspace);
      } catch (err) {
        if (!(err instanceof UnknownWorkspaceError)) throw err;
        throw new DomainError(`unknown workspace: ${child.workspace}`);
      }
    }
  }
  // the agent-name generalization of the check above (ADR 0012 / issue
  // #36): an explicitly named child assignee must exist in the
  // registry, and a child is work so it never falls to the built-in
  // (ADR 0228) — the registering agent's own mistake, not an authority
  // question, so it's rejected outright before the assignable_to check
  // even runs: approving it would leave nothing to run it. `human` is
  // valid only as a work assignee, never a reviewer.
  for (const child of children) {
    assertAssigneeCanTake(deps, child.assignee, "work");
    assertReviewersKnown(deps.agentRegistered, child.review_by);
  }
}

/** review の欄は、完了時レビューが立つ子にしか受け付けない(ADR 0111 追記8)。 */
export const ONLY_WHERE_REVIEW_FIRES =
  "Accepted only on a child whose completion raises a review: not assigned to human, and carrying review_flag or risk_flag.";

/** 名前ごとに完了時レビューを1本立てる、という review_by の意味。decompose と管理MCP の入口が共有する。 */
export const REVIEWER_NAMES = "Reviewer agent names; one completion review per name.";
/** 同じ規則を、root も review type も登録する入口(管理MCP の register_task / edit_task)向けに言い直したもの。
 *  子が前提の ONLY_WHERE_REVIEW_FIRES はそのまま使えない。条件は webui-rules の whyNoCompletionReview /
 *  whyReviewFlagIsInert と同じ。 */
export const ONLY_WHERE_COMPLETION_REVIEW_FIRES =
  "Accepted only on a work task whose completion raises a review: not assigned to human, and either a root " +
  "(every root is reviewed on completion) or a child carrying review_flag or risk_flag.";
export const REVIEW_FLAG_ONLY_ON_WORK_CHILDREN =
  "Opt a child work task into an independent review of its deliverable on completion. " +
  "Accepted only on a child work task not assigned to human; refused on a root, which is already reviewed on " +
  "completion, and on a review task.";
/** review_tier の書き出し。段の一覧(tierFieldDescriptions の review_tier_choices)はこの後に続ける。 */
export const REVIEW_TIER_BY_TYPE =
  "Quality tier whose meaning depends on the task type. " +
  "On a review task, it is the tier that review itself runs at, and no completion-review condition applies. " +
  "On an Interview, it raises the tier its root runs at: at or above the measured tier, and the root runs at the highest of it, the measured tier and the board's judgement tier. " +
  `On a work task, it is the tier of its completion reviews: ${ONLY_WHERE_COMPLETION_REVIEW_FIRES}`;
/** edit_task は変更後の状態で判定する(保存済みの値と同じ呼び出しの値を合わせた状態)。 */
export const JUDGED_AFTER_THE_EDIT =
  "Judged on the task as it stands after this edit — assignee, review_flag and risk_flag from this same call " +
  "applied, stored values otherwise — so an edit that would leave a stored review_flag or review_by with no " +
  "effect (dropping a child's flags, or assigning human) is refused.";

/** decompose と redecompose が共有する子の入力。段の説明は盤面の一覧から組む(ADR 0200 決定3)。 */
function decomposeChildrenSchema(db: Db) {
  const tierDescriptions = tierFieldDescriptions(db);
  return z.array(
    z.object({
      title: requiredTextSchema,
      purpose: requiredTextSchema,
      completion_criteria: requiredTextSchema,
      risk_flag: z.boolean().optional(),
      assignee: z
        .string()
        .optional()
        .describe(
          "Who to delegate to. Your own system prompt's Roster section lists who " +
            "you can assign directly; call list_agents for the full board.",
        ),
      workspace: z.string().optional(),
      review_flag: z
        .boolean()
        .optional()
        .describe(
          "Opt this child into an independent review of its deliverable on completion. " +
            "No authority check applies — declaring it is never out of scope. " +
            "Refused on a child assigned to human, whose completion raises no review.",
        ),
      tier: z.string().optional().describe(tierDescriptions.tier),
      review_by: z.array(requiredTextSchema).optional()
        .describe(`${REVIEWER_NAMES} Omit to use the board Auditor. ${ONLY_WHERE_REVIEW_FIRES}`),
      review_tier: z.string().optional().describe(`${tierDescriptions.review_tier}\n${ONLY_WHERE_REVIEW_FIRES}`),
      priority: z.string().optional().describe(PRIORITY_FIELD_DESCRIPTION),
    }),
  );
}

/** Domain verbs only, no generic CRUD (ADR 0002). Attribution comes from the
 *  spawn-time ?task= URL param and must match the current slot task. */
function buildMcpServer(deps: McpDeps, attributedTaskId: string | null): McpServer {
  const server = floorEveryResponse(rejectUnknownArguments(new McpServer({ name: "tidepool", version: "0.0.0" })), {
    db: deps.db,
    clock: deps.clock,
    surface: "worker",
    taskId: attributedTaskId,
  });
  // ADR 0122 決定2: meta-review には worker の memory verb を登録せず、主題の専用 verb で置き換える
  const subject = attributedTaskId === null ? null : metaReviewSubjectOf(deps.db, attributedTaskId); // 自身の列: 問いは「この task は meta-review か」で、行の主題ではない(ADR 0283 決定1)
  // ADR 0245 決定1・3 / ADR 0253 決定4・5 / ADR 0268 決定2: Interview の木では分解の verb を登録せず、受験者には記憶を書く verb も
  // 登録せず、root には complete_task の代わりに出題前は出題の、出題済みは採点完了の verb を登録する(同じ task ごとの差し替え)。
  // 成果が捨てられた task にも分解の verb を登録しない(ADR 0271 決定2)。memory_repair は分解の verb と新規の記憶の書き込みの verb を
  // 登録せず(ADR 0272 決定3)、routing_repair は基本の面(get_current_task / log_decision / escalate / complete_task)の外の worker の
  // verb を登録しない(ADR 0279 決定4 —— routing の判断の行を運べば routing の読み口と提案 verb は下で足す)。統合レビューは
  // complete_task の代わりに complete_integration_review を、memory meta-review は
  // complete_memory_review を、routing meta-review は complete_routing_review を、RCA は complete_rca を登録する(ADR 0278 決定1)
  const { withheld, added } = attributedTaskId === null ? { withheld: [], added: [] } : taskVerbSwap(deps.db, attributedTaskId);
  // ADR 0310 決定4: 材料が停止の RCA の verb の文は材料の停止を指す
  const stopRca = attributedTaskId !== null && materialStop(deps.db, attributedTaskId) !== undefined;
  /** `done` へ決着させる種別ごとの完了の verb の handler(門は resolveOnly): 完了した task の id と status を返す。 */
  const completing =
    <I>(complete: (db: Db, task: Task, input: I, workerId: string, now: Date, origin: "worker") => Task) =>
    async (input: I) =>
      runReleasingVerb(deps, attributedTaskId, (task) => (workerId, now) => {
        const done = complete(deps.db, task, input, workerId, now, "worker");
        return { id: done.id, status: done.status };
      }, resolveOnly);

  server.registerTool(
    "get_current_task",
    {
      description:
        "Fetch the context of the task occupying the slot, reading history from top to bottom " +
        "in chronological order. A decision's children are the tasks registered based on that " +
        "decision. A child_outside_the_decomposition is based on no decomposition decision, " +
        "such as a repair task from a human objection, this task's own escalation, or a " +
        "watchdog failure question. " +
        "A history is read in rows: each child of a decision is one row (a decision without children is one row), and every other entry is " +
        "one row; the parent's rows come first, then this task's. A decision whose children continue into the next response repeats its " +
        "line there, and once the parent's rows are all read a response carries no parent. " +
        nextDescription("get_current_task", "history rows", "The task and the parent's other fields come"),
      inputSchema: { next },
    },
    async (input) =>
      runVerb(deps, attributedTaskId, async (task) => {
        const read = readPosition("get_current_task", input);
        const parent = task.parent_id ? (getTask(deps.db, task.parent_id) ?? null) : null;
        // 親の history の後に task の history を、decision の子ごとの行で1列に詰める(ADR 0195)。境目の鍵は行の event id
        const rows = [
          ...(parent ? taskHistoryRows(deps.db, parent.id, task.id).map((row) => ({ ...row, list: "parent.history" })) : []),
          ...taskHistoryRows(deps.db, task.id).map((row) => ({ ...row, list: "history" })),
        ];
        const rowOf = new Map(rows.map((row) => [row.entry, row]));
        // 対象の一覧は出題の前に読むためのもの。受験者が居れば採点の読み手から伏せる(伏せた handoff、ADR 0199)
        const targets = listExaminees(deps.db, task.id).length === 0 && interviewTargets(deps.db, task.id);
        const envelope =
          read.at === undefined && {
            ...(await taskContext(deps, task)),
            type: task.type,
            ...(targets && { interview_targets: targets }),
            ...(task.type === "interview" && { interview: interviewEnvelope(deps, task) }),
            ...auditedProbeEnvelope(deps, task),
            // ADR 0310 決定4: 材料が停止の RCA には止められた session の行動列(無条件に読むので注入、ADR 0180)
            ...stopMaterialActions(deps.db, task.id),
            // ADR 0272 決定3 / ADR 0279 決定4: 修理子の verb を伏せた理由(spawn の文面と同じ1行)。帰り先の無い task には何も足さない(ADR 0301 決定5)
            ...(isRepairType(task.type) && { [task.type]: REPAIR_NOTICES[task.type] }),
            parent: parent && { ...(await taskContext(deps, parent)), handoff_doc: parent.handoff_doc },
          };
        const packed = packItems(read, parent ? ["parent.history", "history"] : ["history"], rows.map((row) => row.entry), envelope || {}, {
          keyOf: (_, i) => rows[i]!.id,
          listOf: (_, i) => rows[i]!.list,
        }) as { parent?: { history: HistoryRow["entry"][] }; history: HistoryRow["entry"][] };
        // 同じ decision の子の行を1つの decision に戻す —— 応答は縮むだけ。切れた1件(partial)は複製なので戻す相手が無い
        const join = (entries: HistoryRow["entry"][]) => joinHistory(entries.map((entry) => ({ decision: rowOf.get(entry)?.decision, entry })));
        if (packed.parent) packed.parent.history = join(packed.parent.history);
        packed.history = join(packed.history);
        // 続きで親の history を読み終えたら親の欄ごと載せない(続きの最初の item は必ず載るので、空なら読み終えている)
        if (read.at !== undefined && packed.parent?.history.length === 0) delete packed.parent;
        return packed;
      }),
  );

  if (!withheld.includes("list_agents")) server.registerTool(
    "list_agents",
    {
      description:
        "List every agent you could delegate to, plus human — the pull half of the roster. " +
        "Your system prompt's own Roster section already lists who you can delegate to " +
        "directly; call this only to see the full board, with each entry marked " +
        '"direct" or "needs_approval" (converts to a human approval question).',
    },
    async () =>
      runVerb(deps, attributedTaskId, (task) => {
        const authority = attributedAuthorityOrQuarantine(deps, task);
        const entries: RosterAgent[] = [...(deps.listAgents?.() ?? []), HUMAN_ROSTER_AGENT];
        return {
          agents: entries.map((entry) => ({
            ...entry,
            status: assigneeNeedsApproval(deps.db, task, entry.name, authority)
              ? "needs_approval"
              : "direct",
          })),
        };
      }),
  );

  if (!withheld.includes("complete_task")) {
    server.registerTool(
      "complete_task",
      {
        description:
          "Complete the current task. Work tasks require the full handoff doc (" +
          describeHandoffFields() +
          ") and a committed work tree — commit your changes before calling this. " +
          "Every other type requires outcome: the findings or judgment you reached. " +
          "resume_context is what the next session needs to pick the work back up — " +
          "do not describe landing state (push / PR / merge): the board lands the " +
          "branch after you complete, and you cannot observe that. " +
          BOARD_WRITE_LANGUAGE_RULE,
        // the schema stays permissive: a missing field is enforced inside the verb
        // (a domain error), but an unknown key is rejected by the schema itself
        // (a protocol error)
        inputSchema: {
          handoff: z
            .partialRecord(z.enum(HANDOFF_FIELDS), z.string())
            .optional(),
        },
      },
      async ({ handoff }) =>
        // 着地(PR 昇格)は後始末の中、**merge-back の後**に走る(ADR 0109 決定1):
        // 待たずに PR を開くと tree rule / merge-back より先に昇格が走り、昇格は古い
        // remote-tracking ref を読む。response はここで先に返る。
        runReleasingVerb(
          deps,
          attributedTaskId,
          (task) => (workerId, now) => {
            const done = completeTask(deps.db, task, handoff, workerId, now, "worker");
            return { id: done.id, status: done.status };
          },
          (task, workspace) => assertWorkTreeCommitted(deps, task, workspace),
        ),
    );
  }

  server.registerTool(
    "log_decision",
    {
      description:
        "Record an in-authority decision as one log line and keep working. " +
        "The line lands in the human-skimmed decision log. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: { line: requiredTextSchema },
    },
    async ({ line }) =>
      runVerb(deps, attributedTaskId, (task) => {
        // so the worker's transcript carries this decision's board-issued key (ADR 0083)
        const eventId = logDecision(
          deps.db,
          task,
          line,
          attributedWorkerId(deps, task),
          deps.clock.now(),
          "worker",
        );
        return { logged: true, event_id: eventId };
      }),
  );

  if (!withheld.includes("decompose")) {
    server.registerTool(
      "decompose",
      {
        description:
          "Split the remaining work into child tasks in one decision: records the " +
          "reason in the decision log, queues the children at the tail, blocks the " +
          "current task until they all finish, and frees the slot. Once every child " +
          "settles, the task becomes pickable again in normal queue order to " +
          "integrate and complete for real. " +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: {
          reason: requiredTextSchema,
          children: decomposeChildrenSchema(deps.db),
        },
      },
      async (input) =>
        runReleasingVerb(deps, attributedTaskId, (task) => {
          assertChildrenKnown(deps, input.children);
          const authority = attributedAuthorityOrQuarantine(deps, task);
          return (workerId, now) => {
            const children = decomposeTask(deps.db, task, input, workerId, now, authority, deps.isProtectedWorkspace, "worker");
            return { child_ids: children.map((c) => c.id), parent_status: "blocked" };
          };
        }),
    );
  }

  if (added.includes("pose_probe")) {
    server.registerTool(
      "pose_probe",
      {
        description:
          "Pose this Interview's probe: the title, the probe (the problem statement every target solves), the completion " +
          "criteria and the rubric you will score the answers against. Before posing, compose the environment the probe needs in your " +
          "working directory, the interview room: the board commits a copy of its working tree, as it stands, as the head every answer " +
          "starts from, without touching your checkout. The board logs all four as one decision, registers a review that audits the " +
          "probe, blocks this task and frees the slot. If the audit accepts it, the board registers one answer task per target in " +
          "get_current_task's interview_targets with the same title, the probe as its purpose and the same completion criteria, and " +
          "this task stays blocked until every answer settles; once they settle you resume and finish with complete_interview. If the " +
          "audit rejects it, you resume with its findings in your history and pose again. Once answer tasks are registered the probe " +
          "is not posed again. The answer tasks never read the rubric. A target the default agent cannot run is refused by name; you " +
          "cannot fix that, so escalate. " +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: {
          title: requiredTextSchema,
          probe: requiredTextSchema,
          completion_criteria: requiredTextSchema,
          rubric: requiredTextSchema,
        },
      },
      async (input) => {
        // ADR 0273 決定3: 出題の head は面接室の写しの commit。拒まれる出題は写さない —— 検査を写しの前に置く。
        // 門が走らない(workspace が解決できない)出題は head を記録できないので拒む(ADR 0263 追記5)
        let head: string | undefined;
        return runReleasingVerb(
          deps,
          attributedTaskId,
          (task) => (workerId, now) => {
            if (head === undefined) {
              throw new DomainError(`this task's workspace cannot be resolved, so the head the probe forks from cannot be recorded${ESCALATE_UNFIXABLE}`);
            }
            const audit = poseProbe(deps.db, task, input, workerId, now, "worker", head);
            return { audit_id: audit.id, parent_status: "blocked" };
          },
          (task, room) => {
            assertPosable(deps.db, task);
            if (deps.taskExecutionCandidates) {
              assertTargetsRunnable(deps.db, task.id, deps.taskExecutionCandidates, deps.defaultAgentName, ESCALATE_UNFIXABLE);
            }
            head = commitRoomCopy(deps.db, room);
          },
        );
      },
    );
  }

  if (added.includes("complete_audit")) {
    server.registerTool(
      "complete_audit",
      {
        description:
          "Complete this audit of an Interview's probe, in one call: verdict is accepted when the environment, the probe and the " +
          "rubric ask for the work the measured tier's description names in a way the tier below it would not satisfy, rejected " +
          "otherwise, and findings says why. On accepted the board registers one answer task per target; on rejected the " +
          "Interview's root resumes with your findings and poses again. " +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: { verdict: z.enum(INTERVIEW_OUTCOMES), findings: requiredTextSchema },
      },
      completing(completeAudit),
    );
  }

  if (added.includes("complete_integration_review")) {
    server.registerTool(
      "complete_integration_review",
      {
        description:
          "Complete this integration review of the parent task's deliverable, in one call. findings is your assessment and " +
          "is always required. If you filed what you found as repair tasks with decompose, the board records the review as " +
          "repaired, naming those repair tasks and their statuses: call this once every repair task has settled (an unsettled " +
          "one is refused), and no_findings is then not needed — passing it is harmless. If you filed no repair task, pass " +
          "no_findings: true to say the deliverable has nothing to repair; without it the call is refused and nothing is recorded. " +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: { findings: requiredTextSchema, no_findings: z.literal(true).optional() },
      },
      completing(completeIntegrationReview),
    );
  }

  if (added.includes("complete_memory_review")) {
    server.registerTool(
      "complete_memory_review",
      {
        description:
          "Complete this memory meta-review, in one call. The Items to judge part of your material section lists what this cycle needs a " +
          "judgment on. Entries ({entry: id}) are the candidates drafted in this window, the candidates and entries named by the settled " +
          "proposals and by the objected decisions with cause memory, and the store changes; every entry is listed only while its latest " +
          "copy is still live. Branches ({branch: path, scope: workspace " +
          "name, or null for the whole board}) are those holding entries without a Definition in their scope or whole-board: one item per " +
          "scope that lacks one, or a single whole-board item when whole-board entries sit at or under the path. The live entries and " +
          "branches named by the judgments of the objected decisions are listed too. That list, injected when " +
          "this session started, is the whole set of items: anything added to the store since belongs to the next cycle. An item acted on " +
          "since this session started is already judged: one you wrote, folded, moved, retired, defined or named in a proposal, or one " +
          "anyone else has since folded, moved, retired or defined. Every other item goes in judgments, which means you left it as is, " +
          "with an optional one-line reason; the board records one decision line per item. Listing an item already judged is harmless: " +
          "it is accepted and records nothing. " +
          "A missing item is refused as unjudged, and an entry or branch not on the injected list — even one you wrote in this session — " +
          "is refused; each is named by id, or by path and scope, and nothing is recorded. The handoff takes the same " +
          `fields as complete_task (${describeHandoffFields()}); none is required. ` +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: {
          judgments: z.array(
            z.union([
              z.strictObject({ entry: z.number().int(), reason: z.string().optional() }),
              z.strictObject({ branch: z.string(), scope: z.string().nullable(), reason: z.string().optional() }),
            ]),
          ),
          handoff: z.partialRecord(z.enum(HANDOFF_FIELDS), z.string()).optional(),
        },
      },
      completing(completeMemoryReview),
    );
  }

  if (added.includes("complete_routing_review")) {
    server.registerTool(
      "complete_routing_review",
      {
        description:
          "Complete this routing meta-review, in one call. The Items to judge part of your material section lists the objects this cycle " +
          "needs a judgment on: rows ({row: {provider, model, effort}}; the tier beside a row is for reading and may be left out) — the rows " +
          "that ran in the diverged shadow rows, the rows humans changed and the rows of the new cells — agents ({agent: name}) and tiers " +
          "({tier: name}) of the allocation reviews, and the learner ({learner: true}) — plus the rows, agents and tiers named by the " +
          "judgments of the objected decisions, under the same conditions. That list, injected when this session started, is the " +
          "whole set of items. An item is already judged when one of your proposals names it — op row or add_tier its row, agent_tier its " +
          "agent, tier_description its tier, promote or demote the learner, interview the rows its evidence sessions ran on — or when anyone " +
          "has changed it since this session started. Every other item goes in judgments, which means no_change, with an optional one-line " +
          "reason; the board records one decision line per item. Listing an item already judged is harmless: it is accepted and records " +
          "nothing. A missing item is refused as unjudged, and an object not on the injected list is refused; each is named, and nothing is " +
          `recorded. The handoff takes the same fields as complete_task (${describeHandoffFields()}); none is required. ` +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: {
          judgments: z.array(
            z.union([
              z.strictObject({ row: rowKeySchema.strict(), tier: z.string().optional(), reason: z.string().optional() }),
              z.strictObject({ agent: z.string(), reason: z.string().optional() }),
              z.strictObject({ tier: z.string(), reason: z.string().optional() }),
              z.strictObject({ learner: z.literal(true), reason: z.string().optional() }),
            ]),
          ),
          handoff: z.partialRecord(z.enum(HANDOFF_FIELDS), z.string()).optional(),
        },
      },
      completing((db, task, input: Parameters<typeof completeRoutingReview>[2], workerId, now, origin) =>
        completeRoutingReview(db, task, input, workerId, now, origin, routingPrecedents(db, task.id), deps.agentAdmin?.list?.()),
      ),
    );
  }

  if (added.includes("complete_rca")) {
    server.registerTool(
      "complete_rca",
      {
        description:
          "Complete this RCA, in one call. " +
          (stopRca
            ? "Your review was opened on a human stop (its material, quoted in your purpose as \"stop <id>: <reason>\"; get_current_task's actions is " +
              "that session's action sequence): findings is one finding {entries: [the stop id], root_cause: one line}. A missing, repeated or " +
              "other id is refused, named by id, and nothing is recorded. "
            : "findings groups the objected entries your review was opened on (its material, each quoted in your purpose as \"entry <id>: ...\") by root cause: " +
              "each finding is {entries: [entry ids], root_cause: one line}, and every material entry goes in exactly one finding. A missing, " +
              "repeated or non-material entry is refused, named by id, and nothing is recorded. ") +
          "The board records one decision line per finding " +
          "and lists its acts from the record: the memory you wrote with propose_from_objection from that finding's entries" +
          // decompose を伏せた RCA には分解の修理を言わない(ADR 0301 決定5)
          (withheld.includes("decompose")
            ? ". "
            : ", and the repair tasks you filed with decompose (every repair task is listed on every finding; call this once each has settled). ") +
          "Only a finding " +
          "without an act needs no_proposal: true, and without it the call is refused; on a finding with an act it is harmless and records " +
          `nothing. The handoff takes the same fields as complete_task (${describeHandoffFields()}); none is required. ` +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: {
          findings: z.array(z.strictObject({ entries: z.array(z.number().int()), root_cause: requiredTextSchema, no_proposal: z.literal(true).optional() })),
          handoff: z.partialRecord(z.enum(HANDOFF_FIELDS), z.string()).optional(),
        },
      },
      completing(completeRca),
    );
  }

  if (added.includes("complete_interview")) {
    server.registerTool(
      "complete_interview",
      {
        description:
          "Complete this Interview once every child has settled, in one call: score each done child against the rubric you " +
          "posed with its probe, as written — not against the best answer you saw, and not against each other — from its " +
          "handoff alone. The board withholds which agent and model ran it; do not guess one. Write your findings in " +
          "handoff.outcome, naming for each answer what decided its score: the deliverable and its evidence, not the " +
          "confidence of the prose. scores lists every done child exactly once: child_id is the id the child carries in " +
          "get_current_task's history, and outcome is accepted when the deliverable meets the rubric, rejected when it does " +
          "not. A child still unsettled, a missing, repeated, unknown or not-done child, or a missing outcome is refused " +
          "and nothing is recorded. Do not bend the rubric after reading the answers: if they show the probe or rubric " +
          "itself was broken, report it with report_broken_probe instead of scoring them. The handoff " +
          `takes the same fields as complete_task (${describeHandoffFields()}); only outcome is required. ` +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: {
          scores: z.array(z.object({ child_id: requiredTextSchema, outcome: z.enum(INTERVIEW_OUTCOMES) })),
          handoff: z.partialRecord(z.enum(HANDOFF_FIELDS), z.string()).optional(),
        },
      },
      completing(completeInterview),
    );
  }

  if (added.includes("report_broken_probe")) {
    server.registerTool(
      "report_broken_probe",
      {
        description:
          "Report that this Interview's probe was broken, instead of scoring the answers: give the reason and recommend " +
          "abandon (end this Interview) or retry (end it and register a new Interview with the same targets and purpose, " +
          "whose root reads your reason). The board registers a continue / abandon / retry question for the human with your " +
          "reason, the posed probe and rubric and the done children's ids, blocks this task until the human answers, and " +
          "frees the slot. On continue you resume and score with complete_interview. You report once per Interview. " +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: { reason: requiredTextSchema, recommendation: z.enum(["abandon", "retry"]) },
      },
      async (input) =>
        runReleasingVerb(deps, attributedTaskId, (task) => (workerId, now) => {
          const question = reportBrokenProbe(deps.db, task, input, workerId, now, "worker");
          return { question_id: question.id, parent_status: "blocked" };
        }),
    );
  }

  server.registerTool(
    "escalate",
    {
      description:
        "Escalate a decision outside your authority (or an execution dead end): " +
        "registers a question task carrying 1-4 question items (each 2-4 options plus " +
        "a recommendation) sharing one context, blocks the current task on it, and " +
        "frees the slot. A human answers every item in one atomic submission. " +
        BOARD_WRITE_LANGUAGE_RULE,
      // the schema stays permissive: item-count, option-count, and
      // recommendation invariants are enforced inside the verb so callers get
      // a domain error
      inputSchema: {
        context: requiredTextSchema,
        questions: z.array(
          z.object({
            title: requiredTextSchema,
            detail: requiredTextSchema.optional(),
            options: z.array(requiredTextSchema),
            recommendation: requiredTextSchema,
          }),
        ),
      },
    },
    async (input) =>
      runReleasingVerb(deps, attributedTaskId, (task) => (workerId, now) => {
        const question = escalateTask(deps.db, task, input, workerId, now, "worker");
        return { question_id: question.id, parent_status: "blocked" };
      }),
  );

  if (!withheld.includes("declare_premise_breach")) {
    server.registerTool(
      "declare_premise_breach",
      {
        description:
          "Declare that the premise of the decomposition decision your task rests on is false " +
          "(for example, a sibling's result contradicts it). Not a failure. Every unsettled child " +
          "of that decision, this task included, is held until the decision's author judges: an " +
          "agent-authored decision returns your parent early to continue or redecompose; a " +
          "human-authored decision, or a repeat breach of the same decision, becomes a " +
          "continue / abandon question for the human. This task stays unsettled and the slot is " +
          "freed — commit your work first. A root task or a child outside a decomposition " +
          "decision escalates instead. " +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: { reason: requiredTextSchema },
      },
      async ({ reason }) =>
        runReleasingVerb(deps, attributedTaskId, (task) => (workerId, now) => {
          const question = declarePremiseBreach(deps.db, task, reason, workerId, now, "worker");
          return { question_id: question?.id ?? null, status: "held" };
        }),
    );
  }

  if (!withheld.includes("continue_decomposition")) {
    server.registerTool(
      "continue_decomposition",
      {
        description:
          "Answer a child's premise breach by keeping your decomposition decision: records your " +
          "judgment as one decision-log line (the child resumes with it in its history), releases " +
          "the held children, blocks this task again, and frees the slot. Your continue is final " +
          "for this premise — a repeat breach goes to the human. Only while a child of this task " +
          "has an open premise breach; then plain decompose and complete_task are refused. " +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: { line: requiredTextSchema },
      },
      async ({ line }) =>
        runReleasingVerb(deps, attributedTaskId, (task) => (workerId, now) => {
          continueDecomposition(deps.db, task, line, workerId, now, "worker");
          return { parent_status: "blocked" };
        }),
    );
  }

  if (!withheld.includes("redecompose")) {
    server.registerTool(
      "redecompose",
      {
        description:
          "Answer a child's premise breach by replacing your decomposition decision in one call: " +
          "cancels every unsettled child of the breached decision (done children stay), then " +
          "decomposes the remaining work exactly as decompose does, and frees the slot. Only " +
          "while a child of this task has an open premise breach. " +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: { reason: requiredTextSchema, children: decomposeChildrenSchema(deps.db) },
      },
      async (input) =>
        runReleasingVerb(deps, attributedTaskId, (task) => {
          assertChildrenKnown(deps, input.children);
          const authority = attributedAuthorityOrQuarantine(deps, task);
          return (workerId, now) => {
            const children = redecompose(deps.db, task, input, workerId, now, authority, deps.isProtectedWorkspace, "worker");
            return { child_ids: children.map((c) => c.id), parent_status: "blocked" };
          };
        }),
    );
  }

  if (subject === null && !withheld.includes("record_knowledge")) {
    server.registerTool(
      "record_knowledge",
      {
        description:
          "Record a fact you established about this workspace so later sessions can read it " +
          "instead of rediscovering it. It is kept as-is (no approval step); you cannot edit or " +
          "withdraw it. path is a \"/\"-separated hierarchy (e.g. build/tests). When you open a new branch, " +
          "define it first with define_memory_branch. source is exactly " +
          "one of {event_id} (a board event id, such as one log_decision returned) or {commit} " +
          "(a commit hash). " +
          BOARD_WRITE_LANGUAGE_RULE,
        // the schema stays permissive: the exactly-one-source invariant is
        // enforced inside the verb so callers get a domain error
        inputSchema: {
          path: requiredTextSchema,
          title: requiredTextSchema,
          text: requiredTextSchema,
          source: z.object({ event_id: z.number().int().optional(), commit: z.string().optional() }).optional(),
        },
      },
      async (input) =>
        runVerb(deps, attributedTaskId, (task) =>
          recordKnowledge(
            deps.db,
            {
              ...input,
              scope: memoryScope(deps, task),
              author: { activity: "worker_verb", name: attributedWorkerId(deps, task) },
            },
            "worker",
            deps.clock.now(),
            task.id,
          ),
        ),
    );
  }

  if (!withheld.includes("propose_from_objection")) server.registerTool(
    "propose_from_objection",
    {
      description:
        (stopRca
          ? "Review only: turn your finding about the human stop your review was opened on into memory — pass that stop's id (its material) as entry_id. The board derives the entry kind and addressee from the cause attributed to that stop, "
          : "Review only: turn your finding about an objected entry into memory — only the objected entries your review was opened on (its material). The board derives the entry kind and addressee from the cause attributed to those objections, ") +
        "except for a missing_information cause, where you pass as (behavior or knowledge) and must not otherwise. " +
        "With as knowledge, pass based_on_decision (the event id log_decision returned for your reasoning), and not otherwise; it becomes the knowledge entry's source, an inference. " +
        `A behavior is a candidate a human approves later. ${TIER_DEFINITION_RULE} path is a "/"-separated hierarchy (e.g. build/tests). ` +
        "The board records the write on your review with the entry it came from, and complete_rca lists it on the finding that holds that entry. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        entry_id: z.number().int(),
        path: requiredTextSchema,
        title: requiredTextSchema,
        text: requiredTextSchema,
        as: z.enum(["behavior", "knowledge"]).optional(),
        based_on_decision: z.number().int().optional(),
      },
    },
    async (input) =>
      runVerb(deps, attributedTaskId, (task) => proposeFromObjection(deps.db, task.id, input, deps, attributedWorkerId(deps, task), deps.clock.now())),
  );

  // ADR 0273 決定2・9: interview の root は routing の読み口と、根拠があれば根拠の history の読み口を持つ
  if (added.includes("list_routing_shadow")) {
    const run = slotRun(deps, attributedTaskId);
    registerPrecedentRead(server, deps, run);
    registerRoutingReads(server, deps, run);
  }
  if (added.includes("read_evidence_history")) {
    server.registerTool(
      "read_evidence_history",
      {
        description:
          "Read the history of one of this Interview's evidence tasks (get_current_task's interview.evidence_task_ids): its decisions with " +
          "their children, its completion with the handoff_doc, and the allocation reviews of its sessions, in the order they happened. " +
          "A task that is not an evidence task of this Interview is refused. " +
          nextDescription("read_evidence_history", "history rows"),
        inputSchema: { task_id: requiredTextSchema.optional(), next },
      },
      async (input) =>
        runVerb(deps, attributedTaskId, (task) => {
          const read = readPosition<{ task_id?: string }>("read_evidence_history", input);
          const evidenceId = read.args.task_id ?? "";
          const rows = evidenceHistoryRows(deps.db, task.id, evidenceId);
          // 根拠が Interview の root なら、その面接室も読みに開いている(ADR 0273 決定9)
          const room = interviewRoomPath(deps.db, evidenceId);
          return packItems(read, "history", rows.map((row) => row.entry), room === undefined ? {} : { interview_room: room }, { keyOf: (_, i) => rows[i]!.id });
        }),
    );
  }

  if (subject !== null) {
    registerMetaReviewVerbs(server, deps, attributedTaskId, subject);
    return server;
  }
  // ADR 0252 決定4 / ADR 0272 決定3: 記憶の修理 verb は memory_repair の type で足す
  if (attributedTaskId !== null && getTask(deps.db, attributedTaskId)?.type === "memory_repair") registerMemoryRepairVerbs(server, deps, attributedTaskId);
  // ADR 0279 決定4 / ADR 0283 決定3: routing の判断の行を運ぶ routing_repair は routing の読み口と提案 verb と指針の節の id 読みを足す
  // (対象の門は domain が持つ)
  if (attributedTaskId !== null && routingRepairVerbs(deps.db, attributedTaskId).length > 0) {
    const run = slotRun(deps, attributedTaskId);
    registerPrecedentRead(server, deps, run);
    registerMemoryEntriesRead(server, deps, run);
    registerRoutingMetaReviewVerbs(server, deps, run);
  }
  // ADR 0283 追記1: 行の主題を持つ RCA も親の主題の読み手で、指針の節の id 読みを持つ
  if (attributedTaskId !== null && isSubjectReaderRca(deps.db, attributedTaskId)) registerMemoryEntriesRead(server, deps, slotRun(deps, attributedTaskId));

  if (!withheld.includes("define_memory_branch")) {
    server.registerTool(
      "define_memory_branch",
      {
        description:
          "Define a memory branch (a path prefix such as build/tests) for this workspace: one line declaring " +
          "what is filed under it — not a summary of what is there now, but a sentence that stays true as " +
          "entries come and go. It is kept as-is (no approval step). " +
          "A path that holds whole-board entries at or under it cannot be defined for this workspace: file under the branch as it is, or define a sub-branch. " +
          BOARD_WRITE_LANGUAGE_RULE,
        inputSchema: { prefix: requiredTextSchema, definition: requiredTextSchema },
      },
      async (input) =>
        runVerb(deps, attributedTaskId, (task) =>
          defineMemoryBranch(
            deps.db,
            {
              scope: memoryScope(deps, task),
              path: input.prefix,
              text: input.definition,
              author: { activity: "worker_verb", name: attributedWorkerId(deps, task) },
            },
            "worker",
            deps.clock.now(),
            task.id,
          ),
        ),
    );
  }

  // spec #586 D: 記憶の pull。各 pull は memory_pulled を書き、その event id を返す
  // (Precedent の memory マーカーの結合キー)。
  const reader = (task: Task) => ({ taskId: task.id, scope: memoryScope(deps, task), agent: attributedWorkerId(deps, task) });

  if (!withheld.includes("browse_memory")) server.registerTool(
    "browse_memory",
    {
      description:
        "Browse the board's memory index for this workspace: the direct children of a path " +
        "prefix — children (a deeper prefix you can browse next, with its one-line definition of what is " +
        "filed under it, or null if undefined), and entries (id + title) filed at that " +
        "path. Omit prefix for the top level. Read an entry's text with read_memory. " +
        "Children come first, by name, then entries, by id. " +
        nextDescription("browse_memory", "children and entries"),
      inputSchema: { prefix: z.string().optional(), next },
    },
    async (input) => runVerb(deps, attributedTaskId, (task) => browseMemory(deps.db, reader(task), input, deps.clock.now())),
  );

  if (!withheld.includes("search_memory")) server.registerTool(
    "search_memory",
    {
      description:
        "Search the board's memory for this workspace by full-text query; results are " +
        "{id, title, path} in rank order. Entries are " +
        "searched by their English text; query in English. Read an entry's text with read_memory. " +
        "Definitions are not searched; the index in your Memory section and browse_memory carry them. " +
        nextDescription("search_memory", "results"),
      inputSchema: { query: requiredTextSchema.optional(), next },
    },
    async (input) => runVerb(deps, attributedTaskId, (task) => searchMemory(deps.db, reader(task), input, deps.clock.now())),
  );

  if (!withheld.includes("read_memory")) server.registerTool(
    "read_memory",
    {
      description:
        "Read memory entries by id: text, path, and source. source_kind is fact (backed by " +
        "a commit or board event) or inference (backed by an agent's decision) — weigh it. " +
        "A behavior's case is the example it was drafted from: the decision, the steering objections " +
        "raised against it, and that session's handoff and result — or, for a whole session, its decisions " +
        "in order with the handoff and result; case is null when there is none. " +
        "An id whose entry was moved or restored returns the entry it now lives as, with requested_id " +
        "set to the id you asked for. Any other invalidated id returns no entry but a dropped item with " +
        "the reason — superseded, capability (it was wrong), environment / requirement_change (it went " +
        "stale), or path_moved (moved where you cannot see) — and the successor id when you can see it. " +
        "Ids you cannot see are omitted. Entries come in id order. " +
        nextDescription("read_memory", "entries", "`dropped` comes"),
      inputSchema: { ids: z.array(z.number().int()).min(1).optional(), next },
    },
    async (input) => runVerb(deps, attributedTaskId, (task) => readMemory(deps.db, reader(task), input, deps.clock.now())),
  );

  return server;
}

/** 記憶の修理子の書き込み verb に足す射程の文(ADR 0281): 門は domain が対象で切り替える。運ぶ行の種類の分だけ言う。 */
function memoryRepairReach({ writes, judgments }: { writes: boolean; judgments: boolean }): string {
  const reaches = [
    ...(writes
      ? [
          "the entries the objected memory writes created, invalidated or moved (and the copies those were moved to since) and the branches they defined " +
            "or moved entries into, under the repair rules — moving an entry back to where that write moved it from always works",
        ]
      : []),
    ...(judgments ? ["the entries and branches the objected judgments name, under the meta-review rules — define_memory, fold_memory and propose_memory_change take only those"] : []),
  ];
  // 修理子の書き込みは対象の scope に留まる(ADR 0285 決定2)—— meta-review の規則が許す盤面全体へ広げる向きは修理子には開かない。門は requireRepairKeepsScope(memory.ts)で、ここはそれを伝える文
  return (
    ` This repair changes only what the objected rows in your purpose reach: ${reaches.join("; and ")}. Anything else is refused.` +
    ` ${writes ? "Apart from moving back, every" : "Every"} write stays in its object's own scope: a repair never widens to the whole board, nor supersedes or folds into a successor in another scope.`
  );
}

/** 記憶の修理子の verb(ADR 0252 決定4 / ADR 0279 決定3 / ADR 0281): 運ぶ行の種類で組を登録する —— 同じ操作の verb は meta-review と
 *  1つの tool で、対象の範囲と門は domain が呼び出し時に持つ。 */
function registerMemoryRepairVerbs(server: McpServer, deps: McpDeps, attributedTaskId: string): void {
  const kinds = memoryRepairKinds(deps.db, attributedTaskId);
  const run = slotRun(deps, attributedTaskId);
  const side: MemoryWriteSide = { activity: "worker_verb", reach: memoryRepairReach(kinds), judges: kinds.judgments };
  if (kinds.judgments) {
    registerPrecedentRead(server, deps, run);
    registerMemoryMetaReviewVerbs(server, deps, run, side);
  } else registerMemoryMoves(server, deps, run, side);
  if (kinds.reads) registerMemoryEntriesRead(server, deps, run);
  if (!kinds.writes) return;
  const scope =
    "These repair verbs take only the entries the objected memory writes in your purpose created, invalidated or moved, and the copies those were moved to since. ";

  server.registerTool(
    "restore_memory",
    {
      description:
        "Repair only: restore an entry the objected memory write dropped — the board copies it back as it was, to its own scope and path. " +
        `Refused while its successor is live: drop the successor first when the write created it. ${scope}`,
      inputSchema: { entry_id: z.number().int() },
    },
    async (input) => run((repairer, now) => repairRestore(deps.db, repairer, input, now)),
  );

  server.registerTool(
    "restore_memory_branch",
    {
      description:
        "Repair only: undo the objected memory write's branch move in one step. Every entry that write moved and that now lives at path or under it " +
        "in scope (null for the whole board) goes back to the scope and path it had before that write, Definitions included; entries that arrived " +
        "under path later stay. Returns how many entries were moved back.",
      inputSchema: { scope: requiredTextSchema.nullable(), path: requiredTextSchema },
    },
    async (input) => run((repairer, now) => repairMoveBranchBack(deps.db, repairer, input, now)),
  );

  server.registerTool(
    "replace_memory",
    {
      description:
        "Repair only: replace a Knowledge entry or a Definition the objected memory write touched with a new body at the same scope and path; the old one is superseded. " +
        "A Knowledge entry takes title, text and source, exactly one of {event_id} (a board event id, such as one log_decision returned) or {commit}; a Definition takes text only, one line. " +
        "Behaviors and Exemplars are not replaced here. " +
        scope +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        entry_id: z.number().int(),
        title: requiredTextSchema.optional(),
        text: requiredTextSchema,
        source: z.object({ event_id: z.number().int().optional(), commit: z.string().optional() }).optional(),
      },
    },
    async (input) => run((repairer, now) => repairReplace(deps.db, repairer, input, now)),
  );
}

/** 直接適用の scope(ADR 0122 決定1): null = 盤面全体は常に可、workspace 名は registry と照合する。registry の無い盤面
 *  では照合できないので名前を拒む(buildWorkspaceResolver の固定 workspace への fallback はどの名前も通すので使わない)。 */
function registeredScope(deps: McpDeps, scope: string | null): string | null {
  if (scope === null) return null;
  if (!deps.resolveWorkspace) throw new DomainError(`unknown workspace: ${scope}`);
  assertWorkspaceKnown(scope, deps.resolveWorkspace, undefined);
  return scope;
}

type MetaReviewRun = (verb: (reader: { taskId: string; agent: string }, now: Date) => unknown) => ReturnType<typeof runVerb>;
/** 主題の門を持たない読み手(interview の root・修理子)の run: slot の task と走る agent で verb を呼ぶ。 */
const slotRun =
  (deps: McpDeps, taskId: string | null): MetaReviewRun =>
  (verb) =>
    runVerb(deps, taskId, (task) => verb({ taskId: task.id, agent: attributedWorkerId(deps, task) }, deps.clock.now()));

/** meta-review の主題の専用 verb(issue #619・#917 / ADR 0120 決定2・ADR 0122)。tool 一覧は権限の境界ではないので、
 *  呼び出し時の門も持つ。Precedent の読み口は両主題で共有する。 */
function registerMetaReviewVerbs(server: McpServer, deps: McpDeps, attributedTaskId: string | null, subject: MetaReviewSubject): void {
  const run: MetaReviewRun = (verb) =>
    runVerb(deps, attributedTaskId, (task) => {
      // 自身の列: 問いは「この task は meta-review か」で、行の主題ではない(ADR 0283 決定1)
      if (metaReviewSubjectOf(deps.db, task.id) !== subject) throw new DomainError(`${subject} meta-review verbs are only for a ${subject} meta-review task`);
      return verb({ taskId: task.id, agent: attributedWorkerId(deps, task) }, deps.clock.now());
    });
  registerPrecedentRead(server, deps, run);
  registerMemoryEntriesRead(server, deps, run);
  if (subject === "memory") registerMemoryMetaReviewVerbs(server, deps, run);
  else registerRoutingMetaReviewVerbs(server, deps, run);
}

/** 指針の節の id 読み: 両主題の meta-review と、親の主題の読み手である主題の修理子(memory_repair / routing_repair)と行の主題を持つ RCA が持つ
 *  (ADR 0279 決定2 / ADR 0283 決定3・追記1 —— 指針の節はどれにも注入され、その本文はこれで読む)。 */
function registerMemoryEntriesRead(server: McpServer, deps: McpDeps, run: MetaReviewRun): void {
  server.registerTool(
    "read_memory_entries",
    {
      description:
        "Read memory entries by id, across every scope, addressee and state: each entry's row (the one a memory meta-review's list_memory_entries returns), plus case for a Behavior " +
        "or Exemplar — the example it was drafted from (the decision, the steering objections raised against it, and that session's handoff " +
        "and result, or a whole session's decisions in order with the handoff and result); null when there is none. An id whose entry was " +
        "moved or restored returns the entry it now lives as, with requested_id set to the id you asked for. Any other invalidated entry comes " +
        "back as it is, text included, with its invalidation_reason and successor_id. Ids that do not exist are listed in missing. " +
        "Entries come in id order. " +
        nextDescription("read_memory_entries", "entries", "`missing` comes"),
      inputSchema: { ids: z.array(z.number().int()).min(1).optional(), next },
    },
    async (input) => run((reader, now) => readMemoryEntries(deps.db, reader, input, now)),
  );
}

/** Precedent の読み口: 両主題の meta-review・interview の root(ADR 0273 決定2)・両方の修理子(ADR 0279 決定3・4)が共有する。 */
function registerPrecedentRead(server: McpServer, deps: McpDeps, run: MetaReviewRun): void {
  server.registerTool(
    "list_precedents",
    {
      description:
        "List objected decisions and objected memory writes from past worker sessions: the line, objections and their attributed cause, " +
        "the session outcome, and the memory entry ids read (entries_read) and seen (entries_seen) before the decision. " +
        "When the cause is memory, entries names the ids of the entries the worker read and followed that were wrong; otherwise it is null. " +
        "Rows are limited to your subject: a routing meta-review or routing repair sees the decisions of routing meta-reviews and their children, a memory meta-review " +
        "or memory repair every other decision, and an Interview all of them. " +
        "Defaults to objections since the previous completed meta-review of your subject (for an Interview or a repair, the board's start); pass since_watermark (an event id) to look further back. " +
        nextDescription("list_precedents", "precedents"),
      inputSchema: { since_watermark: z.number().int().min(0).optional(), next },
    },
    async (input) => run((reader, now) => listPrecedents(deps.db, reader, input, now)),
  );
}

/** 表の行の鍵、Interview の対象の綴り(provider, model, effort)。 */
const rowKey = z.object({ provider: z.string(), model: z.string(), effort: z.string().nullable() });

const since_watermark = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("An event id; defaults to the previous completed routing meta-review's registration (for an Interview or a repair, the board's start).");

/** shadow 行と配分の読み口: 主題 routing の meta-review・interview の root(ADR 0273 決定2)・routing_repair(ADR 0279 決定4)が共有する。 */
function registerRoutingReads(server: McpServer, deps: McpDeps, run: MetaReviewRun): void {
  server.registerTool(
    "list_routing_shadow",
    {
      description:
        "List the learner's shadow rows: for each work pickup, the cell the learner recommended, the cell that actually ran " +
        "and the selector's source, with that session's worker_spawned_event_id, workspace, agent, tier (the tier it ran in; tier_retired marks a deleted tier) " +
        "and outcome (accepted / rejected / excluded, cost, duration), each of these null when the pickup opened no session, and writer (always present), the writer of the task's text (human for a human). " +
        "recommended_record and actual_record are the two cells' track records as of that pickup (accepted and rejected, board and " +
        "workspace stage, production sessions only — Interview examinees are not counted — and seed: null, or the kind (interview: an accepted score of a done Interview; human: a row added as observed) and event_id of the seed that stands in for the table's prior for that cell and tier), and candidates is how many rows the pickup could choose from after exclusions — with one, the two cells always match. " +
        "diverged marks rows where the two cells differ; diverged_only returns only those. When source.provider is learner, the " +
        "learner was promoted and chose what ran, and recommended is what the table would have chosen instead. Rows come oldest first. " +
        nextDescription("list_routing_shadow", "rows"),
      inputSchema: { since_watermark, diverged_only: z.boolean().optional(), next },
    },
    async (input) => run((reader) => listRoutingShadow(deps.db, reader.taskId, input)),
  );

  server.registerTool(
    "list_allocations",
    {
      description:
        "List the allocation-review distribution: evaluated annotations counted by the session's tier source, row, tier, agent, workspace " +
        "(none when the task has none), writer of the task's text (human for a human), allocation and cause, with judged_by_same_model counting those whose judge ran on the worker's own model. tier is the tier " +
        "the session ran in, whatever its tier source; tier_retired marks a deleted tier, counted apart from a live tier of the same name. " +
        "Unevaluated annotations are not counted. " +
        nextDescription("list_allocations", "allocations"),
      inputSchema: { since_watermark, next },
    },
    async (input) => run((reader) => listAllocations(deps.db, reader.taskId, input)),
  );
}

/** 主題 routing の読み口(issue #917 / spec #916 C)。集計はドメイン層(routing-review.ts)。 */
function registerRoutingMetaReviewVerbs(server: McpServer, deps: McpDeps, run: MetaReviewRun): void {
  registerRoutingReads(server, deps, run);

  server.registerTool(
    "list_routing_cells",
    {
      description:
        "List cells (provider, model, effort, advisor) first observed in a finished production session, or seeded, since the watermark " +
        "(a seeded cell with no production session yet has first_observed_event_id null and advisor null), and the " +
        "execution-setting table rows humans wrote since then (an edit also carries the key of the row it replaced; a row added as observed carries seed with the human's rationale). " +
        "Each cell carries seeds: the tiers whose table row for its provider, model and effort has a seed standing in for the table's prior, with the seed's kind (interview / human) and event_id. " +
        nextDescription("list_routing_cells", "cells", "The rows come in full"),
      inputSchema: { since_watermark, next },
    },
    async (input) => run((reader) => listRoutingCells(deps.db, reader.taskId, input)),
  );

  server.registerTool(
    "read_routing_settings",
    {
      description:
        "Read the current execution-setting table, the board's tiers with their descriptions in order, the advisor ceiling (off / sonnet / opus / fable / fable_then_opus), the provider rank, the default priorities (`priority` for work tasks that request none, `reviewPriority` for every review task), " +
        "whether the learner is promoted, the board's default tier (`defaultTier` — the tier of tasks that request none and whose agent declares none, " +
        "and of the board's drafts) and judgement tier (`judgementTier` — the tier the board's own judgement runs on: retrospective Board calls resolve " +
        "on its anthropic row, and periodic meta-reviews request it), and every past routing proposal (agent tier proposals included) with its answer, the " +
        "human's amendment and comment, or why the board settled it as observed (the pinned row, learner flag, agent tier or tier description " +
        "changed, an Interview proposal's evidence row changed or a table row now matches its target, or what it pinned is gone: the row deleted or its effort changed, or the tier deleted). An applied agent tier proposal carries the registry commit it landed as applied. " +
        "Proposals come oldest first. " +
        nextDescription("read_routing_settings", "proposals", "The table and settings come"),
      inputSchema: { next },
    },
    async (input) => run(() => readRoutingSettings(deps.db, input)),
  );

  server.registerTool(
    "propose_routing_change",
    {
      description:
        "Propose a routing change to the human as one approve / reject question attached to this task. op row replaces the " +
        `tier (one of the board's tiers) and/or effort (${EFFORT_LEVELS.join(" / ")}) of one existing execution-setting row, named by provider, model and effort; ` +
        "change takes only those two fields, and the human may amend them when approving. evidence (required) lists the worker_spawned event ids of production sessions that ran on that row in its current tier (the shadow rows' worker_spawned_event_id). A change that would give the model a second row in one tier, or the same effort twice, is refused. Some Claude models take no effort or run `xhigh` / `max` as `high`; the refusal names the value to write. op promote makes work tasks run on the " +
        "learner's recommendation and is only accepted while the learner is not promoted; op demote returns them to the table and " +
        "is only accepted while it is promoted; neither takes row, change, or an amendment. Both take evidence (required): the worker_spawned " +
        "event ids of sessions of diverged shadow rows (the shadow rows' worker_spawned_event_id) — for promote rows from before promotion, for " +
        "demote rows where the promoted learner's choice ran. The board shows the human, for each tier, workspace, learner cell and table cell " +
        "you cite, the count and both cells' track records, and the diverged pickups since the learner flag last changed that you did not cite. op agent_tier lowers a non-built-in " +
        "agent's default tier by exactly one step (an agent with no tier runs at the board default tier): agent names it, " +
        "to is the tier one step below, and evidence lists the worker_spawned event ids of that agent's production sessions whose tier came " +
        "from its default tier; it is refused when the execution-setting table has no runnable row (one not under a row quarantine) at the target tier for any of the agent's providers. The " +
        "human may amend to with any lower tier when approving, and approval commits the new tier to the registry. op tier_description rewrites " +
        "the description of one of the board's tiers (tier) to description, one line: a tier's description defines it for everyone who requests it, " +
        "so propose it when requests for that tier across workspaces or writers show its definition is off. evidence lists the worker_spawned event ids " +
        "of production sessions of tasks that requested that tier, whose tier source is task, since its description last changed (rows of " +
        "list_routing_shadow whose source.tier is task); the human may amend the " +
        "description when approving. op add_tier adds a tier named tier, with description as its one-line description, to the board's list at " +
        "position (an index into the list, lowest first; 0 puts it at the bottom) and moves the row named by provider, model and effort into " +
        "it, both at once; evidence lists the worker_spawned event ids of production sessions on the rows of the moved row's tier that ran in " +
        "that tier, and the human may amend the tier's name, " +
        "description and position when approving. op interview proposes measuring targets before any row changes: hypothesis is the claim to test, " +
        "measured_work (optional) the kind of work to measure, tier the one tier measured, and targets one or more (provider, model, effort) of that tier — " +
        "each another effort or tier of a model already in the table, never a row of the table in that tier. evidence (required) lists the worker_spawned " +
        "event ids of the production sessions your case rests on, each in its row's current tier (the shadow rows' worker_spawned_event_id); workspace is the real environment the " +
        "Interview's root reads, a registered workspace that one of those sessions ran in (the shadow rows' workspace). Approval registers the Interview " +
        "in the human's name; the human may amend the hypothesis, measured_work, the targets' efforts and the workspace. For op row, agent_tier, " +
        "tier_description, add_tier and interview, the board shows the human the sessions you cite, grouped with their count, task ids, outcomes and " +
        "allocation reviews, and the sessions of the same kind you did not cite; an evidence id outside those sessions is refused with the reason. " +
        "rationale is your reading of the evidence and is shown with the diff. The board applies the answer itself, so you can complete " +
        "this task without waiting for it. Returns the question id. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        op: z.enum(["row", "promote", "demote", "agent_tier", "tier_description", "add_tier", "interview"]),
        row: rowKey.optional().describe("op row and add_tier only."),
        change: z.record(z.string(), z.unknown()).optional().describe(`op row only: tier and/or effort (${EFFORT_LEVELS.join(" / ")}), nothing else.`),
        agent: z.string().optional().describe("op agent_tier only: the agent whose default tier to lower."),
        to: z.string().optional().describe("op agent_tier only: the tier one step below the agent's current tier."),
        evidence: z
          .array(z.number().int())
          .optional()
          .describe("required for every op: worker_spawned event ids of the production sessions your case rests on, of the kind the tool description names for the op. op promote and demote: the worker_spawned_event_id of diverged shadow rows."),
        tier: z.string().optional().describe("op tier_description: the tier whose description to rewrite. op add_tier: the new tier's name. op interview: the tier measured."),
        hypothesis: z.string().optional().describe("op interview only: the claim the Interview tests."),
        measured_work: z.string().optional().describe("op interview only, optional: the kind of work to measure."),
        targets: z.array(rowKey).optional().describe("op interview only: the (provider, model, effort) targets to measure in the tier."),
        workspace: z.string().optional().describe("op interview only: the real environment the Interview's root reads, the workspace of one of the evidence sessions."),
        description: z.string().optional().describe("op tier_description and add_tier only: the tier's description, one line."),
        position: z.number().int().nonnegative().optional().describe("op add_tier only: where the new tier goes, an index into the board's list (lowest first)."),
        rationale: requiredTextSchema,
      },
    },
    async (input) =>
      run((reader, now) =>
        proposeRoutingChange(deps.db, reader.taskId, input, reader.agent, now, deps.agentAdmin?.list, (name) => assertWorkspaceKnown(name, deps.resolveWorkspace, deps.workspace)),
      ),
  );
}

/** 書き込み verb の書き手の側: meta-review か記憶の修理子(ADR 0281)。activity は書き込みの印、reach は修理子の射程の文、judges は
 *  判断の側の verb(define_memory / fold_memory / propose_memory_change)を持つか —— 説明文が持たない verb を指さないため。 */
type MemoryWriteSide = { activity: "meta_review" | "worker_verb"; reach: string; judges: boolean };
const META_REVIEW_SIDE: MemoryWriteSide = { activity: "meta_review", reach: "", judges: true };
const memoryScopeSchema = requiredTextSchema.nullable().describe("A registry workspace name, or null for the whole board.");

/** 主題 memory の専用 verb(issue #619)。判断の行を運ぶ記憶の修理子も同じ組を持つ(ADR 0279 決定3)。 */
function registerMemoryMetaReviewVerbs(server: McpServer, deps: McpDeps, run: MetaReviewRun, side = META_REVIEW_SIDE): void {
  const author = (reader: { agent: string }) => ({ activity: side.activity, name: reader.agent });
  const scope = memoryScopeSchema;

  server.registerTool(
    "list_memory_candidates",
    {
      description:
        "List memory candidates with their cause, author, and source. include_invalidated adds invalidated " +
        "candidates with their invalidation reason, successor, and invalidated_by: question_id when a human answered a proposal " +
        "(read its comment in list_memory_proposals), activity when a meta-review retired or replaced it, worker otherwise. A candidate superseded " +
          "by a successor a human wrote was approved with the human's amendment, or replaced by a consolidation the human amended; successor " +
          "shows the wording they approved instead. Candidates come in id order. " +
        nextDescription("list_memory_candidates", "candidates"),
      inputSchema: { include_invalidated: z.boolean().optional(), kind: z.enum(["behavior", "exemplar"]).optional(), next },
    },
    async (input) => run((reader, now) => pullMemoryList(deps.db, reader, "list_memory_candidates", input, now)),
  );

  server.registerTool(
    "list_memory_entries",
    {
      description:
        "List the memory entries the human settings view lists, each entry's original wording omitted — candidates and invalidated entries " +
        "included. scope: a workspace name, null for board-wide only, omit for all. " +
        "path: only the entries at that branch or under it (path/…). " +
        nextDescription("list_memory_entries", "entries"),
      inputSchema: {
        scope: scope.optional(),
        kind: memoryListFilterSchema.shape.kind,
        state: memoryListFilterSchema.shape.state,
        path: memoryListFilterSchema.shape.path,
        next,
      },
    },
    async (input) => run((reader, now) => pullMemoryList(deps.db, reader, "list_memory_entries", input, now)),
  );

  server.registerTool(
    "list_memory_branches",
    { description: `${MEMORY_BRANCHES_DESCRIPTION} ${nextDescription("list_memory_branches", "branches")}`, inputSchema: { next } },
    async (input) => run((reader, now) => pullMemoryBranches(deps.db, reader, input, now)),
  );

  server.registerTool(
    "list_memory_proposals",
    {
      description:
        "List every past memory proposal (approve, consolidate, invalidate) with the human's answer, amendment and comment, or " +
        "why the board settled it as observed (an entry it pinned was invalidated first). A rejected or deferred proposal always carries the " +
        "human's reason or what is still undecided in comment — read it so you re-propose a rejected one only when that reason no longer holds, and can redraft closer to what they want. " +
        "Each pinned entry that was since moved or restored is listed in relocated with the entry its body now lives as (tail_id, path, scope) " +
        "and that entry's invalidation_reason (null while it is live): re-propose with tail_id, not the pinned id. " +
        "Proposals come oldest first. " +
        nextDescription("list_memory_proposals", "proposals"),
      inputSchema: { next },
    },
    async (input) => run((reader, now) => pullMemoryProposals(deps.db, reader, input, now)),
  );

  server.registerTool(
    "search_memory_entries",
    {
      description:
        "Search the board's memory across every scope and addressee: Knowledge, Behaviors and Exemplars that are live (approved or candidate) " +
        "or were dropped without a successor, with the reason. Pass query (free text; terms are OR-ed and ranked) or like (an entry id: searches " +
        "with that entry's own title and text, excluding the entry itself). Returns pointers only — read the text with read_memory_entries. " +
        "Definitions are not searched: the branch list carries them. Results come in rank order. " +
        nextDescription("search_memory_entries", "results"),
      inputSchema: { query: requiredTextSchema.optional(), like: z.number().int().optional(), next },
    },
    async (input) => run((reader, now) => searchMemoryEntries(deps.db, reader, input, now)),
  );

  server.registerTool(
    "define_memory",
    {
      description:
        "Draft or revise a branch definition in the given scope: one line declaring what is filed under the path. " +
        "A branch has one definition per scope; revise it with supersedes. supersedes lists definitions at this path only; a " +
        "definition at another path is refused. To rename a branch or merge two, use move_memory_branch, then revise the " +
        "definition in place. A definition in supersedes must " +
        "be in the same scope or, when this definition is whole-board, in any scope. " +
        "A workspace definition is refused at a path that holds whole-board entries at or under it, and a whole-board entry is refused at or under a path a workspace defines. " +
        "To clear the way, write a whole-board definition at the workspace definition's path with supersedes, or rename the workspace branch with move_memory_branch. " +
        BOARD_WRITE_LANGUAGE_RULE + side.reach,
      inputSchema: { scope, path: requiredTextSchema, definition: requiredTextSchema, supersedes: z.array(z.number().int()).min(1).optional() },
    },
    async (input) =>
      run((reader, now) =>
        defineMemoryByMetaReview(
          deps.db,
          {
            scope: registeredScope(deps, input.scope),
            path: input.path,
            text: input.definition,
            supersedes: input.supersedes,
            author: author(reader),
          },
          "worker",
          now,
          reader.taskId,
        ),
      ),
  );

  server.registerTool(
    "fold_memory",
    {
      description:
        "Fold the entries in replaces into one successor: each is invalidated as superseded by it. Give exactly one of: " +
        "scope, path, title, text and based_on_decision, to write a new Knowledge entry replacing Knowledge entries (based_on_decision " +
        "is the event id log_decision returned for your reasoning; it becomes the source, an inference); or successor_id, an existing " +
        "approved entry: Knowledge into Knowledge, Behavior and Exemplar candidates into an approved Behavior or Exemplar. The successor must cover every entry in replaces: its scope is whole-board or the same scope, and its addressee " +
        "is every agent or the same agent. An approved Behavior or Exemplar cannot be replaced here — propose a consolidate instead. " +
        BOARD_WRITE_LANGUAGE_RULE + side.reach,
      inputSchema: {
        replaces: z.array(z.number().int()),
        successor_id: z.number().int().optional(),
        scope: scope.optional(),
        path: requiredTextSchema.optional(),
        title: requiredTextSchema.optional(),
        text: requiredTextSchema.optional(),
        based_on_decision: z.number().int().optional(),
      },
    },
    async (input) =>
      run((reader, now) => foldMemory(deps.db, reader.taskId, { ...input, scope: input.scope && registeredScope(deps, input.scope), author: author(reader) }, "worker", now)),
  );

  registerMemoryMoves(server, deps, run, side);

  server.registerTool(
    "propose_memory_change",
    {
      description:
        "Propose a Behavior or Exemplar change to the human as one approve / reject / defer question attached to this task. op approve asks to " +
        "approve a Behavior or Exemplar candidate exactly as worded (candidate_id), even while entries it once proposed to replace are " +
        "still live. op consolidate replaces the candidates, approved Behaviors and Exemplars in replaces with one successor: text, " +
        "drafted as a new candidate; successor_id, an approved Behavior or Exemplar you keep instead; or candidate_id, an existing " +
        "Behavior or Exemplar candidate. With successor_id, replaces takes approved entries only; fold a candidate into an existing approved " +
        "entry with fold_memory's successor_id. Re-propose a consolidation that went stale or was deferred with its candidate_id and the " +
        "replaces you now judge right. When re-proposing a past proposal, take each id from list_memory_proposals' relocated tail_id " +
        "where that entry was moved or restored. With text, based_on_decision is the event id log_decision returned for your reasoning; the new " +
        "candidate keeps the source the replaced entries share, and takes based_on_decision as its source when they share none. With " +
        "text.kind exemplar it is an Exemplar: give annotations instead of text.text; the replaced entries must share a source that " +
        "renders a case; an Exemplar candidate_id likewise needs replaces that share its source. op invalidate asks to drop the " +
        "approved Behavior or Exemplar target_id, with no successor, for reason capability / environment / requirement_change. rationale is why you propose it (the question's context). " +
        PROMOTION_RULE +
        " " +
        "The board applies the answer itself, so you can complete this task without waiting for it. Returns the question id. " +
        BOARD_WRITE_LANGUAGE_RULE + side.reach,
      inputSchema: {
        op: z.enum(["approve", "consolidate", "invalidate"]),
        candidate_id: z.number().int().optional(),
        text: z
          .object({
            scope,
            path: requiredTextSchema,
            title: requiredTextSchema,
            text: requiredTextSchema.optional(),
            addressee: requiredTextSchema.nullable(),
            kind: z.enum(["behavior", "exemplar"]).optional(),
            annotations: z
              .array(metaReviewAnnotationSchema)
              .optional()
              .describe(
                "kind exemplar only. anchor is whole, or a case field (decision / steering / handoff / result) with a quote copied verbatim " +
                  "from it — read the case with read_memory_entries (any entry in replaces carries it); polarity is imitate or avoid; text says what to imitate or avoid.",
              ),
          })
          .optional()
          .describe("op consolidate: the new candidate — a Behavior (text.text) unless kind is exemplar. addressee is an agent name, or null for every agent."),
        successor_id: z.number().int().optional(),
        replaces: z.array(z.number().int()).optional(),
        based_on_decision: z.number().int().optional(),
        target_id: z.number().int().optional(),
        reason: invalidationSchema.shape.reason.optional(),
        rationale: requiredTextSchema,
      },
    },
    async (input) =>
      run((reader, now) => {
        // 宛先も scope と同じく registry と照合する(ADR 0173 決定2)—— typo の宛先を人間の approve へ回さない
        assertMemoryReferencesKnown(deps, { addressee: input.text?.addressee });
        return proposeMemoryChange(
          deps.db,
          reader.taskId,
          { ...input, text: input.text && { ...input.text, scope: registeredScope(deps, input.text.scope) } },
          reader.agent,
          now,
        );
      }),
  );
}

/** 同じ操作の書き込み verb(ADR 0281 決定1): meta-review と記憶の修理子のどの組でも1つの tool で、入力の形は meta-review 版。
 *  どちらの規則で動くかは domain が対象で決める。 */
function registerMemoryMoves(server: McpServer, deps: McpDeps, run: MetaReviewRun, side: MemoryWriteSide): void {
  const author = (reader: { agent: string }) => ({ activity: side.activity, name: reader.agent });
  const scope = memoryScopeSchema;

  server.registerTool(
    "move_memory",
    {
      description:
        "Move one entry to another path in its scope, or widen it to the whole board: the board copies it — title, text, " +
        "source, author, state and approval included — into a new entry and invalidates the old one as path_moved. Any kind, " +
        "approved or candidate. scope is the entry's own scope or null (whole-board). Refused: narrowing to a workspace or " +
        "moving between workspaces; changing the scope of an approved Behavior or Exemplar, or of an entry an open proposal " +
        "question names; changing a Definition's path (use move_memory_branch)." + side.reach,
      inputSchema: { entry_id: z.number().int(), scope, path: requiredTextSchema },
    },
    async (input) =>
      run((reader, now) => moveMemoryByMetaReview(deps.db, { ...input, scope: registeredScope(deps, input.scope), mover: author(reader) }, "worker", now, reader.taskId)),
  );

  server.registerTool(
    "move_memory_branch",
    {
      description:
        "Move a branch — every live entry at path or under it in scope — to to_path in to_scope, in one step. This is how " +
        "a branch is renamed and how two branches are merged. to_scope is scope or null (whole-board); widening is refused " +
        "as a whole when the branch holds an approved Behavior or Exemplar or an entry an open proposal question names. " +
        "Moving a whole-board branch to another whole-board path also carries every workspace's entries under path, each " +
        "staying in its own scope. When a moved Definition would land on a path already defined in its scope, the move is " +
        "refused and names every such pair. To merge, pass merge: true: each of those Definitions is folded into the one " +
        "already there (superseded — the destination's wording stays; revise it in place with " + (side.judges ? "define_memory" : "replace_memory") + " before or " +
        "after) and everything else moves. merge: true is refused when no such pair exists. Returns moved and folded (how " +
        "many entries were moved and how many Definitions were folded) with to_scope and to_path." + side.reach,
      inputSchema: { scope, path: requiredTextSchema, to_scope: scope, to_path: requiredTextSchema, merge: z.boolean().optional() },
    },
    // 照合は行き先の scope だけ —— 移動元は行を引くだけ(人間の面の枝ごとの移動と同じ、ADR 0173 決定2)
    async (input) =>
      run((reader, now) => {
        const { moved, folded, event_id } = moveMemoryBranchByMetaReview(deps.db, { ...input, to_scope: registeredScope(deps, input.to_scope), mover: author(reader) }, "worker", now, reader.taskId);
        return { moved: moved.length, folded: folded.length, to_scope: input.to_scope, to_path: input.to_path, event_id };
      }),
  );

  server.registerTool(
    "invalidate_memory",
    {
      description:
        "Drop a candidate (Behavior or Exemplar), Knowledge entry, or Definition with no successor. reason is " +
        "capability / environment / requirement_change, or rejected — only for a candidate that will become neither a Behavior nor an Exemplar. " +
        (side.judges
          ? "To replace an entry, use fold_memory, define_memory's supersedes, move_memory or move_memory_branch. " +
            "An approved Behavior or Exemplar cannot be invalidated here — propose it instead."
          : "To replace an entry, use replace_memory, move_memory or move_memory_branch.") +
        side.reach,
      inputSchema: metaReviewInvalidationSchema.extend({ entry_id: z.number().int() }),
    },
    async (input) => run((reader, now) => ({ event_id: invalidateMemoryByMetaReview(deps.db, input, reader.agent, "worker", now, reader.taskId) })),
  );
}

export function createMcpRouter(deps: McpDeps): Router {
  return createStatelessMcpRouter((req) => {
    const taskParam = typeof req.query.task === "string" ? req.query.task : null;
    return buildMcpServer(deps, taskParam);
  });
}
