import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import { UnknownAgentError } from "./agent.js";
import {
  type AgentAdmin,
  InvalidAgentIconError,
  UnknownAuthorityProfileError,
} from "./agent-create.js";
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
import { dangerousValues, type ProfileAdmin } from "./profile-create.js";
import {
  InvalidAgentNameError,
  InvalidAuthorityProfileNameError,
  InvalidSkillAllowlistError,
  InvalidWorkspaceNameError,
} from "./registry.js";
import { RegistryCloneBusyError } from "./registry-write.js";
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
import { UnknownWorkspaceError, type WorkspaceConfig } from "./workspace.js";
import {
  BoardStateOverlapError,
  GitHubIdentityMissingError,
  RegistrySelfUnprotectError,
  UnprotectNeedsConfirmationError,
  type WorkspaceAdmin,
} from "./workspace-create.js";

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
  workspaceAdmin?: Partial<WorkspaceAdmin>;
  agentAdmin?: Partial<AgentAdmin>;
  profileAdmin?: Partial<ProfileAdmin>;
}

const createWorkspaceSchema = z.discriminatedUnion("mode", [
  z.object({
    name: z.string().min(1),
    notes: z.string().min(1).optional(),
    protected: z.boolean().optional(),
    mode: z.literal("register"),
    path: z.string().min(1),
  }),
  z.object({
    name: z.string().min(1),
    notes: z.string().min(1).optional(),
    protected: z.boolean().optional(),
    mode: z.literal("clone"),
    repo: z.string().min(1),
  }),
  z.object({
    name: z.string().min(1),
    notes: z.string().min(1).optional(),
    protected: z.boolean().optional(),
    mode: z.literal("create"),
  }),
]);

const agentFieldsSchema = z.object({
  authority: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  advisor: z.string().optional(),
  skills: z.array(z.string()),
  system_prompt: z.string(),
});

const profileFieldsSchema = z.object({
  guidance: z.string(),
  assignable_to: z.array(z.string()),
  allowed_workspaces: z.array(z.string()),
  merge: z.enum(["escalate", "auto_if_ci_green"]).optional(),
  confirm_dangerous: z.boolean().default(false),
});

/** Maps the WebUI's registry failure taxonomy to MCP tool errors. */
function registryToolError(err: unknown) {
  if (err instanceof RegistryCloneBusyError) {
    return toolError(`registry is busy; retry this request: ${err.message}`);
  }
  if (err instanceof GitHubIdentityMissingError) return toolError(`registry configuration missing: ${err.message}`);
  if (
    err instanceof InvalidWorkspaceNameError ||
    err instanceof BoardStateOverlapError ||
    err instanceof UnknownWorkspaceError ||
    err instanceof UnprotectNeedsConfirmationError ||
    err instanceof RegistrySelfUnprotectError ||
    err instanceof InvalidAgentNameError ||
    err instanceof UnknownAgentError ||
    err instanceof UnknownAuthorityProfileError ||
    err instanceof InvalidAgentIconError ||
    err instanceof InvalidSkillAllowlistError ||
    err instanceof InvalidAuthorityProfileNameError
  ) {
    return toolError(err.message);
  }
  return toolError(`registry upstream error: ${err instanceof Error ? err.message : String(err)}`);
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
    "create_workspace",
    {
      description: "Create a workspace in the human-managed registry.",
      inputSchema: createWorkspaceSchema,
    },
    async (input) => {
      if (!deps.workspaceAdmin?.create) return toolError("workspace administration is not configured");
      try {
        return toolResult(await deps.workspaceAdmin.create(input));
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "list_workspaces",
    { description: "List workspaces in the human-managed registry." },
    async () => {
      if (!deps.workspaceAdmin?.list) return toolError("workspace administration is not configured");
      try {
        return toolResult({ workspaces: deps.workspaceAdmin.list() });
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "update_workspace",
    {
      description: "Update a workspace in the human-managed registry.",
      inputSchema: z.object({
        name: z.string().min(1),
        notes: z.string().optional(),
        protected: z.boolean().optional(),
        confirm: z.boolean().optional(),
      }),
    },
    async (input) => {
      if (!deps.workspaceAdmin?.update) return toolError("workspace administration is not configured");
      try {
        return toolResult(await deps.workspaceAdmin.update(input));
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "create_agent",
    {
      description: "Create an agent in the human-managed registry.",
      inputSchema: agentFieldsSchema.extend({ name: z.string().min(1) }),
    },
    async ({ system_prompt, ...input }) => {
      if (!deps.agentAdmin?.create) return toolError("agent administration is not configured");
      try {
        return toolResult(await deps.agentAdmin.create({ ...input, systemPrompt: system_prompt }));
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "list_agents",
    { description: "List agents and available authority profiles in the human-managed registry." },
    async () => {
      if (!deps.agentAdmin?.list) return toolError("agent administration is not configured");
      try {
        return toolResult({
          agents: deps.agentAdmin.list(),
          authority_profiles: deps.agentAdmin.authorityProfiles?.() ?? [],
        });
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "update_agent",
    {
      description: "Update an agent in the human-managed registry.",
      inputSchema: agentFieldsSchema.extend({ name: z.string().min(1) }),
    },
    async ({ system_prompt, ...input }) => {
      if (!deps.agentAdmin?.update) return toolError("agent administration is not configured");
      try {
        return toolResult(await deps.agentAdmin.update({ ...input, systemPrompt: system_prompt }));
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "create_profile",
    {
      description:
        "Create an authority profile in the human-managed registry. Set confirm_dangerous to true only after obtaining the human's explicit confirmation.",
      inputSchema: profileFieldsSchema.extend({ name: z.string().min(1) }),
    },
    async ({ confirm_dangerous, ...input }) => {
      if (!deps.profileAdmin?.create) return toolError("profile administration is not configured");
      const dangerous = dangerousValues(input);
      if (dangerous.length > 0 && !confirm_dangerous) {
        return toolError(`profile contains dangerous values; human confirmation is required: ${dangerous.join(", ")}`);
      }
      try {
        return toolResult(await deps.profileAdmin.create(input));
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "list_profiles",
    { description: "List authority profiles in the human-managed registry." },
    async () => {
      if (!deps.profileAdmin?.list) return toolError("profile administration is not configured");
      try {
        return toolResult({ profiles: deps.profileAdmin.list() });
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "update_profile",
    {
      description:
        "Update an authority profile in the human-managed registry. Set confirm_dangerous to true only after obtaining the human's explicit confirmation.",
      inputSchema: profileFieldsSchema.extend({ name: z.string().min(1) }),
    },
    async ({ confirm_dangerous, ...input }) => {
      if (!deps.profileAdmin?.update) return toolError("profile administration is not configured");
      const dangerous = dangerousValues(input);
      if (dangerous.length > 0 && !confirm_dangerous) {
        return toolError(`profile contains dangerous values; human confirmation is required: ${dangerous.join(", ")}`);
      }
      try {
        return toolResult(await deps.profileAdmin.update(input));
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "cancel_task",
    {
      description: "Cancel a human-registered task and its unsettled descendants.",
      inputSchema: { task_id: z.string(), reason: z.string().optional() },
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
        title: z.string().optional(),
        purpose: z.string().optional(),
        completion_criteria: z.string().optional(),
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
        reason: z.string(),
        children: z.array(
          z.object({
            title: z.string(),
            purpose: z.string(),
            completion_criteria: z.string(),
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
        workspace: z.string(),
        github_issue_number: z.number(),
        body: z.string(),
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
        type: z.string(),
        title: z.string().optional(),
        purpose: z.string().optional(),
        completion_criteria: z.string().optional(),
        github_issue_number: z.number().optional(),
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
        input as import("./human-verbs.js").HumanRegisterInput,
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
        comment: z.string().optional(),
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
