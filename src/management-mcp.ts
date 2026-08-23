import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import { UnknownAgentError } from "./agent.js";
import {
  type AgentAdmin,
  InvalidAgentIconError,
  UnknownAuthorityProfileError,
} from "./agent-create.js";
import { boardHalts } from "./board-halt.js";
import type { BoardStatePath } from "./board-state.js";
import type { CliAuthCheck } from "./cli-auth.js";
import type { Clock } from "./clock.js";
import type { ContainmentCheck } from "./containment.js";
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
import { type ProfileAdmin, ProfileConfirmationRequiredError } from "./profile-create.js";
import {
  InvalidAgentNameError,
  InvalidAgentProviderError,
  InvalidAllowedDomainError,
  InvalidAuthorityProfileNameError,
  InvalidReviewAllowedCommandError,
  InvalidSkillAllowlistError,
  InvalidWorkspaceNameError,
  MERGE_DIAL_VALUES,
  type Provider,
  type RegistryReachabilityCheck,
} from "./registry.js";
import { RepoAccessMissingError } from "./repo-access.js";
import { pickupExcludedAssignees } from "./scheduler.js";
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
import { isFablePickupBlocked } from "./throttle.js";
import { UnknownWorkspaceError, type WorkspaceConfig } from "./workspace.js";
import {
  BoardStateOverlapError,
  CheckoutHasOriginError,
  GitHubIdentityMissingError,
  NotAGitRepositoryError,
  RegistrySelfPublishError,
  RegistrySelfUnprotectError,
  type WorkspaceAdmin,
  WorkspaceAlreadyPublishedError,
  WorkspaceConfirmationRequiredError,
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
  /** 付帯子の決着で祖先の着地を撃ち直す(ADR 0092 決定3)— WebUI 側と同じ配線。 */
  relandRootAncestor?: (task: import("./tasks.js").Task) => Promise<void>;
  defaultAgentName?: string;
  auditorName?: string;
  agentRegistered?: (name: string) => boolean;
  isProtectedWorkspace?: (name: string) => boolean;
  containment?: ContainmentCheck;
  registryReachability?: RegistryReachabilityCheck;
  cliAuth?: CliAuthCheck;
  providerCliAuth?: Partial<Record<Provider, CliAuthCheck>>;
  boardState?: BoardStatePath[];
  fableAgents?: () => string[];
  /** ADR 0097 決定2 / issue #446: the names of the agents declared with one of
   *  the given providers — the pickup exclusion set `list_queue`'s `skipped`
   *  display shares with the scheduler's gate. */
  agentsSpeakingProviders?: (providers: readonly Provider[]) => string[];
  /** scheduler のメモリ内の再観測中フラグ (ADR 0041 の明示注入)。読み口だけの
   *  盤面では未注入で、その場合 throttle の再観測中は現れない。 */
  throttleRevalidating?: () => boolean;
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
  provider: z.string().min(1),
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
  merge: z.enum(MERGE_DIAL_VALUES),
});

/** Maps the WebUI's registry failure taxonomy to MCP tool errors. */
function registryToolError(err: unknown) {
  if (err instanceof GitHubIdentityMissingError) return toolError(`registry configuration missing: ${err.message}`);
  if (
    err instanceof InvalidWorkspaceNameError ||
    err instanceof BoardStateOverlapError ||
    err instanceof RepoAccessMissingError ||
    err instanceof NotAGitRepositoryError ||
    err instanceof UnknownWorkspaceError ||
    err instanceof RegistrySelfUnprotectError ||
    err instanceof WorkspaceAlreadyPublishedError ||
    err instanceof CheckoutHasOriginError ||
    err instanceof RegistrySelfPublishError ||
    err instanceof InvalidAgentNameError ||
    err instanceof UnknownAgentError ||
    err instanceof UnknownAuthorityProfileError ||
    err instanceof InvalidAgentIconError ||
    err instanceof InvalidSkillAllowlistError ||
    err instanceof InvalidAgentProviderError ||
    err instanceof InvalidReviewAllowedCommandError ||
    err instanceof InvalidAllowedDomainError ||
    err instanceof InvalidAuthorityProfileNameError
  ) {
    return toolError(err.message);
  }
  // ADR 0088: 危険な値の確認は WebUI 専用の扉 — 管理MCP に確認引数は無いので、
  // この門はここでは絶対に開けない。理由コードを畳まず、案内だけ乗せる。
  if (err instanceof WorkspaceConfirmationRequiredError || err instanceof ProfileConfirmationRequiredError) {
    return toolError(
      `dangerous values (${err.reasons.join(", ")}) require human confirmation; confirm and save this in the WebUI's settings screen.`,
    );
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

- Do not answer a question task or cancel a task unless the human has
  explicitly made that judgment in your conversation. When in doubt, show
  the human the task and ask. Answers you submit are counted as human
  decisions in the board's statistics.
- Registry changes you make (agents, profiles, workspaces) are committed to
  main as human-authored changes. Authority profile and workspace edits that
  carry a dangerous value (unattended merge, a wildcard, unprotecting, a
  non-empty allowlist) are rejected here outright — confirm and save those in
  the WebUI's settings screen instead.
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
    toolResult(listBoard(deps.db, deps.defaultAgentName, deps.auditorName)),
  );
  // ADR 0068 決定3: the envelope is this ADR's real fix — an agent reading the
  // queue here receives "why is it quiet" in the same one read, since MCP has
  // no banner channel to fill the gap.
  server.registerTool("list_queue", { description: "List the execution queue and pickup state." }, async () =>
    toolResult({
      halts: boardHalts(deps.db, deps.throttleRevalidating),
      tasks: listQueue(
        deps.db,
        deps.workspace?.name,
        deps.defaultAgentName,
        deps.auditorName,
        pickupExcludedAssignees(
          deps.db,
          isFablePickupBlocked(deps.db, deps.clock.now()),
          deps.fableAgents,
          deps.agentsSpeakingProviders,
        ),
      ),
    }),
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
  server.registerTool(
    "read_decision_log",
    {
      description:
        "Read the decision log without marking it seen. Each entry carries every objection ever raised against it (bundled and still commit-pending alike).",
    },
    async () =>
      toolResult({ entries: listLog(deps.db, deps.workspace?.name), cursor: getLogCursor(deps.db) }),
  );
  server.registerTool(
    "create_workspace",
    {
      // ADR 0082 決定1: this gate decides and registers in one call, so the
      // landing place has to be readable before (the description) and after
      // (the result) — the WebUI's "see it, then decide" has no MCP shape.
      description:
        "Create a workspace in the human-managed registry. clone / create land at <workspaces dir>/<name> — read list_workspaces first for that directory and whether it is configured or the default.",
      inputSchema: createWorkspaceSchema,
    },
    async (input) => {
      if (!deps.workspaceAdmin?.create) return toolError("workspace administration is not configured");
      try {
        return toolResult({ path: await deps.workspaceAdmin.create(input) });
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
        return toolResult(deps.workspaceAdmin.list());
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
        // ADR 0061 / 0072: both workspace allowlists are editable here too —
        // `[]` removes one. Non-empty is a dangerous value (ADR 0088): this
        // door has no `confirm`, so the domain gate always rejects it.
        review_allowed_commands: z.array(z.string()).optional(),
        allowed_domains: z.array(z.string()).optional(),
      }),
    },
    async (input) => {
      if (!deps.workspaceAdmin?.update) return toolError("workspace administration is not configured");
      try {
        await deps.workspaceAdmin.update(input);
        return toolResult({});
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "publish_workspace",
    {
      // ADR 0066 決定2: the board creates nothing on GitHub — the destination
      // repository is one a human prepared and installed the App on.
      description:
        "Give a purely-local workspace a remote source of truth: push every branch to an empty repository the human prepared, then record it on the registry entry.",
      inputSchema: z.object({
        name: z.string().min(1),
        repo: z.string().min(1),
      }),
    },
    async (input) => {
      if (!deps.workspaceAdmin?.publish) return toolError("workspace administration is not configured");
      try {
        await deps.workspaceAdmin.publish(input);
        return toolResult({});
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
        await deps.agentAdmin.create({ ...input, systemPrompt: system_prompt });
        return toolResult({});
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
        await deps.agentAdmin.update({ ...input, systemPrompt: system_prompt });
        return toolResult({});
      } catch (err) {
        return registryToolError(err);
      }
    },
  );
  server.registerTool(
    "create_profile",
    {
      description: "Create an authority profile in the human-managed registry.",
      inputSchema: profileFieldsSchema.extend({ name: z.string().min(1) }),
    },
    async (input) => {
      if (!deps.profileAdmin?.create) return toolError("profile administration is not configured");
      try {
        await deps.profileAdmin.create(input);
        return toolResult({});
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
        "Update an authority profile in the human-managed registry. Fields omitted from the request are left unchanged.",
      // 部分パッチ(issue #266 / ADR 0086)— create 扉は全フィールド必須のまま
      inputSchema: profileFieldsSchema.partial().extend({ name: z.string().min(1) }),
    },
    async (input) => {
      if (!deps.profileAdmin?.update) return toolError("profile administration is not configured");
      try {
        await deps.profileAdmin.update(input);
        return toolResult({});
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
        // 付帯子の決着は、待っていた祖先の着地を起こす(ADR 0092 決定3)
        await deps.relandRootAncestor?.(task);
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
        await deps.relandRootAncestor?.(done);
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
              relandRootAncestor: deps.relandRootAncestor,
              agentRegistered: deps.agentRegistered,
              containment: deps.containment,
              registryReachability: deps.registryReachability,
              cliAuth: deps.cliAuth,
              providerCliAuth: deps.providerCliAuth,
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
