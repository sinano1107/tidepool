import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import { openContainmentQuestion } from "./containment.js";
import type { Db } from "./db.js";
import { getLogCursor, listEvents, listLog } from "./events.js";
import { toolError, toolResult } from "./mcp.js";
import { isPaused } from "./pause.js";
import { createStatelessMcpRouter } from "./stateless-mcp.js";
import { getTask, listBoard, listQueue, listYourTasks } from "./tasks.js";
import { isFablePickupBlocked, isPickupBlocked } from "./throttle.js";
import type { WorkspaceConfig } from "./workspace.js";

export interface ManagementMcpDeps {
  db: Db;
  clock: Clock;
  workspace?: WorkspaceConfig;
  defaultAgentName?: string;
  auditorName?: string;
  fableAgents?: () => string[];
}

export const MANAGEMENT_MCP_INSTRUCTIONS = `Tidepool is a personal task board that dispatches work to autonomous AI
workers. Humans register tasks (work or review, optionally backed by a GitHub
issue); the board queues them, spawns a worker per task, and records every
decision workers make in an append-only decision log. When a worker is
uncertain, it escalates by raising a question task, which only a human may
answer. A git-versioned registry defines agents (worker definitions),
authority profiles (what an agent may do), and workspaces (the repositories
workers operate on).

You are connected to the Management MCP: a human-facing control surface equal
in rank to the WebUI. You operate it as an extension of the human you are in
conversation with (prosthetic-hand model). Every operation you perform here
is attributed to that human, not to you — exactly as if they had clicked the
WebUI themselves. This implies:

- Do not answer a question task, cancel a task, or confirm a dangerous
  profile value unless the human has explicitly made that judgment in your
  conversation. When in doubt, show the human the task and ask. Answers you
  submit are counted as human decisions in the board's statistics.
- Registry changes you make (agents, profiles, workspaces) are committed to
  main as human-authored changes.
- Reading the decision log here does NOT mark it as seen by the human. The
  board's unread cursor advances only in the WebUI. If the human relies on
  you for log awareness, relay what you read; the same entries will still
  appear in their next triage session.`;

function buildManagementMcpServer(deps: ManagementMcpDeps): McpServer {
  const server = new McpServer(
    { name: "tidepool-management", version: "0.0.0" },
    { instructions: MANAGEMENT_MCP_INSTRUCTIONS },
  );
  server.registerTool("list_board", { description: "List the current task board." }, async () =>
    toolResult(listBoard(deps.db)),
  );
  server.registerTool("list_queue", { description: "List the execution queue and pickup state." }, async () =>
    toolResult(
      listQueue(
        deps.db,
        isPickupBlocked(deps.db, deps.clock.now()) ||
          isPaused(deps.db) ||
          openContainmentQuestion(deps.db) !== undefined,
        deps.workspace?.name,
        deps.defaultAgentName,
        deps.auditorName,
        isFablePickupBlocked(deps.db, deps.clock.now()) && deps.fableAgents ? deps.fableAgents() : undefined,
      ),
    ),
  );
  server.registerTool("list_your_tasks", { description: "List unsettled tasks assigned to the human." }, async () =>
    toolResult(listYourTasks(deps.db)),
  );
  server.registerTool(
    "get_task",
    { description: "Get a task and its complete event history.", inputSchema: { task_id: z.string() } },
    async ({ task_id }) => {
      const task = getTask(deps.db, task_id);
      return task ? toolResult({ ...task, events: listEvents(deps.db, task.id) }) : toolError("task not found");
    },
  );
  server.registerTool("read_decision_log", { description: "Read the decision log without marking it seen." }, async () =>
    toolResult({ entries: listLog(deps.db, deps.workspace?.name), cursor: getLogCursor(deps.db) }),
  );
  return server;
}

export function createManagementMcpRouter(deps: ManagementMcpDeps): Router {
  return createStatelessMcpRouter(() => buildManagementMcpServer(deps));
}
