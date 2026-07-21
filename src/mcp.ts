import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Router } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { taskDecisionLog } from "./events.js";
import type { GitHubClient } from "./github.js";
import type { AuthorityProfile, RosterAgent } from "./registry.js";
import type { Slot } from "./slot.js";
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
  recordPrOpened,
  registerPrPromotionFailureQuestion,
  settledChildren,
  type Task,
} from "./tasks.js";
import {
  buildWorkspaceResolver,
  protectedBranch,
  releaseWorkspace,
  resolveOrQuarantine,
  taskBranch,
  UnknownWorkspaceError,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "./workspace.js";

export interface McpDeps {
  db: Db;
  slot: Slot;
  clock: Clock;
  workspace?: WorkspaceConfig;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009), read fresh every call. Absent → every task releases against
   *  the board's single fixed `workspace` (pre-#26 behavior). */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** The GitHub-facing seam (issue #19): a work task's completion is promoted
   *  to a PR through here. Absent → no PR is ever opened (e.g. a workspaceless
   *  board). */
  github?: GitHubClient;
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
}

/** 完了の逆方向は GitHub ネイティブに委ねる(issue #49, ADR 0016) — issue-backed
 *  task の PR body に `Closes #N` を追記し、merge が issue を閉じる。PR を伴わない
 *  完了と cancel はこの経路自体を通らないので issue に触れない。 */
function prBody(handoffDoc: string | null, githubIssueNumber: number | null): string {
  const doc = handoffDoc ?? "";
  if (githubIssueNumber == null) return doc;
  const closes = `Closes #${githubIssueNumber}`;
  return doc ? `${doc}\n\n${closes}` : closes;
}

/** Work-task completion → PR (issue #19): by the time this runs, the tree
 *  rule has either stashed the work as a WIP commit on the task branch, or
 *  failed and quarantined the workspace (releaseWorkspace swallows that
 *  failure so the completion itself still stands) — in the latter case the
 *  task branch may carry none of the finished work, so no PR is attempted.
 *  Never entrusted to the worker, never lets a PR failure touch the
 *  completion that already landed — a real creation failure becomes a
 *  Tidepool failure question, while pre-existing quarantine still skips PR
 *  promotion as it did before.
 *  question/review tasks carry no handoff doc and open no PR.
 *  strict=true is the answer route's synchronous retry (issue #66): every
 *  precondition that the first attempt silently skips on becomes a thrown
 *  error the human sees. */
export async function promoteHandoffPr(
  deps: McpDeps,
  task: Task,
  strict = true,
): Promise<void> {
  if (task.type !== "work" || !deps.github) {
    if (strict) throw new Error("GitHub is not configured for PR promotion");
    return;
  }
  // resolved against the task's own execution workspace (issue #26 / ADR
  // 0009), never just the board's default, through the same fail-closed
  // seam every other async board-driven use of a task's workspace goes
  // through — an unresolvable name (registry drift) re-quarantines (a no-op
  // if the task's slot release already did moments earlier) and skips the PR
  const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
  if (!resolve) {
    if (strict) throw new Error("no workspace is configured for PR promotion");
    return;
  }
  const workspace = resolveOrQuarantine(deps.db, resolve, task.workspace, deps.clock.now());
  if (!workspace) {
    if (strict) throw new Error("workspace is unavailable for PR promotion");
    return;
  }
  if (workspaceNeedsHuman(deps.db, workspace.name)) {
    if (strict) {
      throw new Error(`workspace "${workspace.name}" needs human attention before PR promotion`);
    }
    return;
  }
  // an issue-backed task's stored title is only the "#N" placeholder
  // (rowToTask) — the PR title is another of ADR 0016's real use-moments,
  // so it resolves the live issue instead when there is one.
  const { title } = await contentSourceFor(task, deps.github, () => workspace.path).expand();
  const pr = await deps.github.createPullRequest({
    path: workspace.path,
    branch: taskBranch(task.id),
    base: protectedBranch(workspace),
    title,
    body: prBody(task.handoff_doc, task.github_issue_number),
  });
  recordPrOpened(
    deps.db,
    task,
    pr.number,
    attributedWorkerId(deps, task),
    deps.clock.now(),
    attributedAuthority(deps, task),
    deps.isProtectedWorkspace?.(workspace.name),
  );
}

async function openHandoffPr(deps: McpDeps, task: Task): Promise<void> {
  if (task.type !== "work" || !deps.github) return;
  try {
    await promoteHandoffPr(deps, task, false);
  } catch (err) {
    registerPrPromotionFailureQuestion(
      deps.db,
      task,
      err instanceof Error ? err.message : String(err),
      deps.clock.now(),
    );
  }
}

/** Every MCP call is attributed to a real agent session (never human — that's
 *  the separate /answer route), so an unspecified (null) assignee resolves to
 *  the board's default agent, not `HUMAN_WORKER_ID` (ADR 0012 / issue #36) —
 *  made type-aware for `review` tasks (issue #42 / CONTEXT.md's Auditor): a
 *  review task's unset assignee attributes to the Auditor pointer instead,
 *  which — unlike `defaultAgentName` — always resolves to a value. */
function attributedWorkerId(deps: McpDeps, task: Task): string {
  if (task.assignee) return task.assignee;
  if (task.type === "review") return deps.auditorName ?? DEFAULT_AUDITOR_NAME;
  return deps.defaultAgentName ?? HUMAN_WORKER_ID;
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
 *  assignee — ADR 0013). The ADR 0013 addendum (issue #59) carries the same
 *  "task type overrides profile" line one layer down, at the CLI harness
 *  itself: `reviewToolDenials` (claude-worker.ts) reads `task.type` directly
 *  rather than this profile object, since the deny needs to exist before
 *  spawn ever resolves an authority profile — same task-type-not-agent
 *  principle, adapter-side enforcement primitive (ADR 0005). */
const REVIEWER_AUTHORITY_PROFILE: AuthorityProfile = {
  name: "reviewer",
  guidance: "You are reviewing read-only. Never fix directly — findings become repair tasks.",
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

function toolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(message: string) {
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

/** Verbs that end the slot session (complete, decompose, escalate): run the
 *  domain verb attributed to the slot worker, then free the slot. A domain
 *  error keeps the slot — the session continues. */
function runReleasingVerb(
  deps: McpDeps,
  attributedTaskId: string | null,
  verb: (task: Task, workerId: string, now: Date) => unknown,
) {
  return runVerb(deps, attributedTaskId, (task) => {
    const result = verb(task, attributedWorkerId(deps, task), deps.clock.now());
    // the tree rule runs between the domain verb and the release: a domain
    // error above keeps the session (and its tree) alive, but once the verb
    // lands the WIP is stashed before anything else can enter the workspace.
    // A tree-rule failure falls back to quarantine — the verb already
    // landed, so the release stands, and needs-human halts further pickups.
    // Resolved against the task's own execution workspace (issue #26 / ADR
    // 0009), never just the board's default.
    const resolve = buildWorkspaceResolver(deps.resolveWorkspace, deps.workspace);
    if (resolve) {
      const resolved = resolveOrQuarantine(deps.db, resolve, task.workspace, deps.clock.now());
      if (resolved) releaseWorkspace(deps.db, resolved, task.id, deps.clock.now());
    }
    deps.slot.release();
    return result;
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
    { description: "Fetch the context of the task occupying the slot." },
    async () =>
      runVerb(deps, attributedTaskId, async (task) => {
        const parent = task.parent_id ? (getTask(deps.db, task.parent_id) ?? null) : null;
        // a review task reads its parent (the reviewed task) in the reverse
        // direction from every other seam here (issue #29's review-context
        // addendum): the parent's own decision log and handoff doc, verbatim
        // — the primary resource layer 2's RCA needs ("自分は何をどの順で
        // 判断したか" has no other source than the reviewed session's own
        // record).
        const parentContext = parent && {
          ...(await taskContext(deps, parent)),
          ...(task.type === "review" && {
            decision_log: taskDecisionLog(deps.db, parent.id),
            handoff_doc: parent.handoff_doc,
          }),
        };
        return {
          ...(await taskContext(deps, task)),
          type: task.type,
          parent: parentContext,
          children: settledChildren(deps.db, task.id),
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
        "Complete the current task. Work tasks require the full 6-field handoff doc.",
      // the schema stays permissive: the handoff invariant is enforced inside
      // the verb so callers get a domain error, not a protocol error
      inputSchema: {
        handoff: z
          .partialRecord(z.enum(HANDOFF_FIELDS), z.string())
          .optional(),
      },
    },
    async ({ handoff }) => {
      let completed: Task | undefined;
      const result = runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        const done = completeTask(deps.db, task, handoff, workerId, now);
        completed = done;
        return { id: done.id, status: done.status };
      });
      if (completed) await openHandoffPr(deps, completed);
      return result;
    },
  );

  server.registerTool(
    "log_decision",
    {
      description:
        "Record an in-authority decision as one log line and keep working. " +
        "The line lands in the human-skimmed decision log.",
      inputSchema: { line: z.string().min(1) },
    },
    async ({ line }) =>
      runVerb(deps, attributedTaskId, (task) => {
        logDecision(deps.db, task, line, attributedWorkerId(deps, task), deps.clock.now());
        return { logged: true };
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
        "integrate and complete for real.",
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
        // even runs. `human` is exempt (never a registry agent).
        if (deps.agentRegistered) {
          for (const child of input.children) {
            if (child.assignee === undefined || child.assignee === HUMAN_WORKER_ID) continue;
            if (!deps.agentRegistered(child.assignee)) {
              throw new DomainError(`unknown agent: ${child.assignee}`);
            }
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
        "frees the slot. A human answers every item in one atomic submission.",
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
        const question = escalateTask(deps.db, task, input, workerId, now);
        return { question_id: question.id, parent_status: "blocked" };
      }),
  );

  return server;
}

export function createMcpRouter(deps: McpDeps): Router {
  const router = Router();
  router.use(express.json());

  router.post("/", async (req, res) => {
    const taskParam = typeof req.query.task === "string" ? req.query.task : null;
    const server = buildMcpServer(deps, taskParam);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}
