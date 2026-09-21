import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import { UnknownAgentError } from "./agent.js";
import {
  type AgentAdmin,
  BuiltInAgentNotEditableError,
  InvalidAgentIconError,
  UnknownAuthorityProfileError,
} from "./agent-create.js";
import type { AttributionClient, BehaviorDraftClient } from "./attribution.js";
import { boardHalts } from "./board-halt.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { DraftClient } from "./draft.js";
import { getLogCursor, listEvents, listLog } from "./events.js";
import {
  applyExecutionSettingsChange,
  executionSettingsChangeSchema,
  PRIORITY_FIELD_DESCRIPTION,
  readExecutionSettings,
  TIER_FIELD_DESCRIPTION,
} from "./execution-setting.js";
import type { GitHubClient } from "./github.js";
import {
  addIssueCommentThroughHumanDoor,
  cancelThroughHumanDoor,
  completeThroughHumanDoor,
  decomposeThroughHumanDoor,
  editThroughHumanDoor,
  registerThroughHumanDoor,
  submitAnswer,
} from "./human-verbs.js";
import type { Landing } from "./landing.js";
import { toolError, toolResult } from "./mcp.js";
import {
  changeMemorySettings,
  defineMemoryBranch,
  humanDefinitionSchema,
  humanEntryInput,
  humanKnowledgeSchema,
  invalidateMemoryEntry,
  invalidationSchema,
  listMemoryEntries,
  memoryListFilterSchema,
  memorySettingsChangeSchema,
  readMemorySettings,
  rebuildMemoryIndex,
  recordKnowledge,
  TOKENIZER,
} from "./memory.js";
import { type ProfileAdmin, ProfileConfirmationRequiredError } from "./profile-create.js";
import { type QuarantineChecks, type QuarantineResolvers, quarantineStops } from "./quarantine.js";
import {
  InvalidAgentDefinitionError,
  InvalidAgentNameError,
  InvalidAllowedDomainError,
  InvalidAuthorityProfileNameError,
  InvalidReviewAllowedCommandError,
  InvalidSkillAllowlistError,
  InvalidWorkspaceNameError,
  isBuiltInAgentName,
  MERGE_DIAL_VALUES,
} from "./registry.js";
import { RepoAccessMissingError } from "./repo-access.js";
import {
  entryExclusionPredicate,
  type TaskExecutionCandidates,
} from "./scheduler.js";
import { createStatelessMcpRouter } from "./stateless-mcp.js";
import {
  DomainError,
  getTask,
  HANDOFF_FIELDS,
  HUMAN_WORKER_ID,
  listBoard,
  listQueue,
  listYourTasks,
} from "./tasks.js";
import { sessionInTeardown } from "./teardown.js";
import type { PendingReclaim } from "./watchdog.js";
import { UnknownWorkspaceError, type WorkspaceConfig } from "./workspace.js";
import {
  BoardStateOverlapError,
  CheckoutHasOriginError,
  GitHubIdentityMissingError,
  LiveCheckoutSignalsError,
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
  landing: Landing;
  draftClient?: DraftClient;
  /** ADR 0115 決定2 / issue #575: threaded to the cancel / answer doors, the
   *  same seam the WebUI router carries. */
  attributionClient?: AttributionClient;
  behaviorDraftClient?: BehaviorDraftClient;
  pollNow: () => void;
  defaultAgentName?: string;
  auditorName?: string;
  agentRegistered?: (name: string) => boolean;
  isProtectedWorkspace?: (name: string) => boolean;
  /** ADR 0099 決定3: 受理された Containment quarantine の確認回答が slot を解放する門。 */
  reclaim?: Pick<PendingReclaim, "acceptReclaimed">;
  /** ADR 0137 決定5: 解除の門の map(WebUI 側と同じ配線)。 */
  quarantineChecks?: QuarantineChecks;
  /** ADR 0137 決定6: 資源単位の quarantine の値 → agent 名 —— 直接 cancel の門が読む
   *  (WebUI 側と同じ配線)。 */
  quarantineResolvers?: QuarantineResolvers;
  /** ADR 0110 決定1/3 / issue #544: queue の skipped 表示が scheduler のゲートと
   *  同じ式を通るための口(api.ts と同じもの)。 */
  taskExecutionCandidates: TaskExecutionCandidates;
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
  tier: z.string().optional(),
  advisor: z.boolean().optional(),
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
    // ADR 0117 決定2 の「組み込みは編集できない」—— 入口の拒否であって上流の失敗
    // ではないので、`registry upstream error` の器に落としてはいけない
    err instanceof BuiltInAgentNotEditableError ||
    err instanceof UnknownAuthorityProfileError ||
    err instanceof InvalidAgentIconError ||
    err instanceof InvalidSkillAllowlistError ||
    err instanceof InvalidAgentDefinitionError ||
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
  /** queue の skipped 表示を scheduler のゲートと同じ式から導く(ADR 0110 決定3)。 */
  const skippedByEntries = (deps: ManagementMcpDeps) =>
    entryExclusionPredicate(deps.db, deps.taskExecutionCandidates);

  server.registerTool("list_queue", { description: "List the execution queue and pickup state." }, async () => {
    // 停止ではないが pickup を待たせているもの(ADR 0109 決定2)。列挙には加えない ——
    // ただし**落ちた**後始末は列挙の側にも出る(ADR 0112 決定1)。このフィールドが言う
    // のは「いつ後始末に入ったか」、列挙が言うのは「止まっている」で、同時に出る重複は
    // 承知の上である
    const teardown = sessionInTeardown(deps.db);
    return toolResult({
      halts: boardHalts(deps.db),
      ...(teardown ? { teardown } : {}),
      tasks: listQueue(
        deps.db,
        deps.workspace?.name,
        deps.defaultAgentName,
        deps.auditorName,
        quarantineStops(deps.db),
        skippedByEntries(deps),
      ),
    });
  });
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
        "Create a workspace in the human-managed registry. clone / create land at <workspaces dir>/<name> — read list_workspaces first for that directory and whether it is configured or the default. register goes through even when the path looks like a checkout a human is working in; the result then carries a notice naming what was observed and where the clone entrance would have landed instead.",
      inputSchema: createWorkspaceSchema,
    },
    async (input) => {
      if (!deps.workspaceAdmin?.create) return toolError("workspace administration is not configured");
      try {
        return toolResult({ path: await deps.workspaceAdmin.create(input) });
      } catch (err) {
        // issue #383: 「人間の生きた dev checkout」の信号は、ここでは拒否にしない
        // (ADR 0082 決定1 — 1回の呼び出しで登録まで進む面に「見せてから決める」形は
        // 無い)。通したうえで、観測した信号と clone 入口の提案を結果に載せる。
        // ADR 0088 の形(拒んで WebUI へ案内)は採らない: この信号はエージェントの
        // 権限を広げず、拒めば今日 MCP から通っている dirty checkout の register を
        // 通らなくする = issue が「やらないこと」に挙げた自動拒否そのものになる。
        // スキーマに `confirm` は生やさず、ここで内部的に立てる — 確認をエージェントに
        // 肩代わりさせる経路は作らない。信号の**判定**は domain が唯一の正本(ADR 0027)
        // だが、**文面**はこの扉が自分で綴る: `err.message` は HTTP の扉宛てで
        // 「confirm: true で出し直せ」と言っており、ここの読み手にとっては既に済んだ
        // 操作の指示であり、かつ渡す手段の無い引数の名指しである。
        if (err instanceof LiveCheckoutSignalsError && input.mode === "register") {
          try {
            const path = await deps.workspaceAdmin.create({ ...input, confirm: true });
            return toolResult({
              path,
              notice:
                `registered as asked. This path looks like a checkout a human is working in (${err.reasons.join(", ")})` +
                (err.cloneLanding === null
                  ? ". Tell the human what was observed."
                  : `. The clone entrance would have given the board its own checkout at ${err.cloneLanding} instead — tell the human, who may prefer that.`),
            });
          } catch (retried) {
            return registryToolError(retried);
          }
        }
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
        // 静かな shadow は作らない(ADR 0117 決定2) —— WebUI の 201 と同じ通知を
        // この扉にも置く。真のときだけ載せる
        return toolResult(isBuiltInAgentName(input.name) ? { shadows_built_in: true } : {});
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
  // ADR 0110 決定5 / issue #545: the execution settings are the one settings
  // surface the Management MCP carries — "keep Claude for me this week, prefer
  // Codex" is a Provider-rank write the human's session makes in their name.
  server.registerTool(
    "read_execution_settings",
    {
      description:
        "Read the board's execution settings: the model table (rows of provider, model, tier, effort, price_in / price_out in USD per MTok), " +
        "whether the frontier row may serve as advisor, the Provider rank, and the default priority (quality / cost).",
    },
    async () => toolResult(readExecutionSettings(deps.db)),
  );
  server.registerTool(
    "change_execution_settings",
    {
      description:
        "Apply one change to the board's execution settings as the human: upsert a table row (`row`, keyed by provider + model), " +
        "delete one (`delete_row` — deleting every row of a provider × tier just excludes that provider for tasks of that tier), " +
        "or set `frontier_advisor`, `provider_rank` (every provider exactly once, first = preferred) or the default `priority`. " +
        "Takes effect at the next pickup.",
      inputSchema: { change: executionSettingsChangeSchema },
    },
    async ({ change }) => {
      applyExecutionSettingsChange(deps.db, change, "mcp", deps.clock.now());
      deps.pollNow();
      return toolResult(readExecutionSettings(deps.db));
    },
  );
  server.registerTool(
    "read_memory_settings",
    {
      description:
        "Read the board's memory settings: injection_token_cap, the token cap on the memory section injected into a worker at spawn; " +
        "meta_review_period_days, the minimum number of days between two periodic memory meta-reviews.",
    },
    async () => toolResult(readMemorySettings(deps.db)),
  );
  server.registerTool(
    "change_memory_settings",
    {
      description:
        `Change the board's memory settings as the human; give at least one field. injection_token_cap: a positive integer, counted with ${TOKENIZER.id}, takes effect at the next spawn. ` +
        "meta_review_period_days: a positive integer, the minimum days between periodic memory meta-reviews.",
      inputSchema: memorySettingsChangeSchema.shape,
    },
    async (change) => memoryVerb(() => {
      changeMemorySettings(deps.db, change, "mcp", deps.clock.now());
      return readMemorySettings(deps.db);
    }),
  );
  // spec #586 F / issue #593: the human's memory surface. No approve verb — approval
  // only goes through a question (#358). Domain errors come back as tool errors.
  const memoryVerb = (write: () => unknown) => {
    try {
      return toolResult(write());
    } catch (err) {
      if (err instanceof DomainError) return toolError(err.message);
      throw err;
    }
  };
  const writtenAs =
    "Written as the human, approved at once. The original_* fields, when given, are the human's own wording, recorded in the " +
    "board's display language. workspace null = the whole board.";
  server.registerTool(
    "list_memory_entries",
    {
      description:
        "List the board's memory entries, including candidates, invalidated ones (with invalidation_reason and successor_id) " +
        "and board-wide definitions a workspace definition shadows. workspace matches exactly; board_wide lists only board-wide entries; " +
        "state invalidated lists invalidated entries, approved / candidate the rest.",
      inputSchema: memoryListFilterSchema.extend({ board_wide: z.boolean().optional() }).shape,
    },
    async ({ workspace, board_wide, ...filter }) =>
      toolResult(listMemoryEntries(deps.db, { ...filter, scope: board_wide ? null : workspace })),
  );
  server.registerTool(
    "record_knowledge",
    {
      description: `Record a Knowledge entry: a fact filed under path (a "/"-separated hierarchy such as build/tests). title and text are the ` +
        `English canonical wording; original_title and original_text go together (both or neither). ${writtenAs}`,
      inputSchema: humanKnowledgeSchema.shape,
    },
    async (input) => memoryVerb(() => recordKnowledge(deps.db, humanEntryInput(deps.db, input), "mcp", deps.clock.now())),
  );
  server.registerTool(
    "define_memory_branch",
    {
      description:
        "Define a memory branch: one line at the branch's path declaring what is filed under it. To revise a branch's " +
        `definition, pass the current one's id as supersedes. text is the English canonical line; original_text is optional. ${writtenAs}`,
      inputSchema: humanDefinitionSchema.shape,
    },
    async (input) => memoryVerb(() => defineMemoryBranch(deps.db, humanEntryInput(deps.db, input), "mcp", deps.clock.now())),
  );
  server.registerTool(
    "invalidate_memory_entry",
    {
      description:
        "Invalidate a memory entry so it is no longer injected or pulled (nothing is deleted). reason is superseded or path_moved " +
        "(both require successor_id), capability (it was wrong), or environment / requirement_change (it went stale).",
      inputSchema: invalidationSchema.extend({ entry_id: z.number().int().positive() }).shape,
    },
    async (input) => memoryVerb(() => ({ event_id: invalidateMemoryEntry(deps.db, input, HUMAN_WORKER_ID, "mcp", deps.clock.now()) })),
  );
  server.registerTool(
    "rebuild_memory_index",
    { description: "Rebuild the memory entry table and its search index by replaying the board's memory events." },
    async () => toolResult({ event_id: rebuildMemoryIndex(deps.db, HUMAN_WORKER_ID, "mcp", deps.clock.now()) }),
  );
  server.registerTool(
    "cancel_task",
    {
      description: "Cancel a human-registered task and its unsettled descendants.",
      inputSchema: { task_id: z.string(), reason: z.string().optional() },
    },
    async ({ task_id, reason }) => {
      const result = await cancelThroughHumanDoor(
        deps,
        task_id,
        reason,
        () => deps.clock.now(),
        "mcp",
      );
      return result.ok ? toolResult(result.value) : toolError(result.failure.error);
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
      const result = editThroughHumanDoor(
        deps,
        task_id,
        input,
        () => deps.clock.now(),
        "mcp",
      );
      return result.ok ? toolResult(result.value) : toolError(result.failure.error);
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
            tier: z.string().optional().describe(TIER_FIELD_DESCRIPTION),
            review_by: z.array(z.string().min(1)).optional(),
            review_tier: z.string().optional(),
            priority: z.string().optional().describe(PRIORITY_FIELD_DESCRIPTION),
          }),
        ),
      },
    },
    async ({ task_id, reason, children: childSpecs }) => {
      const result = decomposeThroughHumanDoor(
        deps,
        task_id,
        { reason, children: childSpecs },
        () => deps.clock.now(),
        "mcp",
      );
      return result.ok
        ? toolResult({ child_ids: result.value.map((child) => child.id), parent_status: "blocked" })
        : toolError(result.failure.error);
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
      const result = await completeThroughHumanDoor(
        deps,
        task_id,
        handoff,
        () => deps.clock.now(),
        "mcp",
      );
      return result.ok ? toolResult(result.value) : toolError(result.failure.error);
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
        tier: z.string().optional().describe(TIER_FIELD_DESCRIPTION),
        review_by: z.array(z.string().min(1)).optional(),
        review_tier: z.string().optional(),
        priority: z.string().optional().describe(PRIORITY_FIELD_DESCRIPTION),
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
          pollNow: deps.pollNow,
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
              pollNow: deps.pollNow,
              workspace: deps.workspace,
              resolveWorkspace: deps.resolveWorkspace,
              github: deps.github,
              landing: deps.landing,
              reclaim: deps.reclaim,
              quarantineChecks: deps.quarantineChecks,
              attributionClient: deps.attributionClient,
              behaviorDraftClient: deps.behaviorDraftClient,
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
