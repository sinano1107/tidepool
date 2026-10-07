import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import type { AgentAdmin } from "./agent-create.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { DEFAULT_AUDITOR_NAME } from "./defaults.js";
import { DomainError } from "./domain-error.js";
import { PRIORITY_FIELD_DESCRIPTION, tierFieldDescriptions } from "./execution-setting.js";
import type { GitHubClient } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import { assertMemoryReferencesKnown, assertReviewersKnown, assertWorkspaceKnown } from "./human-verbs.js";
import type { Landing } from "./landing.js";
import {
  browseMemory,
  defineMemoryBranch,
  defineMemoryByMetaReview,
  foldMemory,
  invalidateMemoryByMetaReview,
  invalidationSchema,
  listPrecedents,
  memoryListFilterSchema,
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
  searchMemory,
  searchMemoryEntries,
} from "./memory.js";
import { type MetaReviewSubject, metaReviewSubjectOf, PROMOTION_RULE, TIER_DEFINITION_RULE } from "./meta-review.js";
import type { ProcessContainers } from "./process-container.js";
import { type AuthorityProfile, REVIEWER_AUTHORITY_PROFILE, type RosterAgent } from "./registry.js";
import { nextDescription, packItems, readPosition } from "./response-budget.js";
import { proposeFromObjection } from "./retrospective.js";
import { listAllocations, listRoutingCells, listRoutingShadow, proposeRoutingChange, readRoutingSettings } from "./routing-review.js";
import type { Slot } from "./slot.js";
import { createStatelessMcpRouter, floorEveryResponse, rejectUnknownArguments } from "./stateless-mcp.js";
import {
  assigneeNeedsApproval,
  completeTask,
  contentSourceFor,
  continueDecomposition,
  declarePremiseBreach,
  decomposeTask,
  describeHandoffFields,
  escalateTask,
  getTask,
  HANDOFF_FIELDS,
  type HistoryRow,
  HUMAN_ROSTER_AGENT,
  joinHistory,
  logDecision,
  redecompose,
  resolveTaskAgent,
  type Task,
  taskHistoryRows,
} from "./tasks.js";
import { markTeardown, runTeardown, type TeardownDeps, teardownStep } from "./teardown.js";
import { HUMAN_WORKER_ID } from "./worker-id.js";
import {
  buildWorkspaceResolver,
  completionTreeGateApplies,
  resolveOrQuarantine,
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
  landing: Landing;
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
  resolveAuthority?: (assignee: string | null) => AuthorityProfile | undefined;
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
  /** Whether an agent name is currently registered (ADR 0012 / issue #36),
   *  read fresh against the registry — used to reject a decompose child's
   *  unknown assignee outright (the registering agent's own mistake, same
   *  treatment as an unknown child workspace). Absent → no registry
   *  configured, so any assignee name is accepted, same as the workspace
   *  check's fallback. */
  agentRegistered?: (name: string) => boolean;
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
}

/** Every MCP call is attributed to a real agent session (never human — that's
 *  the separate /answer route), so an unspecified (null) assignee resolves to
 *  the board's default agent, not `HUMAN_WORKER_ID` (ADR 0012 / issue #36) —
 *  made type-aware for `review` tasks (issue #42 / CONTEXT.md's Auditor): a
 *  review task's unset assignee attributes to the Auditor pointer instead,
 *  which is never unset (`auditorName` falls back to `DEFAULT_AUDITOR_NAME`). */
function attributedWorkerId(deps: McpDeps, task: Task): string {
  return resolveTaskAgent(
    task,
    deps.defaultAgentName,
    deps.auditorName ?? DEFAULT_AUDITOR_NAME,
  );
}

/** The authority governing this task: a `review` task always runs under the
 *  fixed reviewer profile (registry.ts, ADR 0013), regardless of who it's assigned
 *  to. Otherwise `resolveAuthority` read fresh against the task's own
 *  `assignee` when configured (ADR 0012 / issue #36), else the board's single
 *  fixed `authority` (pre-#36 shape, and still today's shape for a board with
 *  no registry-backed resolver at all). */
function attributedAuthority(deps: McpDeps, task: Task): AuthorityProfile | undefined {
  if (task.type === "review") return REVIEWER_AUTHORITY_PROFILE;
  return deps.resolveAuthority?.(task.assignee) ?? deps.authority;
}

export function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function toolError(message: string) {
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
async function runVerb(
  deps: McpDeps,
  attributedTaskId: string | null,
  verb: (task: Task) => unknown,
) {
  const resolved = resolveAttributedTask(deps, attributedTaskId);
  if ("error" in resolved) return toolError(resolved.error);
  try {
    return toolResult(await verb(resolved.task));
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
  return resolveOrQuarantine(deps.db, resolve, task.workspace, deps.clock.now());
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

/** Verbs that end the slot session (complete, decompose, escalate): run the
 *  domain verb attributed to the slot worker, then hand the release to the
 *  session's 後始末. Work completion opts into lineage merge-back; every other
 *  release only stashes WIP. A domain error keeps the slot — the session
 *  continues.
 *
 *  ADR 0109 決定1: verb は final MCP call の中で同期に着地し、response はすぐ返る ——
 *  workspace の解放と slot の解放**だけ**が回収済み観測の後ろへ移る。worker exit と
 *  回収済み観測を待つ循環待ちは作らない(待つのは `void` の先である)。
 *
 *  `gate` は verb の**前**に走る(ADR 0084 の完了の門)。門を持つ verb だけが workspace を
 *  前倒しで解決するのは、解決自体が quarantine の副作用を持つため —— 前へ出すと、domain
 *  error で終わった escalate / decompose にまでその副作用が及ぶ。門が解決した結果は
 *  **解決できなかったとき(`null`)も含めて**そのまま後始末へ渡す —— `undefined` で渡すと
 *  後始末が「まだ解決していない」と読んで同じ観測をもう一度 quarantine する(1つの verb
 *  呼び出しで2度撃たない)。 */
function runReleasingVerb(
  deps: McpDeps,
  attributedTaskId: string | null,
  verb: (task: Task, workerId: string, now: Date) => object,
  gate?: (task: Task, workspace: WorkspaceConfig) => void,
) {
  return runVerb(deps, attributedTaskId, (task) => {
    const workspace = gate ? (resolveTaskWorkspace(deps, task) ?? null) : undefined;
    if (gate && workspace) gate(task, workspace);
    const result = verb(task, attributedWorkerId(deps, task), deps.clock.now());
    // 後始末に入った(CONTEXT.md「後始末」)。枠を握っているのは task ではなく
    // session であり、この事実は再起動をまたぐので行にも持つ(ADR 0109 決定5)。
    markTeardown(deps.db, task.id, deps.clock.now());
    deps.slot.enterTeardown();
    const teardown: TeardownDeps = {
      db: deps.db,
      clock: deps.clock,
      slot: deps.slot,
      resolve: buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace),
      githubAuth: deps.githubAuth,
      landing: deps.landing,
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
  // registry — the registering agent's own mistake, not an authority
  // question, so it's rejected outright before the assignable_to check
  // even runs. `human` is valid only as a work assignee, never a reviewer.
  for (const child of children) {
    if (deps.agentRegistered) {
      if (
        child.assignee !== undefined &&
        child.assignee !== HUMAN_WORKER_ID &&
        !deps.agentRegistered(child.assignee)
      ) {
        throw new DomainError(`unknown agent: ${child.assignee}`);
      }
    }
    assertReviewersKnown(deps.agentRegistered, child.review_by);
  }
}

/** review の欄は、完了時レビューが立つ子にしか受け付けない(ADR 0111 追記8)。 */
export const ONLY_WHERE_REVIEW_FIRES =
  "Accepted only on a child whose completion raises a review: not assigned to human, and carrying review_flag or risk_flag.";

/** decompose と redecompose が共有する子の入力。段の説明は盤面の一覧から組む(ADR 0200 決定3)。 */
function decomposeChildrenSchema(db: Db) {
  const tierDescriptions = tierFieldDescriptions(db);
  return z.array(
    z.object({
      title: z.string().min(1),
      purpose: z.string().min(1),
      completion_criteria: z.string().min(1),
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
      review_by: z.array(z.string().min(1)).optional()
        .describe(`Reviewer agent names; one completion review per name. Omit to use the board Auditor. ${ONLY_WHERE_REVIEW_FIRES}`),
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
  const subject = attributedTaskId === null ? null : metaReviewSubjectOf(deps.db, attributedTaskId);

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
        const envelope =
          read.at === undefined && {
            ...(await taskContext(deps, task)),
            type: task.type,
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

  server.registerTool(
    "list_agents",
    {
      description:
        "List every agent in the registry, plus human — the pull half of the roster. " +
        "Your system prompt's own Roster section already lists who you can delegate to " +
        "directly; call this only to see the full board, with each entry marked " +
        '"direct" or "needs_approval" (converts to a human approval question).',
    },
    async () =>
      runVerb(deps, attributedTaskId, (task) => {
        const authority = attributedAuthority(deps, task);
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

  server.registerTool(
    "complete_task",
    {
      description:
        "Complete the current task. Work tasks require the full handoff doc (" +
        describeHandoffFields() +
        ") and a committed work tree — commit your changes before calling this. " +
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
        (task, workerId, now) => {
          const done = completeTask(deps.db, task, handoff, workerId, now, "worker");
          return { id: done.id, status: done.status };
        },
        (task, workspace) => assertWorkTreeCommitted(deps, task, workspace),
      ),
  );

  server.registerTool(
    "log_decision",
    {
      description:
        "Record an in-authority decision as one log line and keep working. " +
        "The line lands in the human-skimmed decision log. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: { line: z.string().min(1) },
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
        reason: z.string().min(1),
        children: decomposeChildrenSchema(deps.db),
      },
    },
    async (input) =>
      runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        assertChildrenKnown(deps, input.children);
        const children = decomposeTask(
          deps.db,
          task,
          input,
          workerId,
          now,
          attributedAuthority(deps, task),
          deps.isProtectedWorkspace,
          "worker",
        );
        return { child_ids: children.map((c) => c.id), parent_status: "blocked" };
      }),
  );

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
        context: z.string().min(1),
        questions: z.array(
          z.object({
            title: z.string().min(1),
            detail: z.string().min(1).optional(),
            options: z.array(z.string()),
            recommendation: z.string(),
          }),
        ),
      },
    },
    async (input) =>
      runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        const question = escalateTask(deps.db, task, input, workerId, now, "worker");
        return { question_id: question.id, parent_status: "blocked" };
      }),
  );

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
      inputSchema: { reason: z.string().min(1) },
    },
    async ({ reason }) =>
      runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        const question = declarePremiseBreach(deps.db, task, reason, workerId, now, "worker");
        return { question_id: question?.id ?? null, status: "held" };
      }),
  );

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
      inputSchema: { line: z.string().min(1) },
    },
    async ({ line }) =>
      runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        continueDecomposition(deps.db, task, line, workerId, now, "worker");
        return { parent_status: "blocked" };
      }),
  );

  server.registerTool(
    "redecompose",
    {
      description:
        "Answer a child's premise breach by replacing your decomposition decision in one call: " +
        "cancels every unsettled child of the breached decision (done children stay), then " +
        "decomposes the remaining work exactly as decompose does, and frees the slot. Only " +
        "while a child of this task has an open premise breach. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: { reason: z.string().min(1), children: decomposeChildrenSchema(deps.db) },
    },
    async (input) =>
      runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        assertChildrenKnown(deps, input.children);
        const children = redecompose(
          deps.db,
          task,
          input,
          workerId,
          now,
          attributedAuthority(deps, task),
          deps.isProtectedWorkspace,
          "worker",
        );
        return { child_ids: children.map((c) => c.id), parent_status: "blocked" };
      }),
  );

  if (subject === null) {
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
          path: z.string(),
          title: z.string().min(1),
          text: z.string().min(1),
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
          ),
        ),
    );
  }

  server.registerTool(
    "propose_from_objection",
    {
      description:
        "Review only: turn your finding about an objected entry into memory — only the objected entries your review was opened on (its material). The board derives the entry kind and addressee from the cause attributed to those objections, " +
        "except for a missing_information cause, where you pass as (behavior or knowledge) and must not otherwise. " +
        "With as knowledge, pass based_on_decision (the event id log_decision returned for your reasoning), and not otherwise; it becomes the knowledge entry's source, an inference. " +
        `A behavior is a candidate a human approves later. ${TIER_DEFINITION_RULE} path is a "/"-separated hierarchy (e.g. build/tests). ` +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        entry_id: z.number().int(),
        path: z.string(),
        title: z.string().min(1),
        text: z.string().min(1),
        as: z.enum(["behavior", "knowledge"]).optional(),
        based_on_decision: z.number().int().optional(),
      },
    },
    async (input) =>
      runVerb(deps, attributedTaskId, (task) => proposeFromObjection(deps.db, task.id, input, deps, attributedWorkerId(deps, task), deps.clock.now())),
  );

  if (subject !== null) {
    registerMetaReviewVerbs(server, deps, attributedTaskId, subject);
    return server;
  }

  server.registerTool(
    "define_memory_branch",
    {
      description:
        "Define a memory branch (a path prefix such as build/tests) for this workspace: one line declaring " +
        "what is filed under it — not a summary of what is there now, but a sentence that stays true as " +
        "entries come and go. It is kept as-is (no approval step). " +
        "A path that holds whole-board entries at or under it cannot be defined for this workspace: file under the branch as it is, or define a sub-branch. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: { prefix: z.string(), definition: z.string() },
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
        ),
      ),
  );

  // spec #586 D: 記憶の pull。各 pull は memory_pulled を書き、その event id を返す
  // (Precedent の memory マーカーの結合キー)。
  const reader = (task: Task) => ({ taskId: task.id, scope: memoryScope(deps, task), agent: attributedWorkerId(deps, task) });

  server.registerTool(
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

  server.registerTool(
    "search_memory",
    {
      description:
        "Search the board's memory for this workspace by full-text query; results are " +
        "{id, title, path} in rank order. Entries are " +
        "searched by their English text; query in English. Read an entry's text with read_memory. " +
        "Definitions are not searched; the index in your Memory section and browse_memory carry them. " +
        nextDescription("search_memory", "results"),
      inputSchema: { query: z.string().min(1).optional(), next },
    },
    async (input) => runVerb(deps, attributedTaskId, (task) => searchMemory(deps.db, reader(task), input, deps.clock.now())),
  );

  server.registerTool(
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

/** 直接適用の scope(ADR 0122 決定1): null = 盤面全体は常に可、workspace 名は registry と照合する。registry の無い盤面
 *  では照合できないので名前を拒む(buildWorkspaceResolver の固定 workspace への fallback はどの名前も通すので使わない)。 */
function registeredScope(deps: McpDeps, scope: string | null): string | null {
  if (scope === null) return null;
  if (!deps.resolveWorkspace) throw new DomainError(`unknown workspace: ${scope}`);
  assertWorkspaceKnown(scope, deps.resolveWorkspace, undefined);
  return scope;
}

type MetaReviewRun = (verb: (reader: { taskId: string; agent: string }, now: Date) => unknown) => ReturnType<typeof runVerb>;

/** meta-review の主題の専用 verb(issue #619・#917 / ADR 0120 決定2・ADR 0122)。tool 一覧は権限の境界ではないので、
 *  呼び出し時の門も持つ。Precedent の読み口は両主題で共有する。 */
function registerMetaReviewVerbs(server: McpServer, deps: McpDeps, attributedTaskId: string | null, subject: MetaReviewSubject): void {
  const run: MetaReviewRun = (verb) =>
    runVerb(deps, attributedTaskId, (task) => {
      if (metaReviewSubjectOf(deps.db, task.id) !== subject) throw new DomainError(`${subject} meta-review verbs are only for a ${subject} meta-review task`);
      return verb({ taskId: task.id, agent: attributedWorkerId(deps, task) }, deps.clock.now());
    });

  server.registerTool(
    "list_precedents",
    {
      description:
        "List objected decisions from past worker sessions: the decision line, objections and their attributed cause, " +
        "the session outcome, and the memory entry ids read (entries_read) and seen (entries_seen) before the decision. " +
        "When the cause is memory, entries names the ids of the entries the worker read and followed that were wrong; otherwise it is null. " +
        "Defaults to objections since the previous completed meta-review of your subject; pass since_watermark (an event id) to look further back. " +
        nextDescription("list_precedents", "precedents"),
      inputSchema: { since_watermark: z.number().int().min(0).optional(), next },
    },
    async (input) => run((reader, now) => listPrecedents(deps.db, reader, input, now)),
  );

  if (subject === "memory") registerMemoryMetaReviewVerbs(server, deps, run);
  else registerRoutingMetaReviewVerbs(server, deps, run);
}

/** 主題 routing の読み口(issue #917 / spec #916 C)。集計はドメイン層(routing-review.ts)。 */
function registerRoutingMetaReviewVerbs(server: McpServer, deps: McpDeps, run: MetaReviewRun): void {
  const since_watermark = z.number().int().min(0).optional().describe("An event id; defaults to the previous completed routing meta-review's registration.");

  server.registerTool(
    "list_routing_shadow",
    {
      description:
        "List the learner's shadow rows: for each work pickup, the cell the learner recommended, the cell that actually ran " +
        "and the selector's source, with that session's agent and outcome (accepted / rejected / excluded, cost, duration). " +
        "recommended_record and actual_record are the two cells' track records as of that pickup (accepted and rejected, board and " +
        "workspace stage), and candidates is how many rows the pickup could choose from after exclusions — with one, the two cells always match. " +
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
        "List the allocation-review distribution: evaluated annotations counted by the session's tier source, tier, agent, " +
        "allocation and cause, with judged_by_same_model counting those whose judge ran on the worker's own model. tier is the tier " +
        "the task requested when the tier source is task, null otherwise; tier_retired marks a deleted tier, counted apart from a live tier of the same name. " +
        "Unevaluated annotations are not counted. " +
        nextDescription("list_allocations", "allocations"),
      inputSchema: { since_watermark, next },
    },
    async (input) => run((reader) => listAllocations(deps.db, reader.taskId, input)),
  );

  server.registerTool(
    "list_routing_cells",
    {
      description:
        "List cells (provider, model, effort, advisor) first observed in a finished session since the watermark, and the " +
        "execution-setting table rows humans wrote since then (an edit also carries the key of the row it replaced). " +
        nextDescription("list_routing_cells", "cells", "The rows come in full"),
      inputSchema: { since_watermark, next },
    },
    async (input) => run((reader) => listRoutingCells(deps.db, reader.taskId, input)),
  );

  server.registerTool(
    "read_routing_settings",
    {
      description:
        "Read the current execution-setting table, the board's tiers with their descriptions in order, the advisor ceiling (off / sonnet / opus / fable), the provider rank, the default priority, " +
        "whether the learner is promoted, the board's default tier (`defaultTier` — the tier of tasks that request none and whose agent declares none, " +
        "and of the board's drafts) and judgement tier (`judgementTier` — the tier the board's own judgement runs on: retrospective Board calls resolve " +
        "on its anthropic row, and periodic meta-reviews request it), and every past routing proposal (agent tier proposals included) with its answer, the " +
        "human's amendment and comment, or why the board settled it as observed (the pinned row, learner flag, agent tier or tier description " +
        "changed, or what it pinned is gone: the row deleted or its effort changed, or the tier deleted). An applied agent tier proposal carries the registry commit it landed as applied. " +
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
        "tier (one of the board's tiers) and/or effort of one existing execution-setting row, named by provider, model and effort; " +
        "change takes only those two fields, and the human may amend them when approving. A change that would give the model a second row in one tier, or the same effort twice, is refused. op promote makes work tasks run on the " +
        "learner's recommendation and is only accepted while the learner is not promoted; op demote returns them to the table and " +
        "is only accepted while it is promoted; neither takes row, change, or an amendment. op agent_tier lowers a non-built-in " +
        "agent's default tier by exactly one step (an agent with no tier runs at the board default tier): agent names it, " +
        "to is the tier one step below, and evidence lists the worker_spawned event ids of that agent's sessions your case rests " +
        "on; it is refused when the execution-setting table has no runnable row (one not under a row quarantine) at the target tier for any of the agent's providers. The " +
        "human may amend to with any lower tier when approving, and approval commits the new tier to the registry. op tier_description rewrites " +
        "the description of one of the board's tiers (tier) to description, one line: a tier's description defines it for everyone who requests it, " +
        "so propose it when requests for that tier across workspaces or writers show its definition is off. evidence lists the worker_spawned event ids " +
        "of sessions whose tier source is task on tasks that requested that tier (list_allocations, tier source task); the human may amend the " +
        "description when approving. op add_tier adds a tier named tier, with description as its one-line description, to the board's list at " +
        "position (an index into the list, lowest first; 0 puts it at the bottom) and moves the row named by provider, model and effort into " +
        "it, both at once; evidence lists the worker_spawned event ids your case rests on, and the human may amend the tier's name, " +
        "description and position when approving. rationale is your evidence summary " +
        "(episode count, tier source, period) and is shown with the diff. The board applies the answer itself, so you can complete " +
        "this task without waiting for it. Returns the question id. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        op: z.enum(["row", "promote", "demote", "agent_tier", "tier_description", "add_tier"]),
        row: z.object({ provider: z.string(), model: z.string(), effort: z.string() }).optional().describe("op row and add_tier only."),
        change: z.record(z.string(), z.unknown()).optional().describe("op row only: tier and/or effort, nothing else."),
        agent: z.string().optional().describe("op agent_tier only: the agent whose default tier to lower."),
        to: z.string().optional().describe("op agent_tier only: the tier one step below the agent's current tier."),
        evidence: z
          .array(z.number().int())
          .optional()
          .describe("op agent_tier, tier_description and add_tier only: worker_spawned event ids of the sessions your case rests on."),
        tier: z.string().optional().describe("op tier_description: the tier whose description to rewrite. op add_tier: the new tier's name."),
        description: z.string().optional().describe("op tier_description and add_tier only: the tier's description, one line."),
        position: z.number().int().nonnegative().optional().describe("op add_tier only: where the new tier goes, an index into the board's list (lowest first)."),
        rationale: z.string().min(1),
      },
    },
    async (input) => run((reader, now) => proposeRoutingChange(deps.db, reader.taskId, input, reader.agent, now, deps.agentAdmin?.list)),
  );
}

/** 主題 memory の専用 verb(issue #619)。 */
function registerMemoryMetaReviewVerbs(server: McpServer, deps: McpDeps, run: MetaReviewRun): void {
  const author = (reader: { agent: string }) => ({ activity: "meta_review" as const, name: reader.agent });
  const scope = z.string().min(1).nullable().describe("A registry workspace name, or null for the whole board.");

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
    "read_memory_entries",
    {
      description:
        "Read memory entries by id, across every scope, addressee and state: the row list_memory_entries returns, plus case for a Behavior " +
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

  server.registerTool(
    "list_memory_branches",
    { description: MEMORY_BRANCHES_DESCRIPTION },
    async () => run((reader, now) => pullMemoryBranches(deps.db, reader, now)),
  );

  server.registerTool(
    "list_memory_proposals",
    {
      description:
        "List every past memory proposal (approve, consolidate, invalidate) with the human's answer, amendment and comment, or " +
        "why the board settled it as observed (an entry it pinned was invalidated first). A rejected or deferred proposal always carries the " +
        "human's reason or what is still undecided in comment — read it so you re-propose a rejected one only when that reason no longer holds, and can redraft closer to what they want. " +
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
      inputSchema: { query: z.string().min(1).optional(), like: z.number().int().optional(), next },
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
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: { scope, path: z.string(), definition: z.string(), supersedes: z.array(z.number().int()).min(1).optional() },
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
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        replaces: z.array(z.number().int()),
        successor_id: z.number().int().optional(),
        scope: scope.optional(),
        path: z.string().optional(),
        title: z.string().min(1).optional(),
        text: z.string().min(1).optional(),
        based_on_decision: z.number().int().optional(),
      },
    },
    async (input) =>
      run((reader, now) => foldMemory(deps.db, reader.taskId, { ...input, scope: input.scope && registeredScope(deps, input.scope), author: author(reader) }, "worker", now)),
  );

  server.registerTool(
    "move_memory",
    {
      description:
        "Move one entry to another path in its scope, or widen it to the whole board: the board copies it — title, text, " +
        "source, author, state and approval included — into a new entry and invalidates the old one as path_moved. Any kind, " +
        "approved or candidate. scope is the entry's own scope or null (whole-board). Refused: narrowing to a workspace or " +
        "moving between workspaces; changing the scope of an approved Behavior or Exemplar, or of an entry an open proposal " +
        "question names; changing a Definition's path (use move_memory_branch).",
      inputSchema: { entry_id: z.number().int(), scope, path: z.string() },
    },
    async (input) =>
      run((reader, now) => moveMemoryByMetaReview(deps.db, { ...input, scope: registeredScope(deps, input.scope), mover: author(reader) }, "worker", now)),
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
        "already there (superseded — the destination's wording stays; revise it in place with define_memory before or " +
        "after) and everything else moves. merge: true is refused when no such pair exists. Returns moved and folded (how " +
        "many entries were moved and how many Definitions were folded) with to_scope and to_path.",
      inputSchema: { scope, path: z.string(), to_scope: scope, to_path: z.string(), merge: z.boolean().optional() },
    },
    // 照合は行き先の scope だけ —— 移動元は行を引くだけ(人間の面の枝ごとの移動と同じ、ADR 0173 決定2)
    async (input) =>
      run((reader, now) => {
        const { moved, folded } = moveMemoryBranchByMetaReview(deps.db, { ...input, to_scope: registeredScope(deps, input.to_scope), mover: author(reader) }, "worker", now);
        return { moved: moved.length, folded: folded.length, to_scope: input.to_scope, to_path: input.to_path };
      }),
  );

  server.registerTool(
    "invalidate_memory",
    {
      description:
        "Drop a candidate (Behavior or Exemplar), Knowledge entry, or Definition with no successor. reason is " +
        "capability / environment / requirement_change, or rejected — only for a candidate that will become neither a Behavior nor an Exemplar. " +
        "To replace an entry, use fold_memory, define_memory's supersedes, move_memory or move_memory_branch. " +
        "An approved Behavior or Exemplar cannot be invalidated here — propose it instead.",
      inputSchema: metaReviewInvalidationSchema.extend({ entry_id: z.number().int() }),
    },
    async (input) => run((reader, now) => ({ event_id: invalidateMemoryByMetaReview(deps.db, input, reader.agent, "worker", now) })),
  );

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
        "replaces you now judge right. With text, based_on_decision is the event id log_decision returned for your reasoning; the new " +
        "candidate keeps the source the replaced entries share, and takes based_on_decision as its source when they share none. With " +
        "text.kind exemplar it is an Exemplar: give annotations instead of text.text; the replaced entries must share a source that " +
        "renders a case; an Exemplar candidate_id likewise needs replaces that share its source. op invalidate asks to drop the " +
        "approved Behavior or Exemplar target_id, with no successor, for reason capability / environment / requirement_change. rationale is why you propose it (the question's context). " +
        PROMOTION_RULE +
        " " +
        "The board applies the answer itself, so you can complete this task without waiting for it. Returns the question id. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        op: z.enum(["approve", "consolidate", "invalidate"]),
        candidate_id: z.number().int().optional(),
        text: z
          .object({
            scope,
            path: z.string(),
            title: z.string().min(1),
            text: z.string().min(1).optional(),
            addressee: z.string().min(1).nullable(),
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
        rationale: z.string().min(1),
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

export function createMcpRouter(deps: McpDeps): Router {
  return createStatelessMcpRouter((req) => {
    const taskParam = typeof req.query.task === "string" ? req.query.task : null;
    return buildMcpServer(deps, taskParam);
  });
}
