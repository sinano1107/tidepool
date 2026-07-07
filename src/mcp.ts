import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Router } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
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

export interface McpDeps {
  db: Db;
  slot: Slot;
  clock: Clock;
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
    async ({ handoff }) =>
      runReleasingVerb(deps, attributedTaskId, (task, workerId, now) => {
        const done = completeTask(deps.db, task, handoff, workerId, now);
        return { id: done.id, status: done.status };
      }),
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
