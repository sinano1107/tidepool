import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Router } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { GitHubClient } from "./github.js";
import type { Slot } from "./slot.js";
import {
  completeTask,
  decomposeTask,
  DomainError,
  escalateTask,
  getTask,
  HANDOFF_FIELDS,
  HUMAN_WORKER_ID,
  logDecision,
  type Task,
} from "./tasks.js";
import {
  releaseWorkspace,
  taskBranch,
  workspaceNeedsHuman,
  type WorkspaceConfig,
} from "./workspace.js";

export interface McpDeps {
  db: Db;
  slot: Slot;
  clock: Clock;
  workspace?: WorkspaceConfig;
  /** The GitHub-facing seam (issue #19): a work task's completion is promoted
   *  to a PR through here. Absent → no PR is ever opened (e.g. a workspaceless
   *  board). */
  github?: GitHubClient;
}

/** The protected branch every task branch is proposed onto — the same one
 *  branch discipline (workspace.ts) forbids direct writes to. */
const PR_BASE_BRANCH = "main";

/** Work-task completion → PR (issue #19): by the time this runs, the tree
 *  rule has either stashed the work as a WIP commit on the task branch, or
 *  failed and quarantined the workspace (releaseWorkspace swallows that
 *  failure so the completion itself still stands) — in the latter case the
 *  task branch may carry none of the finished work, so no PR is attempted.
 *  Never entrusted to the worker, never lets a PR failure touch the
 *  completion that already landed — best-effort, logged and swallowed.
 *  question/review tasks carry no handoff doc and open no PR. */
async function openHandoffPr(
  deps: McpDeps,
  task: Task,
  handoffDoc: string | null,
): Promise<void> {
  if (task.type !== "work" || !deps.github || !deps.workspace) return;
  if (workspaceNeedsHuman(deps.db, deps.workspace.name)) return;
  try {
    await deps.github.createPullRequest({
      path: deps.workspace.path,
      branch: taskBranch(task.id),
      base: PR_BASE_BRANCH,
      title: task.title,
      body: handoffDoc ?? "",
    });
  } catch (err) {
    console.error(`PR creation failed for task ${task.id}:`, err);
  }
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
function runVerb(
  deps: McpDeps,
  attributedTaskId: string | null,
  verb: (task: Task) => unknown,
) {
  const resolved = resolveAttributedTask(deps, attributedTaskId);
  if ("error" in resolved) return toolError(resolved.error);
  try {
    return toolResult(verb(resolved.task));
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
    const result = verb(task, task.assignee ?? HUMAN_WORKER_ID, deps.clock.now());
    // the tree rule runs between the domain verb and the release: a domain
    // error above keeps the session (and its tree) alive, but once the verb
    // lands the WIP is stashed before anything else can enter the workspace.
    // A tree-rule failure falls back to quarantine — the verb already
    // landed, so the release stands, and needs-human halts further pickups.
    if (deps.workspace) releaseWorkspace(deps.db, deps.workspace, task.id, deps.clock.now());
    deps.slot.release();
    return result;
  });
}

function taskContext(task: Task) {
  return {
    id: task.id,
    title: task.title,
    purpose: task.purpose,
    completion_criteria: task.completion_criteria,
  };
}

/** Domain verbs only, no generic CRUD (ADR 0002). Attribution comes from the
 *  spawn-time ?task= URL param and must match the current slot task. */
function buildMcpServer(deps: McpDeps, attributedTaskId: string | null): McpServer {
  const server = new McpServer({ name: "tidepool", version: "0.0.0" });

  server.registerTool(
    "get_current_task",
    { description: "Fetch the context of the task occupying the slot." },
    async () =>
      runVerb(deps, attributedTaskId, (task) => {
        const parent = task.parent_id ? (getTask(deps.db, task.parent_id) ?? null) : null;
        return { ...taskContext(task), type: task.type, parent: parent && taskContext(parent) };
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
      if (completed) await openHandoffPr(deps, completed, completed.handoff_doc);
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
        logDecision(deps.db, task, line, task.assignee ?? HUMAN_WORKER_ID, deps.clock.now());
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
          }),
        ),
      },
    },
    async (input) =>
      runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        const children = decomposeTask(deps.db, task, input, workerId, now);
        return { child_ids: children.map((c) => c.id), parent_status: "blocked" };
      }),
  );

  server.registerTool(
    "escalate",
    {
      description:
        "Escalate a decision outside your authority (or an execution dead end): " +
        "registers a question task with 2-4 options plus your recommendation, " +
        "blocks the current task on it, and frees the slot.",
      // the schema stays permissive: option-count and recommendation invariants
      // are enforced inside the verb so callers get a domain error
      inputSchema: {
        title: z.string().min(1),
        context: z.string().min(1),
        options: z.array(z.string()),
        recommendation: z.string(),
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
