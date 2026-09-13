import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import { type AllocationClient, reviewAllocation } from "./allocation-review.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { PRIORITY_FIELD_DESCRIPTION, TIER_FIELD_DESCRIPTION } from "./execution-setting.js";
import type { GitHubClient } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import { assertReviewerKnown } from "./human-verbs.js";
import type { Landing } from "./landing.js";
import type { AuthorityProfile, RosterAgent } from "./registry.js";
import type { Slot } from "./slot.js";
import { createStatelessMcpRouter } from "./stateless-mcp.js";
import {
  assigneeNeedsApproval,
  completeTask,
  contentSourceFor,
  DEFAULT_AUDITOR_NAME,
  DomainError,
  decomposeTask,
  escalateTask,
  getTask,
  HANDOFF_FIELDS,
  HUMAN_ROSTER_AGENT,
  HUMAN_WORKER_ID,
  logDecision,
  resolveTaskAgent,
  type Task,
  taskHistory,
} from "./tasks.js";
import { markTeardown, runTeardown, type TeardownDeps, teardownStep } from "./teardown.js";
import type { WorkerContainers } from "./worker-container.js";
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
  containers?: WorkerContainers;
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

/** The reviewer profile (ADR 0013 / issue #15 layer 2): read-only is a
 *  property of the `review` task type, not of whoever executes it, so this
 *  code constant overrides whatever authority profile the executing agent
 *  would otherwise carry — the one place in the authority model where task
 *  type overrides profile. A code constant, not a registry entry, so the
 *  enforcement floor itself sits outside what Condensation's registry-edit
 *  loop could ever propose a diff against. `allowed_workspaces: []` blocks
 *  every explicit workspace target; `assignable_to: []` blocks every
 *  explicit assignee except the one structural exception decomposeTask
 *  carves out for a review's own repair children (the reviewed task's own
 *  assignee — ADR 0013). The same "task type overrides profile" line reaches
 *  both spawn layers: ADR 0056's system-prompt assembly imports this exact
 *  profile for `## Authority`, while the CLI harness's `reviewToolDenials`
 *  (claude-worker.ts) reads `task.type` directly because the deny needs to
 *  exist before spawn resolves an authority profile — same task-type-not-agent
 *  principle, adapter-side enforcement primitive (ADR 0005). */
export const REVIEWER_AUTHORITY_PROFILE: AuthorityProfile = {
  name: "reviewer",
  guidance:
    "You are reviewing read-only. Never fix directly — findings become repair tasks.\n" +
    "Assign a repair to the worker in your roster: they executed the task you are reviewing.",
  assignable_to: [],
  allowed_workspaces: [],
};

/** The authority governing this task: a `review` task always runs under the
 *  fixed reviewer profile above (ADR 0013), regardless of who it's assigned
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

/** Domain verbs only, no generic CRUD (ADR 0002). Attribution comes from the
 *  spawn-time ?task= URL param and must match the current slot task. */
function buildMcpServer(deps: McpDeps, attributedTaskId: string | null): McpServer {
  const server = new McpServer({ name: "tidepool", version: "0.0.0" });

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
          // 配分評価(ADR 0111 決定4): 完了の transaction が commit した後、Board call
          // は response の外で走る。失敗は注釈の理由コードに畳まれ(reviewAllocation)、
          // それでも漏れた例外は完了を倒さず process も倒さない
          if (deps.allocationClient && done.type === "review") {
            void reviewAllocation(deps.db, deps.allocationClient, done, now).catch((err) =>
              console.error(`[allocation-review] ${done.id}: ${String(err)}`),
            );
          }
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
        children: z.array(
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
        ),
      },
    },
    async (input) =>
      runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        // an explicitly named child workspace must exist in the registry
        // (issue #26) — this is the registering agent's own mistake, not an
        // authority question, so it's rejected outright before anything
        // registers rather than converted into an approval question (ADR
        // 0009). Absent a real registry, every name is accepted, same as
        // execution-time resolution's fallback.
        const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
        if (resolve) {
          for (const child of input.children) {
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
        for (const child of input.children) {
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

  return server;
}

export function createMcpRouter(deps: McpDeps): Router {
  return createStatelessMcpRouter((req) => {
    const taskParam = typeof req.query.task === "string" ? req.query.task : null;
    return buildMcpServer(deps, taskParam);
  });
}
