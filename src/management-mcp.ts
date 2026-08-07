import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import type { BoardStatePath } from "./board-state.js";
import type { Clock } from "./clock.js";
import { type ContainmentCheck, openContainmentQuestion } from "./containment.js";
import type { Db } from "./db.js";
import type { DraftClient } from "./draft.js";
import { getLogCursor, listEvents, listLog } from "./events.js";
import type { GitHubClient } from "./github.js";
import {
  addIssueCommentThroughHumanDoor,
  assertAssigneeKnown,
  assertWorkspaceKnown,
  humanCancelDefaults,
  pollIfParentUnblocked,
  registerThroughHumanDoor,
  submitAnswer,
} from "./human-verbs.js";
import { toolError, toolResult } from "./mcp.js";
import { isPaused } from "./pause.js";
import { createStatelessMcpRouter } from "./stateless-mcp.js";
import {
  cancelTaskDirectly,
  completeTask,
  DomainError,
  editTask,
  getTask,
  HANDOFF_FIELDS,
  HUMAN_WORKER_ID,
  humanDecomposeTask,
  listBoard,
  listQueue,
  listYourTasks,
} from "./tasks.js";
import { isFablePickupBlocked, isPickupBlocked } from "./throttle.js";
import type { WorkspaceConfig } from "./workspace.js";

export interface ManagementMcpDeps {
  db: Db;
  clock: Clock;
  workspace?: WorkspaceConfig;
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  github?: GitHubClient;
  draftClient?: DraftClient;
  onQueueHeadChanged: () => void;
  retryPrPromotion?: (task: import("./tasks.js").Task) => Promise<void>;
  defaultAgentName?: string;
  auditorName?: string;
  agentRegistered?: (name: string) => boolean;
  isProtectedWorkspace?: (name: string) => boolean;
  containment?: ContainmentCheck;
  boardState?: BoardStatePath[];
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
  server.registerTool(
    "cancel_task",
    {
      description: "Cancel a human-registered task and its unsettled descendants.",
      inputSchema: { task_id: z.string(), reason: z.string().min(1).optional() },
    },
    async ({ task_id, reason }) => {
      const task = getTask(deps.db, task_id);
      if (!task) return toolError("task not found");
      try {
        cancelTaskDirectly(
          deps.db,
          task,
          reason ?? null,
          deps.clock.now(),
          humanCancelDefaults(deps.workspace, deps.defaultAgentName, deps.auditorName),
          "mcp",
        );
        pollIfParentUnblocked(deps.db, task, deps.onQueueHeadChanged);
        return toolResult(getTask(deps.db, task.id)!);
      } catch (err) {
        if (err instanceof DomainError) return toolError(err.message);
        throw err;
      }
    },
  );
  server.registerTool(
    "edit_task",
    {
      description: "Edit the unconsumed fields of a human-registered task.",
      inputSchema: {
        task_id: z.string(),
        title: z.string().min(1).optional(),
        purpose: z.string().min(1).optional(),
        completion_criteria: z.string().min(1).optional(),
        assignee: z.string().optional(),
        workspace: z.string().optional(),
        risk_flag: z.boolean().optional(),
        review_flag: z.boolean().optional(),
      },
    },
    async ({ task_id, ...input }) => {
      const task = getTask(deps.db, task_id);
      if (!task) return toolError("task not found");
      try {
        if (input.assignee) assertAssigneeKnown(deps.agentRegistered, input.assignee);
        if (input.workspace) {
          assertWorkspaceKnown(input.workspace, deps.resolveWorkspace, deps.workspace);
        }
        return toolResult(editTask(deps.db, task, input, deps.clock.now(), "mcp"));
      } catch (err) {
        if (err instanceof DomainError) return toolError(err.message);
        throw err;
      }
    },
  );
  server.registerTool(
    "decompose_task",
    {
      description: "Split a human task into child tasks in one recorded decision.",
      inputSchema: {
        task_id: z.string(),
        reason: z.string().min(1),
        children: z.array(
          z.object({
            title: z.string().min(1),
            purpose: z.string().min(1),
            completion_criteria: z.string().min(1),
            risk_flag: z.boolean().optional(),
            assignee: z.string().optional(),
            workspace: z.string().optional(),
            review_flag: z.boolean().optional(),
          }),
        ),
      },
    },
    async ({ task_id, reason, children: childSpecs }) => {
      const task = getTask(deps.db, task_id);
      if (!task) return toolError("task not found");
      try {
        for (const child of childSpecs) {
          if (child.assignee) assertAssigneeKnown(deps.agentRegistered, child.assignee);
          if (child.workspace) {
            assertWorkspaceKnown(child.workspace, deps.resolveWorkspace, deps.workspace);
          }
        }
        const children = humanDecomposeTask(
          deps.db,
          task,
          { reason, children: childSpecs },
          deps.clock.now(),
          deps.isProtectedWorkspace,
          "mcp",
        );
        return toolResult({ child_ids: children.map((child) => child.id), parent_status: "blocked" });
      } catch (err) {
        if (err instanceof DomainError) return toolError(err.message);
        throw err;
      }
    },
  );
  server.registerTool(
    "complete_task",
    {
      description: "Complete a task assigned to the human.",
      inputSchema: {
        task_id: z.string(),
        handoff: z.partialRecord(z.enum(HANDOFF_FIELDS), z.string()).optional(),
      },
    },
    async ({ task_id, handoff }) => {
      const task = getTask(deps.db, task_id);
      if (!task) return toolError("task not found");
      if (task.assignee !== HUMAN_WORKER_ID) {
        return toolError(
          "only a human-assignee task can be completed here — agents complete via MCP's complete_task",
        );
      }
      try {
        const done = completeTask(deps.db, task, handoff, HUMAN_WORKER_ID, deps.clock.now(), "mcp");
        pollIfParentUnblocked(deps.db, done, deps.onQueueHeadChanged);
        return toolResult(done);
      } catch (err) {
        if (err instanceof DomainError) return toolError(err.message);
        throw err;
      }
    },
  );
  server.registerTool(
    "add_issue_comment",
    {
      description: "Add a human-approved comment to a GitHub issue.",
      inputSchema: {
        workspace: z.string().min(1),
        github_issue_number: z.number().int().positive(),
        body: z.string().min(1),
      },
    },
    async (input) => {
      const result = await addIssueCommentThroughHumanDoor(
        {
          github: deps.github,
          workspace: deps.workspace,
          resolveWorkspace: deps.resolveWorkspace,
        },
        input,
      );
      return result.ok ? toolResult({}) : toolError(JSON.stringify(result.failure));
    },
  );
  server.registerTool(
    "register_task",
    {
      description: "Register a human work or review task, optionally backed by a GitHub issue.",
      inputSchema: {
        type: z.enum(["work", "review"]),
        title: z.string().min(1).optional(),
        purpose: z.string().min(1).optional(),
        completion_criteria: z.string().min(1).optional(),
        github_issue_number: z.number().int().positive().optional(),
        parent_id: z.string().optional(),
        assignee: z.string().optional(),
        workspace: z.string().optional(),
        risk_flag: z.boolean().optional(),
        review_flag: z.boolean().optional(),
        decompose_reason: z.string().optional(),
      },
    },
    async (input) => {
      const result = await registerThroughHumanDoor(
        {
          db: deps.db,
          workspace: deps.workspace,
          resolveWorkspace: deps.resolveWorkspace,
          github: deps.github,
          draftClient: deps.draftClient,
          agentRegistered: deps.agentRegistered,
          isProtectedWorkspace: deps.isProtectedWorkspace,
        },
        input,
        () => deps.clock.now(),
        "mcp",
      );
      return result.ok ? toolResult(result.task) : toolError(JSON.stringify(result.failure));
    },
  );
  server.registerTool(
    "answer_question",
    {
      description: "Answer every item of a question task as the human.",
      inputSchema: {
        task_id: z.string(),
        answers: z.array(z.string()),
        comment: z.string().min(1).optional(),
      },
    },
    async ({ task_id, answers, comment }) => {
      const task = getTask(deps.db, task_id);
      if (!task) return toolError("task not found");
      try {
        return toolResult(
          await submitAnswer(
            {
              db: deps.db,
              onQueueHeadChanged: deps.onQueueHeadChanged,
              workspace: deps.workspace,
              resolveWorkspace: deps.resolveWorkspace,
              github: deps.github,
              retryPrPromotion: deps.retryPrPromotion,
              agentRegistered: deps.agentRegistered,
              containment: deps.containment,
              boardState: deps.boardState,
            },
            task,
            answers,
            comment,
            () => deps.clock.now(),
            "mcp",
          ),
        );
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
  return server;
}

export function createManagementMcpRouter(deps: ManagementMcpDeps): Router {
  return createStatelessMcpRouter(() => buildManagementMcpServer(deps));
}
