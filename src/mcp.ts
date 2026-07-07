import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Router } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { Slot } from "./slot.js";
import { completeTask, DomainError, getTask, HANDOFF_FIELDS, HUMAN_WORKER_ID } from "./tasks.js";

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

/** Domain verbs only, no generic CRUD (ADR 0002). Attribution comes from the
 *  spawn-time ?task= URL param and must match the current slot task. */
function buildMcpServer(deps: McpDeps, attributedTaskId: string | null): McpServer {
  const server = new McpServer({ name: "tidepool", version: "0.0.0" });

  server.registerTool(
    "get_current_task",
    { description: "Fetch the context of the task occupying the slot." },
    async () => {
      if (attributedTaskId === null || attributedTaskId !== deps.slot.currentTaskId) {
        return toolError("call is not attributed to the current slot task");
      }
      const task = getTask(deps.db, attributedTaskId);
      if (!task) return toolError("current task not found");
      const parent = task.parent_id ? (getTask(deps.db, task.parent_id) ?? null) : null;
      return toolResult({
        id: task.id,
        type: task.type,
        title: task.title,
        purpose: task.purpose,
        completion_criteria: task.completion_criteria,
        parent: parent && {
          id: parent.id,
          title: parent.title,
          purpose: parent.purpose,
          completion_criteria: parent.completion_criteria,
        },
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
      if (attributedTaskId === null || attributedTaskId !== deps.slot.currentTaskId) {
        return toolError("call is not attributed to the current slot task");
      }
      const task = getTask(deps.db, attributedTaskId);
      if (!task) return toolError("current task not found");
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
