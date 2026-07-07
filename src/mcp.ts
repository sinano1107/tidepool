import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Router } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { Slot } from "./slot.js";
import {
  completeTask,
  DomainError,
  escalateTask,
  getTask,
  HANDOFF_FIELDS,
  HUMAN_WORKER_ID,
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
    async () => {
      const resolved = resolveAttributedTask(deps, attributedTaskId);
      if ("error" in resolved) return toolError(resolved.error);
      const { task } = resolved;
      const parent = task.parent_id ? (getTask(deps.db, task.parent_id) ?? null) : null;
      return toolResult({
        ...taskContext(task),
        type: task.type,
        parent: parent && taskContext(parent),
      });
    },
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
      const resolved = resolveAttributedTask(deps, attributedTaskId);
      if ("error" in resolved) return toolError(resolved.error);
      const { task } = resolved;
      try {
        const done = completeTask(
          deps.db,
          task,
          handoff,
          task.assignee ?? HUMAN_WORKER_ID,
          deps.clock.now(),
        );
        deps.slot.release();
        return toolResult({ id: done.id, status: done.status });
      } catch (err) {
        if (err instanceof DomainError) return toolError(err.message);
        throw err;
      }
    },
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
    async (input) => {
      const resolved = resolveAttributedTask(deps, attributedTaskId);
      if ("error" in resolved) return toolError(resolved.error);
      const { task } = resolved;
      try {
        const question = escalateTask(
          deps.db,
          task,
          input,
          task.assignee ?? HUMAN_WORKER_ID,
          deps.clock.now(),
        );
        deps.slot.release();
        return toolResult({ question_id: question.id, parent_status: "blocked" });
      } catch (err) {
        if (err instanceof DomainError) return toolError(err.message);
        throw err;
      }
    },
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
