import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import { type AllocationClient, reviewAllocation } from "./allocation-review.js";
import { type AttributionClient, attributeAfterRca, type BehaviorDraftClient, isHumanEntry, latestAttribution, learningTarget } from "./attribution.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { getEvent, HUMAN_FACING_KINDS } from "./events.js";
import { PRIORITY_FIELD_DESCRIPTION, readExecutionSettings, TIER_FIELD_DESCRIPTION } from "./execution-setting.js";
import type { GitHubClient } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import { assertReviewerKnown, assertWorkspaceKnown } from "./human-verbs.js";
import type { Landing } from "./landing.js";
import {
  browseMemory,
  createBehaviorCandidate,
  defineMemoryBranch,
  foldMemory,
  invalidateMemoryByMetaReview,
  invalidationSchema,
  listPrecedents,
  memoryListFilterSchema,
  memoryScope,
  moveMemory,
  proposeMemoryChange,
  pullMemoryList,
  readMemory,
  recordKnowledge,
  searchMemory,
} from "./memory.js";
import { type MetaReviewSubject, metaReviewSubjectOf } from "./meta-review.js";
import type { ProcessContainers } from "./process-container.js";
import { type AuthorityProfile, REVIEWER_AUTHORITY_PROFILE, type RosterAgent } from "./registry.js";
import { listAllocations, listRoutingCells, listRoutingProposals, listRoutingShadow, proposeRoutingChange } from "./routing-review.js";
import type { Slot } from "./slot.js";
import { createStatelessMcpRouter } from "./stateless-mcp.js";
import {
  assigneeNeedsApproval,
  completeTask,
  contentSourceFor,
  continueDecomposition,
  DEFAULT_AUDITOR_NAME,
  DomainError,
  declarePremiseBreach,
  decomposeTask,
  escalateTask,
  getRegistrant,
  getTask,
  HANDOFF_FIELDS,
  HUMAN_ROSTER_AGENT,
  HUMAN_WORKER_ID,
  logDecision,
  redecompose,
  resolveTaskAgent,
  type Task,
  taskHistory,
} from "./tasks.js";
import { markTeardown, runTeardown, type TeardownDeps, teardownStep } from "./teardown.js";
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
   *  not to `HUMAN_WORKER_ID`. Absent → falls back to `HUMAN_WORKER_ID`, same
   *  as the pre-#36 shape for a board with no worker configured at all. */
  defaultAgentName?: string;
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
  /** The allocation review's Board call seam (ADR 0111 決定4 / issue #547),
   *  asked after an integration review completes. Absent → no annotation is
   *  written (a board with no Board call configured, same as translation). */
  allocationClient?: AllocationClient;
  /** The attribution's Board call seam (ADR 0115 決定2 / issue #575), asked
   *  once a task's last RCA child completes. Absent → `uncertain` stays. */
  attributionClient?: AttributionClient;
  /** The Behavior candidate drafting Board call seam (issue #617), asked after the
   *  second attribution round. Absent → nothing is drafted. */
  behaviorDraftClient?: BehaviorDraftClient;
}

/** Every MCP call is attributed to a real agent session (never human — that's
 *  the separate /answer route), so an unspecified (null) assignee resolves to
 *  the board's default agent, not `HUMAN_WORKER_ID` (ADR 0012 / issue #36) —
 *  made type-aware for `review` tasks (issue #42 / CONTEXT.md's Auditor): a
 *  review task's unset assignee attributes to the Auditor pointer instead,
 *  which — unlike `defaultAgentName` — always resolves to a value. */
function attributedWorkerId(deps: McpDeps, task: Task): string {
  return resolveTaskAgent(
    task,
    deps.defaultAgentName ?? HUMAN_WORKER_ID,
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

/** pull の読み口のページ番号(1 始まり)。 */
const page = z.number().int().min(1).optional();

/** decompose と redecompose が共有する。 */
function assertChildrenKnown(deps: McpDeps, children: z.infer<typeof decomposeChildrenSchema>): void {
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
    for (const reviewer of child.review_by ?? []) {
      assertReviewerKnown(deps.agentRegistered, reviewer);
    }
  }
}

/** decompose と redecompose が共有する子の入力。 */
const decomposeChildrenSchema = z.array(
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
          "No authority check applies — declaring it is never out of scope.",
      ),
    tier: z.string().optional().describe(TIER_FIELD_DESCRIPTION),
    review_by: z.array(z.string().min(1)).optional()
      .describe("Reviewer agent names; one completion review per name. Omit to use the board Auditor."),
    review_tier: z.string().optional()
      .describe("Quality tier for completion reviews; overrides each reviewer's tier, then the board default."),
    priority: z.string().optional().describe(PRIORITY_FIELD_DESCRIPTION),
  }),
);

/** Domain verbs only, no generic CRUD (ADR 0002). Attribution comes from the
 *  spawn-time ?task= URL param and must match the current slot task. */
function buildMcpServer(deps: McpDeps, attributedTaskId: string | null): McpServer {
  const server = new McpServer({ name: "tidepool", version: "0.0.0" });
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
        "watchdog failure question.",
    },
    async () =>
      runVerb(deps, attributedTaskId, async (task) => {
        const parent = task.parent_id ? (getTask(deps.db, task.parent_id) ?? null) : null;
        const parentContext = parent && {
          ...(await taskContext(deps, parent)),
          handoff_doc: parent.handoff_doc,
          history: taskHistory(deps.db, parent.id, task.id),
        };
        return {
          ...(await taskContext(deps, task)),
          type: task.type,
          parent: parentContext,
          history: taskHistory(deps.db, task.id),
        };
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
        "Complete the current task. Work tasks require the full 6-field handoff doc " +
        "and a committed work tree — commit your changes before calling this. " +
        "resume_context is what the next session needs to pick the work back up — " +
        "do not describe landing state (push / PR / merge): the board lands the " +
        "branch after you complete, and you cannot observe that. " +
        BOARD_WRITE_LANGUAGE_RULE,
      // the schema stays permissive: the handoff invariant is enforced inside
      // the verb so callers get a domain error, not a protocol error
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
          // 配分評価(ADR 0111 決定4): 完了の transaction が commit した後に始まり、
          // Board call の返答は response を待たせない(入力の読み取りと no_session /
          // throttled の注釈は response より前に同期で済む)。失敗は注釈の理由コードに
          // 畳まれ(reviewAllocation)、それでも漏れた例外は完了も process も倒さない
          if (deps.allocationClient) {
            void reviewAllocation(deps.db, deps.allocationClient, done, deps.clock).catch((err) =>
              console.error(`[allocation-review] ${done.id}: ${String(err)}`),
            );
          }
          // 帰責の第2回(ADR 0115 決定2): 同じ位置・同じ fire-and-forget。決着したのが
          // 異議されたタスクの最後の RCA 子だったときだけ中で撃つ
          void attributeAfterRca(deps.db, deps, done, now).catch((err) =>
            console.error(`[attribution] ${done.id}: ${String(err)}`),
          );
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
        children: decomposeChildrenSchema,
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
      inputSchema: { reason: z.string().min(1), children: decomposeChildrenSchema },
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
        "Review only: turn your finding about an objected entry into memory — objected entries of your parent task only. The board derives the entry kind and addressee from the entry's attributed cause, " +
        "except for a missing_information cause, where you pass as (behavior or knowledge) and must not otherwise. " +
        "A behavior is a candidate a human approves later. path is a \"/\"-separated hierarchy (e.g. build/tests). " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        entry_id: z.number().int(),
        path: z.string(),
        title: z.string().min(1),
        text: z.string().min(1),
        as: z.enum(["behavior", "knowledge"]).optional(),
      },
    },
    async ({ entry_id, as, ...fields }) =>
      runVerb(deps, attributedTaskId, (task) => {
        // 門は列を足さず構造で引く(ADR 0120 決定1(a))
        if (task.type !== "review" || task.parent_id === null) {
          throw new DomainError("propose_from_objection is only for a review of an objected task");
        }
        const entry = getEvent(deps.db, entry_id);
        if (entry?.task_id !== task.parent_id || !(HUMAN_FACING_KINDS as readonly string[]).includes(entry.kind)) {
          throw new DomainError(`entry ${entry_id} is not a decision-log entry of your parent task`);
        }
        const attribution = latestAttribution(deps.db, { id: entry_id, task_id: task.parent_id });
        if (!attribution) throw new DomainError(`entry ${entry_id} carries no attributed objection`);
        if (isHumanEntry(entry)) throw new DomainError(`entry ${entry_id} was written by a human`);
        const target = learningTarget(attribution.cause, entry.worker_id, getRegistrant(deps.db, entry.task_id), as);
        const input = {
          ...fields,
          scope: memoryScope(deps, getTask(deps.db, task.parent_id)!),
          source: { event_id: attribution.id },
          author: { activity: "rca" as const, name: attributedWorkerId(deps, task) },
        };
        return target.kind === "knowledge"
          ? recordKnowledge(deps.db, input, "worker", deps.clock.now())
          : createBehaviorCandidate(deps.db, { ...input, addressee: target.addressee }, "worker", deps.clock.now());
      }),
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
        "path. Omit prefix for the top level. Read an entry's text with read_memory.",
      inputSchema: { prefix: z.string().optional(), page },
    },
    async (input) => runVerb(deps, attributedTaskId, (task) => browseMemory(deps.db, reader(task), input, deps.clock.now())),
  );

  server.registerTool(
    "search_memory",
    {
      description:
        "Search the board's memory for this workspace by full-text query; results are " +
        "{id, title, path} in rank order, and truncated says a next page exists. Read an " +
        "entry's text with read_memory.",
      inputSchema: { query: z.string().min(1), page },
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
        "Ids you cannot see are omitted.",
      inputSchema: { ids: z.array(z.number().int()).min(1) },
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
        "Defaults to objections since the previous meta-review of your subject; pass since_watermark (an event id) to look further back.",
      inputSchema: { since_watermark: z.number().int().min(0).optional(), page },
    },
    async (input) => run((reader, now) => listPrecedents(deps.db, reader, input, now)),
  );

  if (subject === "memory") registerMemoryMetaReviewVerbs(server, deps, run);
  else registerRoutingMetaReviewVerbs(server, deps, run);
}

/** 主題 routing の読み口(issue #917 / spec #916 C)。集計はドメイン層(routing-review.ts)。 */
function registerRoutingMetaReviewVerbs(server: McpServer, deps: McpDeps, run: MetaReviewRun): void {
  const since_watermark = z.number().int().min(0).optional().describe("An event id; defaults to the previous routing meta-review's registration.");

  server.registerTool(
    "list_routing_shadow",
    {
      description:
        "List the learner's shadow rows: for each work pickup, the cell the learner recommended, the cell that actually ran " +
        "and the selector's source, with that session's agent and outcome (accepted / rejected / excluded, cost, duration). " +
        "diverged marks rows where the two cells differ; diverged_only returns only those. When source.provider is learner, the " +
        "learner was promoted and chose what ran, and recommended is what the table would have chosen instead.",
      inputSchema: { since_watermark, diverged_only: z.boolean().optional(), page },
    },
    async (input) => run((reader) => listRoutingShadow(deps.db, reader.taskId, input)),
  );

  server.registerTool(
    "list_allocations",
    {
      description:
        "List the allocation-review distribution: evaluated annotations counted by the session's tier source, agent, " +
        "allocation and cause, with judged_by_same_model counting those whose judge ran on the worker's own model. " +
        "Unevaluated annotations are not counted.",
      inputSchema: { since_watermark, page },
    },
    async (input) => run((reader) => listAllocations(deps.db, reader.taskId, input)),
  );

  server.registerTool(
    "list_routing_cells",
    {
      description:
        "List cells (provider, model, effort, advisor) first observed in a finished session since the watermark, and the " +
        "execution-setting table rows humans wrote since then. Only cells are paged; the rows always come back in full.",
      inputSchema: { since_watermark, page },
    },
    async (input) => run((reader) => listRoutingCells(deps.db, reader.taskId, input)),
  );

  server.registerTool(
    "read_routing_settings",
    {
      description:
        "Read the current execution-setting table, the frontier advisor setting, the provider rank, the default priority and " +
        "whether the learner is promoted, and every past routing proposal with its answer, the human's amendment and comment, or " +
        "why the board settled it as observed (the pinned row or learner flag changed, or the row was deleted).",
    },
    async () => run(() => ({ ...readExecutionSettings(deps.db), proposals: listRoutingProposals(deps.db) })),
  );

  server.registerTool(
    "propose_routing_change",
    {
      description:
        "Propose a routing change to the human as one approve / reject question attached to this task. op row replaces the " +
        "tier (economy / standard / frontier) and/or effort of one existing execution-setting row, named by provider and model; " +
        "change takes only those two fields, and the human may amend them when approving. op promote makes work tasks run on the " +
        "learner's recommendation and is only accepted while the learner is not promoted; op demote returns them to the table and " +
        "is only accepted while it is promoted; neither takes row, change, or an amendment. rationale is your evidence summary " +
        "(episode count, tier source, period) and is shown with the diff. The board applies the answer itself, so you can complete " +
        "this task without waiting for it. Returns the question id. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        op: z.enum(["row", "promote", "demote"]),
        row: z.object({ provider: z.string(), model: z.string() }).optional().describe("op row only."),
        change: z.record(z.string(), z.unknown()).optional().describe("op row only: tier and/or effort, nothing else."),
        rationale: z.string().min(1),
      },
    },
    async (input) => run((reader, now) => proposeRoutingChange(deps.db, reader.taskId, input, reader.agent, now)),
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
        "candidates with their invalidation reason and successor — read them so you do not re-propose what was rejected.",
      inputSchema: { include_invalidated: z.boolean().optional(), page },
    },
    async (input) => run((reader, now) => pullMemoryList(deps.db, reader, "list_memory_candidates", input, now)),
  );

  server.registerTool(
    "list_memory_behaviors",
    {
      description: "List every approved Behavior on the board, across all addressees and scopes.",
      inputSchema: { page },
    },
    async (input) => run((reader, now) => pullMemoryList(deps.db, reader, "list_memory_behaviors", input, now)),
  );

  server.registerTool(
    "list_memory_entries",
    {
      description:
        "List memory entries as the human settings view does — candidates, invalidated entries, and board-wide " +
        "definitions shadowed by a workspace one included. scope: a workspace name, null for board-wide only, omit for all.",
      inputSchema: {
        scope: scope.optional(),
        kind: memoryListFilterSchema.shape.kind,
        state: memoryListFilterSchema.shape.state,
        page,
      },
    },
    async (input) => run((reader, now) => pullMemoryList(deps.db, reader, "list_memory_entries", input, now)),
  );

  server.registerTool(
    "define_memory",
    {
      description:
        "Draft or revise a branch definition in the given scope: one line declaring what is filed under the path. " +
        "A branch has one definition per scope; revise it with supersedes, which may point at a definition in another scope. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: { scope, path: z.string(), definition: z.string(), supersedes: z.number().int().optional() },
    },
    async (input) =>
      run((reader, now) =>
        defineMemoryBranch(
          deps.db,
          { scope: registeredScope(deps, input.scope), path: input.path, text: input.definition, supersedes: input.supersedes, author: author(reader) },
          "worker",
          now,
        ),
      ),
  );

  server.registerTool(
    "fold_memory",
    {
      description:
        "Fold approved Knowledge entries into one new Knowledge entry in the given scope: every entry in replaces is " +
        "invalidated as superseded by the new one. based_on_decision is the event id log_decision returned for your " +
        "reasoning; it becomes the source (an inference). " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        scope,
        path: z.string(),
        title: z.string().min(1),
        text: z.string().min(1),
        replaces: z.array(z.number().int()),
        based_on_decision: z.number().int(),
      },
    },
    async (input) =>
      run((reader, now) => foldMemory(deps.db, { ...input, scope: registeredScope(deps, input.scope), author: author(reader) }, "worker", now)),
  );

  server.registerTool(
    "move_memory",
    {
      description:
        "Move a Knowledge entry to another scope and path: the board copies its title, text, and source into a new " +
        "entry and invalidates the old one as path_moved. Definitions and Behaviors cannot be moved.",
      inputSchema: { entry_id: z.number().int(), scope, path: z.string() },
    },
    async (input) =>
      run((reader, now) => moveMemory(deps.db, { ...input, scope: registeredScope(deps, input.scope), author: author(reader) }, "worker", now)),
  );

  server.registerTool(
    "invalidate_memory",
    {
      description:
        "Invalidate a candidate, Knowledge entry, or Definition. reason is superseded (with successor_id) or " +
        "capability / environment / requirement_change. An approved Behavior cannot be invalidated here — propose it instead.",
      inputSchema: { entry_id: z.number().int(), ...invalidationSchema.shape },
    },
    async (input) => run((reader, now) => ({ event_id: invalidateMemoryByMetaReview(deps.db, input, reader.agent, "worker", now) })),
  );

  server.registerTool(
    "propose_memory_change",
    {
      description:
        "Propose a Behavior change to the human as one approve / reject question attached to this task. op approve asks to " +
        "approve a Behavior candidate exactly as worded (candidate_id). op consolidate drafts text as a new Behavior candidate " +
        "that replaces the Behavior candidates and approved Behaviors in replaces; based_on_decision is the event id " +
        "log_decision returned for your reasoning and becomes its source. op invalidate asks to invalidate the approved Behavior " +
        "target_id for reason capability / environment / requirement_change. rationale is why you propose it (the question's context). " +
        "The board applies the answer itself, so you can complete this task without waiting for it. Returns the question id. " +
        BOARD_WRITE_LANGUAGE_RULE,
      inputSchema: {
        op: z.enum(["approve", "consolidate", "invalidate"]),
        candidate_id: z.number().int().optional(),
        text: z
          .object({ scope, path: z.string(), title: z.string().min(1), text: z.string().min(1), addressee: z.string().min(1).nullable() })
          .optional()
          .describe("op consolidate: the new Behavior. addressee is an agent name, or null for every agent."),
        replaces: z.array(z.number().int()).optional(),
        based_on_decision: z.number().int().optional(),
        target_id: z.number().int().optional(),
        reason: invalidationSchema.shape.reason.exclude(["superseded", "path_moved"]).optional(),
        rationale: z.string().min(1),
      },
    },
    async (input) =>
      run((reader, now) =>
        proposeMemoryChange(
          deps.db,
          reader.taskId,
          { ...input, text: input.text && { ...input.text, scope: registeredScope(deps, input.text.scope) } },
          reader.agent,
          now,
        ),
      ),
  );
}

export function createMcpRouter(deps: McpDeps): Router {
  return createStatelessMcpRouter((req) => {
    const taskParam = typeof req.query.task === "string" ? req.query.task : null;
    return buildMcpServer(deps, taskParam);
  });
}
