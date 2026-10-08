import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Router } from "express";
import { z } from "zod";
import { UnknownAgentError } from "./agent.js";
import {
  type AgentAdmin,
  BuiltInAgentNotEditableError,
  InvalidAgentIconError,
} from "./agent-create.js";
import { boardHalts } from "./board-halt.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import type { DraftClient } from "./draft.js";
import { getLogCursor, listEvents } from "./events.js";
import {
  changeExecutionSettings,
  executionSettingsChangeSchema,
  PRIORITY_FIELD_DESCRIPTION,
  readExecutionSettingsWithQuarantine,
  tierFieldDescriptions,
} from "./execution-setting.js";
import type { GitHubClient } from "./github.js";
import {
  addIssueCommentThroughHumanDoor,
  answerInputSchema,
  assertMemoryReferencesKnown,
  cancelThroughHumanDoor,
  completeThroughHumanDoor,
  decomposeThroughHumanDoor,
  editThroughHumanDoor,
  gatedHumanEntryInput,
  listMemoryEntriesForHuman,
  registerThroughHumanDoor,
  submitAnswer,
} from "./human-verbs.js";
import type { Landing } from "./landing.js";
import {
  JUDGED_AFTER_THE_EDIT,
  MEMORY_BRANCHES_DESCRIPTION,
  ONLY_WHERE_COMPLETION_REVIEW_FIRES,
  ONLY_WHERE_REVIEW_FIRES,
  REVIEW_FLAG_ONLY_ON_WORK_CHILDREN,
  REVIEW_TIER_BY_TYPE,
  REVIEWER_NAMES,
  toolError,
  toolResult,
} from "./mcp.js";
import {
  changeMemorySettings,
  defineMemoryBranch,
  foldMemoryEntries,
  HUMAN_AUTHOR,
  humanBehaviorSchema,
  humanDefinitionSchema,
  humanExemplarSchema,
  humanKnowledgeSchema,
  invalidateMemoryEntry,
  invalidationSchema,
  listMemoryBranches,
  memoryBranchMoveSchema,
  memoryFoldSchema,
  memoryListFilterSchema,
  memoryMoveSchema,
  memorySettingsChangeSchema,
  moveMemory,
  moveMemoryBranch,
  previewCase,
  questionAnnotations,
  readMemorySettings,
  rebuildMemoryIndex,
  recordBehavior,
  recordExemplar,
  recordKnowledge,
  restoreMemoryEntry,
  TOKENIZER,
} from "./memory.js";
import { changeMetaReviewSettings, metaReviewSettingsChangeSchema, readMetaReviewSettings } from "./meta-review.js";
import { whyNotPositiveInteger } from "./positive-integer.js";
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
  UnknownAuthorityProfileError,
} from "./registry.js";
import { RepoAccessMissingError } from "./repo-access.js";
import { requiredTextSchema } from "./required-text-schema.js";
import { nextDescription, packItems, type ReadPosition, readNext } from "./response-budget.js";
import { listHaltedRefires, markHaltedRefire, refireKeySchema } from "./retrospective.js";
import {
  entryExclusionPredicate,
  type TaskExecutionCandidates,
} from "./scheduler.js";
import { createStatelessMcpRouter, floorEveryResponse, rejectUnknownArguments } from "./stateless-mcp.js";
import {
  type BoardTask,
  describeHandoffFields,
  getTask,
  HANDOFF_FIELDS,
  listBoard,
  listQueue,
  listYourTasks,
  presentTask,
} from "./tasks.js";
import { sessionInTeardown } from "./teardown.js";
import { listLog } from "./triage.js";
import type { PendingReclaim } from "./watchdog.js";
import { HUMAN_WORKER_ID } from "./worker-id.js";
import { GitDirNotADirectoryError, UnknownWorkspaceError, type WorkspaceConfig } from "./workspace.js";
import {
  BoardStateOverlapError,
  CheckoutHasOriginError,
  type CreateWorkspaceInput,
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

// issue #685: top-level の union は SDK が object と認識せず引数を1つも advertise
// しない。平らな object にして、mode と path / repo の組み合わせは refine で強制する
const createWorkspaceSchema = z
  .object({
    name: requiredTextSchema,
    notes: z.string().min(1).optional(),
    protected: z.boolean().optional(),
    mode: z.enum(["register", "clone", "create"]),
    path: requiredTextSchema.optional().describe("Required for register (the existing checkout); ignored otherwise."),
    repo: requiredTextSchema.optional().describe("Required for clone (anything git clone accepts); ignored otherwise."),
  })
  .superRefine((input, ctx) => {
    if (input.mode === "register" && input.path === undefined)
      ctx.addIssue({ code: "custom", path: ["path"], message: "register requires path" });
    if (input.mode === "clone" && input.repo === undefined)
      ctx.addIssue({ code: "custom", path: ["repo"], message: "clone requires repo" });
  });

/** refine 済みの平らな入力を mode の分だけのフィールドに narrow する — 旧 union が
 *  他 mode のキーを黙って剥がしていた挙動を保つ。 */
function toCreateWorkspaceInput({ path, repo, ...rest }: z.infer<typeof createWorkspaceSchema>): CreateWorkspaceInput {
  if (rest.mode === "register") return { ...rest, mode: "register", path: path! };
  if (rest.mode === "clone") return { ...rest, mode: "clone", repo: repo! };
  return { ...rest, mode: "create" };
}

const agentFieldsSchema = z.object({
  authority: requiredTextSchema,
  description: requiredTextSchema,
  provider: requiredTextSchema,
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
    err instanceof GitDirNotADirectoryError ||
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

const QUESTION_ANNOTATIONS_DESCRIPTION =
  "A question also carries `landing` (null for a general question; for a landing question, `blocked_by` says why a `merge` answer would be rejected right now — `attached_children` or `objections` — or null when it would be accepted), `approval` (for a child-approval question, whether approving raises the parent's risk; otherwise null), `blocking` (the id of the parent task it holds up, or null), `moved` (for a memory proposal, one element per pinned entry moved since the proposal was shown: `id` is the entry as pinned, `tail_id` is where it lives now with its current `path` / `scope`, and an answer applies to `tail_id`), `needs_comment` (the answers that `answer_question` refuses without a non-blank comment; empty when every answer takes an optional one), and `free_text` (false when an answer must match one of the item's options verbatim; true when free text is accepted). A non-question task carries none of these.";

/** 結果を返し、DomainError は tool error にする。 */
const domainResult = (write: () => unknown) => {
  try {
    return toolResult(write());
  } catch (err) {
    if (err instanceof DomainError) return toolError(err.message);
    throw err;
  }
};

/** 予算と続きで読む口(ADR 0195): 最初の引数か続き(next)のどちらか一方から読みの位置を作り、`read` が詰めた応答を返す。
 *  続きは最初の引数を自分の中から戻すので渡し直しは要らない。 */
function readBudgeted<A extends Record<string, unknown>>(
  verb: string,
  { next, ...args }: A & { next?: string },
  read: (position: ReadPosition<A>) => Record<string, unknown>,
) {
  const given = Object.keys(args).filter((name) => args[name] !== undefined);
  if (next !== undefined && given.length > 0) return toolError(`pass ${given.join(", ")} or next, not both`);
  return domainResult(() => read(next === undefined ? { verb, args: args as unknown as A } : readNext<A>(verb, next)));
}

/** 書き込みの ack に載せる task の識別と状態(ADR 0195)。本文(purpose・完了基準・handoff など)は呼び手が持っているか get_task で読む。 */
const taskAck = ({ id, type, status, assignee, raw_assignee }: BoardTask) => ({ id, type, status, assignee, raw_assignee });
const TASK_ACK_DESCRIPTION = "Returns the task's id, type, status, assignee and raw_assignee only; read the rest with get_task.";

function buildManagementMcpServer(deps: ManagementMcpDeps): McpServer {
  const tierDescriptions = tierFieldDescriptions(deps.db);
  const server = floorEveryResponse(
    rejectUnknownArguments(
      new McpServer({ name: "tidepool-management", version: "0.0.0" }, { instructions: MANAGEMENT_MCP_INSTRUCTIONS }),
    ),
    { db: deps.db, clock: deps.clock, surface: "management" },
  );
  // issue #1179: 各口は対応する HTTP の口(GET /api/tasks・GET /api/tasks/:id)と同じ注釈を持つ
  server.registerTool(
    "list_board",
    {
      description: `List the current task board as \`tasks\`, in board order. ${nextDescription("list_board", "tasks")} ${QUESTION_ANNOTATIONS_DESCRIPTION}`,
      inputSchema: { next: z.string().optional() },
    },
    async (input) =>
      readBudgeted("list_board", input, (read) =>
        packItems(
          read,
          "tasks",
          listBoard(deps.db, deps.defaultAgentName, deps.auditorName).map((task) =>
            task.type === "question" ? { ...task, ...questionAnnotations(deps.db, task) } : task,
          ),
        ),
      ),
  );
  // ADR 0068 決定3: the envelope is this ADR's real fix — an agent reading the
  // queue here receives "why is it quiet" in the same one read, since MCP has
  // no banner channel to fill the gap.
  /** queue の skipped 表示を scheduler のゲートと同じ式から導く(ADR 0110 決定3)。 */
  const skippedByEntries = (deps: ManagementMcpDeps) =>
    entryExclusionPredicate(deps.db, deps.taskExecutionCandidates);

  server.registerTool(
    "list_queue",
    {
      description:
        "List the execution queue and pickup state: `halts` (and `teardown` while a session is being torn down) say why pickup " +
        `is waiting, \`tasks\` lists the queue in board order. ${nextDescription("list_queue", "tasks", "`halts` and `teardown` come")}`,
      inputSchema: { next: z.string().optional() },
    },
    async (input) =>
      readBudgeted("list_queue", input, (read) => {
        // 停止ではないが pickup を待たせているもの(ADR 0109 決定2)。列挙には加えない ——
        // ただし**落ちた**後始末は列挙の側にも出る(ADR 0112 決定1)。このフィールドが言う
        // のは「いつ後始末に入ったか」、列挙が言うのは「止まっている」で、同時に出る重複は
        // 承知の上である
        const teardown = sessionInTeardown(deps.db);
        const tasks = listQueue(
          deps.db,
          deps.workspace?.name,
          deps.defaultAgentName,
          deps.auditorName,
          quarantineStops(deps.db),
          skippedByEntries(deps),
        );
        return packItems(read, "tasks", tasks, { halts: boardHalts(deps.db), ...(teardown ? { teardown } : {}) });
      }),
  );
  server.registerTool("list_your_tasks", { description: "List unsettled tasks assigned to the human." }, async () =>
    toolResult(listYourTasks(deps.db)),
  );
  server.registerTool(
    "get_task",
    {
      description:
        "Get a task and its event history, newest first (event id descending). " +
        "When the history does not fit in one response, the response carries `next` and `remaining` (how many events are not returned yet): " +
        "call get_task again with only `next` to read the older events, and repeat until a response carries no `next` — then the history is complete. " +
        "The task itself comes on the first response only. An event too large for one response comes alone in pieces marked `partial` " +
        "(`id`, `field`, and `field_bytes`, the field's full size in UTF-8 bytes): join that field across the pieces to get it verbatim. " +
        QUESTION_ANNOTATIONS_DESCRIPTION,
      inputSchema: { task_id: z.string().optional(), next: z.string().optional() },
    },
    async (input) =>
      readBudgeted("get_task", input, (read) => {
        if (read.args.task_id === undefined) throw new DomainError("pass task_id, or next from a previous get_task");
        const task = getTask(deps.db, read.args.task_id);
        if (!task) throw new DomainError("task not found");
        const envelope = { ...presentTask(deps.db, task, deps.defaultAgentName, deps.auditorName), ...(task.type === "question" && questionAnnotations(deps.db, task)) };
        return packItems(read, "events", listEvents(deps.db, task.id).reverse(), envelope);
      }),
  );
  server.registerTool(
    "read_decision_log",
    {
      description:
        "Read the decision log without marking it seen, newest first (entry id descending). Each entry carries every objection ever " +
        "raised against it (bundled and still commit-pending alike). `cursor` is the human's unread cursor, unrelated to `next`. " +
        nextDescription("read_decision_log", "entries", "`cursor` comes"),
      inputSchema: { next: z.string().optional() },
    },
    async (input) =>
      readBudgeted("read_decision_log", input, (read) =>
        packItems(read, "entries", listLog(deps.db, deps.workspace?.name).reverse(), { cursor: getLogCursor(deps.db) }),
      ),
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
    async (args) => {
      if (!deps.workspaceAdmin?.create) return toolError("workspace administration is not configured");
      const input = toCreateWorkspaceInput(args);
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
        name: requiredTextSchema,
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
        name: requiredTextSchema,
        repo: requiredTextSchema,
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
      inputSchema: agentFieldsSchema.extend({ name: requiredTextSchema }),
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
      inputSchema: agentFieldsSchema.extend({ name: requiredTextSchema }),
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
      inputSchema: profileFieldsSchema.extend({ name: requiredTextSchema }),
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
      inputSchema: profileFieldsSchema.partial().extend({ name: requiredTextSchema }),
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
        "Read the board's execution settings: the model table (rows of provider, model, tier, effort, price_in / price_out in USD per MTok, " +
        "and quarantine_question_id — the open question naming a row the provider refused to run on this board, or null), " +
        "the advisor ceiling (off / sonnet / opus / fable / fable_then_opus), the Provider rank, the default priorities (quality / cost) — `priority` for work tasks that request none and `reviewPriority` for every review task — whether the learner is promoted, " +
        "the default tier (tasks requesting no tier whose agent declares none, and the board's drafts run on it), " +
        "the judgement tier — the board's own judgement tier, shared by its retrospective Board calls (allocation review, attribution, Behavior candidate drafting) and its periodic meta-reviews — " +
        "and the board's tiers in order (lowest first), each with its one-line description.",
    },
    async () => toolResult(readExecutionSettingsWithQuarantine(deps.db)),
  );
  server.registerTool(
    "change_execution_settings",
    {
      description:
        "Apply one change to the board's execution settings as the human: add a table row (`row`; a model has at most one row per tier and one per effort), edit one (`row` with `key`, " +
        "the provider + model + effort of the row to replace), delete one (`delete_row`, named by provider + model + effort — deleting " +
        "every row of a provider × tier just excludes that provider for tasks of that tier), " +
        "insert a tier (`insert_tier`: name — a lowercase letter, then a-z / 0-9 / - / _ — a one-line description, and position, an index into the tier list, 0 = lowest), " +
        "edit one (`edit_tier`, named by name: a new description and/or position), rename one (`rename_tier`: name, and to — the new name, checked like insert_tier's; " +
        "the board first rewrites every registry agent.md whose tier is the old name and commits it to the registry's remote main, and the rename is refused if that push fails), " +
        "delete one (`delete_tier`; refused with the reasons while the tier has table rows, " +
        "is the default or judgement tier, an unsettled task requests it, or a registry agent.md names it as its tier — and also refused if the registry cannot be read), " +
        "or set `advisor_ceiling` (`off` / `sonnet` / `opus` / `fable` / `fable_then_opus` — the highest model family an agent's advisor may climb to: " +
        "a main below it gets the ceiling's alias, a main in its family gets main's own id, a main above it runs without an advisor; " +
        "`off` runs every agent without one; `fable_then_opus` is `fable` that drops to `opus` while the Fable window is throttled), `provider_rank` (every provider exactly once, first = preferred), the default `priority` (quality / cost, for work tasks that request none), `review_priority` (quality / cost, how every review task orders its models), `default_tier` " +
        "(a tier name from the board's list — the tier of tasks that request none and whose agent declares none, and of the board's drafts), or `judgement_tier` " +
        "(a tier name from the board's list — the tier the board's own judgement runs on: retrospective Board calls resolve on its anthropic row, and periodic meta-reviews request it), " +
        "or demote the learner (`learner_promoted: false` — promotion only comes from approving a routing meta-review's proposal). " +
        "Takes effect at the next pickup or Board call.",
      inputSchema: { change: executionSettingsChangeSchema },
    },
    async ({ change }) => {
      try {
        await changeExecutionSettings(deps.db, change, "mcp", deps.clock.now(), deps.agentAdmin?.renameTier, deps.agentAdmin?.list);
      } catch (err) {
        if (err instanceof DomainError) return toolError(err.message);
        throw err;
      }
      deps.pollNow();
      return toolResult(readExecutionSettingsWithQuarantine(deps.db));
    },
  );
  server.registerTool(
    "read_memory_settings",
    {
      description:
        "Read the board's memory settings: injection_token_cap, the token cap on the memory section injected into a worker at spawn.",
    },
    async () => toolResult(readMemorySettings(deps.db)),
  );
  server.registerTool(
    "change_memory_settings",
    {
      description: `Change the board's memory settings as the human. injection_token_cap: a positive integer, counted with ${TOKENIZER.id}, takes effect at the next spawn.`,
      inputSchema: memorySettingsChangeSchema.shape,
    },
    async (change) => {
      changeMemorySettings(deps.db, change, "mcp", deps.clock.now());
      return toolResult(readMemorySettings(deps.db));
    },
  );
  server.registerTool(
    "read_meta_review_settings",
    {
      description:
        "Read the board's periodic meta-review settings: period_days, the minimum number of days between two periodic meta-reviews of the same subject (memory or routing).",
    },
    async () => toolResult(readMetaReviewSettings(deps.db)),
  );
  server.registerTool(
    "change_meta_review_settings",
    {
      description:
        "Change the board's periodic meta-review settings as the human. period_days: a positive integer, the minimum days between periodic meta-reviews of the same subject (memory or routing).",
      inputSchema: metaReviewSettingsChangeSchema.shape,
    },
    async (change) => {
      changeMetaReviewSettings(deps.db, change, "mcp", deps.clock.now());
      return toolResult(readMetaReviewSettings(deps.db));
    },
  );
  // spec #586 F / issue #593: the human's memory surface. No approve verb (ADR 0152):
  // wording the human writes here is approved on write, and AI-drafted wording is approved
  // only through a proposal question. Domain errors come back as tool errors (domainResult).
  const writtenAs =
    "Written as the human, approved at once. The original_* fields, when given, are the human's own wording, recorded in the " +
    "board's display language. workspace null = the whole board.";
  const supersedesEffect =
    "supersedes optionally lists approved entries the new one replaces: each is invalidated as superseded by it in the same step " +
    "(candidates are refused; Behavior and Exemplar entries replace each other, Knowledge and Definitions only their own kind).";
  server.registerTool(
    "list_memory_entries",
    {
      description:
        "List the board's memory entries, including candidates, invalidated ones (with invalidation_reason and successor_id) and the ids each entry replaced (replaced_ids). " +
        "workspace matches exactly; board_wide lists only board-wide entries; " +
        "state invalidated lists invalidated entries, approved / candidate the rest. On a board with a registry each entry carries orphaned: " +
        "\"addressee\", \"scope\" or \"both\" when its addressee agent or scope workspace is no longer registered, null otherwise. " +
        "path lists only the entries at that branch or under it (path/…). Entries come as `entries`, oldest first (id ascending). " +
        `${nextDescription("list_memory_entries", "entries")} \`next\` keeps the filters of the first call: pass it alone.`,
      inputSchema: memoryListFilterSchema.extend({ board_wide: z.boolean().optional(), next: z.string().optional() }).shape,
    },
    async (input) =>
      readBudgeted("list_memory_entries", input, (read) => {
        const { workspace, board_wide, ...filter } = read.args;
        return packItems(read, "entries", listMemoryEntriesForHuman(deps, { ...filter, scope: board_wide ? null : workspace }));
      }),
  );
  server.registerTool(
    "list_memory_branches",
    {
      description:
        `${MEMORY_BRANCHES_DESCRIPTION} Each Definition carries the human's original wording (original) when it has one. ` +
        nextDescription("list_memory_branches", "branches"),
      inputSchema: { next: z.string().optional() },
    },
    // 枝の行は id を持たない —— 続きの境目は path(木の中で1行1つ)
    async (input) => readBudgeted("list_memory_branches", input, (read) => packItems(read, "branches", listMemoryBranches(deps.db), {}, { keyOf: (row) => row.path })),
  );
  server.registerTool(
    "record_knowledge",
    {
      description: `Record a Knowledge entry: a fact filed under path (a "/"-separated hierarchy such as build/tests). title and text are the ` +
        `English canonical wording; original_title and original_text go together (both or neither). ${supersedesEffect} ${writtenAs}`,
      inputSchema: humanKnowledgeSchema.shape,
    },
    async (input) => domainResult(() => recordKnowledge(deps.db, gatedHumanEntryInput(deps, input), "mcp", deps.clock.now())),
  );
  server.registerTool(
    "define_memory_branch",
    {
      description:
        "Define a memory branch: one line at the branch's path declaring what is filed under it. A branch has one definition per " +
        "workspace: to revise it, include the current one in supersedes. supersedes lists definitions at this path only; a " +
        "definition at another path is refused. To rename a branch or merge two, use move_memory_branch. A workspace definition is " +
        "refused at a path that holds whole-board entries at or under it, and a whole-board entry at or under a path a workspace " +
        "defines: to clear the way, write a whole-board definition at that path with the workspace definitions in supersedes. text is the English " +
        "canonical line; original_text is optional. " +
        `${supersedesEffect} ${writtenAs}`,
      inputSchema: humanDefinitionSchema.shape,
    },
    async (input) => domainResult(() => defineMemoryBranch(deps.db, gatedHumanEntryInput(deps, input), "mcp", deps.clock.now())),
  );
  server.registerTool(
    "record_behavior",
    {
      description:
        "Record a Behavior entry: how agents should act, injected into the workers of addressee (an agent name, or null for every agent). " +
        "To edit an approved behavior, pass [its id] as supersedes. source_event_id optionally cites the episode the rule comes from: a " +
        "decision_logged or worker_spawned event id; without it the entry keeps the cited source the superseded entries share (one " +
        "superseded entry always shares its own), and cites none otherwise. title and text are the English canonical wording; " +
        `original_title and original_text go together (both or neither). ${supersedesEffect} ${writtenAs}`,
      inputSchema: humanBehaviorSchema.shape,
    },
    async (input) => domainResult(() => recordBehavior(deps.db, gatedHumanEntryInput(deps, input), "mcp", deps.clock.now())),
  );
  server.registerTool(
    "preview_case",
    {
      description:
        "Render the case an exemplar can cite: event_id is a decision_logged event (its decision text, the steering of its objections, " +
        "and its session's handoff and result) or a worker_spawned event (that session's decisions in order, handoff and result). An " +
        "objection_attributed event (the source an exemplar candidate may carry) renders its decision with only that attribution's steering. " +
        `steering and decisions come in event order. ${nextDescription("preview_case", "steering or decisions lines", "The rest of the case comes")}`,
      inputSchema: { event_id: z.number().int().positive().optional(), next: z.string().optional() },
    },
    async (input) =>
      readBudgeted("preview_case", input, (read) => {
        if (read.args.event_id === undefined) throw new DomainError("pass event_id, or next from a previous preview_case");
        // item は steering か decisions の文(文字列で id を持たない)。続きの境目は列の位置 —— どちらも event 順で積み足されるだけ
        const rendered = previewCase(deps.db, read.args.event_id);
        if ("decisions" in rendered) {
          const { decisions, ...envelope } = rendered;
          return packItems(read, "decisions", decisions, envelope, { keyOf: (_, i) => i });
        }
        const { steering, ...envelope } = rendered;
        return packItems(read, "steering", steering, envelope, { keyOf: (_, i) => i });
      }),
  );
  server.registerTool(
    "record_exemplar",
    {
      description:
        "Record an Exemplar entry: a concrete case agents should learn from, injected into the workers of addressee (an agent name, or null " +
        "for every agent). source_event_id is the case: a decision_logged or worker_spawned event id (see preview_case); it may be " +
        `omitted only with supersedes whose entries share one source, which the exemplar then keeps. ${supersedesEffect} annotations is a ` +
        "non-empty list; each has a polarity (imitate or avoid), an English text, an optional original (the human's own wording), and an " +
        "anchor: \"whole\" or { field, quote } where quote is a verbatim substring of that field (decision, steering, handoff or result) " +
        `of the rendered case. title is the English one-line label. Written as the human, approved at once; an annotation's original is ` +
        "recorded in the board's display language. workspace null = the whole board.",
      inputSchema: humanExemplarSchema.shape,
    },
    async (input) => domainResult(() => recordExemplar(deps.db, gatedHumanEntryInput(deps, input), "mcp", deps.clock.now())),
  );
  server.registerTool(
    "fold_memory_entries",
    {
      description:
        "Fold the entries in replaces into successor_id, an existing approved, non-invalidated entry: each is invalidated as superseded " +
        "by it and nothing new is written. Behavior and Exemplar entries fold into each other; Knowledge only into Knowledge and " +
        "a Definition only into the Definition at the same path in another workspace (merge branches at different paths with " +
        "move_memory_branch). replaces may hold candidates as well as approved entries: a candidate an approved entry " +
        "already covers retires pointing at it. To replace entries with one you write now, pass them as supersedes on the write.",
      inputSchema: memoryFoldSchema.shape,
    },
    async (input) => domainResult(() => foldMemoryEntries(deps.db, { ...input, author: HUMAN_AUTHOR }, "mcp", deps.clock.now())),
  );
  server.registerTool(
    "invalidate_memory_entry",
    {
      description:
        "Invalidate a memory entry with no successor, so it is no longer injected or pulled (nothing is deleted). reason is " +
        "capability (it was wrong), or environment / requirement_change (it went stale). To replace entries, pass them as " +
        "supersedes when you write the new one, or fold them into an existing entry with fold_memory_entries. To change where " +
        "an entry is filed, use move_memory_entry or move_memory_branch.",
      // strict な object ごと渡す —— .shape だと迷い込んだ successor_id が黙って捨てられる
      inputSchema: invalidationSchema.extend({ entry_id: z.number().int().positive() }),
    },
    async (input) => domainResult(() => ({ event_id: invalidateMemoryEntry(deps.db, input, HUMAN_WORKER_ID, "mcp", deps.clock.now()) })),
  );
  const moveEffect =
    "The board copies the body — title, text, originals, addressee, annotations, source, author, state and approval — to the new place " +
    "and invalidates the old entry as path_moved; you are recorded as the one who moved it. A candidate stays a candidate. " +
    "A Definition's path changes only with move_memory_branch, which carries the entries under it; move_memory_entry changes only its workspace.";
  server.registerTool(
    "move_memory_entry",
    {
      description:
        "Move one live memory entry (any kind, approved or candidate) to another workspace and path. workspace null = the whole board. " +
        "A Definition cannot move onto a path that already has a live Definition in that workspace: fold it into that one with " +
        `fold_memory_entries instead. ${moveEffect}`,
      inputSchema: memoryMoveSchema.extend({ entry_id: z.number().int().positive() }).shape,
    },
    async ({ entry_id, workspace, path }) =>
      domainResult(() => {
        assertMemoryReferencesKnown(deps, { workspace });
        return moveMemory(deps.db, { entry_id, scope: workspace, path, mover: HUMAN_AUTHOR }, "mcp", deps.clock.now());
      }),
  );
  server.registerTool(
    "move_memory_branch",
    {
      description:
        "Move a whole branch: every live entry in workspace (null = the whole board) whose path is path or under path/ moves to " +
        "to_workspace, with path's prefix replaced by to_path, in one step. Invalidated entries stay where they are. Moving a " +
        "whole-board branch to another whole-board path also carries every workspace's entries under path, each staying in its " +
        "workspace. When a moved Definition would land on a path already defined in its workspace, the move is refused and names " +
        "every such pair; pass merge: true to fold each of them into the Definition already there (the destination's wording " +
        "stays) and move the rest. merge: true is refused when no such pair exists. Returns moved and folded (how many entries " +
        "were moved and how many Definitions were folded) with to_workspace and to_path; read the moved entries with " +
        `list_memory_entries. ${moveEffect}`,
      inputSchema: memoryBranchMoveSchema.shape,
    },
    // 門は行き先だけ —— 移動元が消えた workspace の孤立を生きた置き場へ移せるように(ADR 0173 決定2)
    async ({ workspace, path, to_workspace, to_path, merge }) =>
      domainResult(() => {
        assertMemoryReferencesKnown(deps, { workspace: to_workspace });
        const { moved, folded } = moveMemoryBranch(deps.db, { scope: workspace, path, to_scope: to_workspace, to_path, merge, mover: HUMAN_AUTHOR }, "mcp", deps.clock.now());
        return { moved: moved.length, folded: folded.length, to_workspace, to_path };
      }),
  );
  server.registerTool(
    "restore_memory_entry",
    {
      description:
        "Restore an invalidated memory entry (any kind): the board copies its body — title, text, originals, addressee, annotations, " +
        "source, author and state — into a new entry at the same workspace and path; the old entry stays invalidated and you are recorded " +
        "as the one who restored it. An approved copy gets a new version. Refused for an entry invalidated as path_moved (move its copy " +
        "back, or restore the copy), while its successor — followed through any moves — is still live (invalidate that first), and for " +
        "a Definition whose branch already has a live Definition in that workspace.",
      inputSchema: { entry_id: z.number().int().positive() },
    },
    async ({ entry_id }) => domainResult(() => restoreMemoryEntry(deps.db, { entry_id, restorer: HUMAN_AUTHOR }, "mcp", deps.clock.now())),
  );
  server.registerTool(
    "list_halted_refires",
    {
      description:
        "List the retrospective Board calls the board stopped refiring after 3 failed calls since the last retry: allocation reviews " +
        "(refire allocation, target = the review's task_completed event id), Behavior drafts (refire draft, target = the attribution event id) " +
        "and second-round attributions (refire second_round, target = the id of the first objection event of the bundle — the objections one " +
        "triage session raised against the entry). An allocation row shows the review and the reviewed task; a draft or second-round row shows " +
        "the objected entry, its task, cause (the latest bundle's judgment; null = unattributed) and round. Every row shows the last failure's " +
        "reason and time. Rows come as `halted`: draft and second-round rows first, in the order of the objections they answer, " +
        `then allocation reviews. ${nextDescription("list_halted_refires", "rows")}`,
      inputSchema: { next: z.string().optional() },
    },
    // 行は id を持たない —— 続きの境目は refire と target の鍵(Retry / Dismiss が行を指すのと同じ)
    async (input) =>
      readBudgeted("list_halted_refires", input, (read) =>
        packItems(read, "halted", listHaltedRefires(deps.db), {}, { keyOf: (row) => `${row.refire}:${row.target}` }),
      ),
  );
  server.registerTool(
    "retry_halted_refire",
    {
      description:
        "Retry a halted refire (allocation review, Behavior draft or second-round attribution): the board fires it again at the next " +
        "pickup poll, up to 3 more failed calls. " +
        "Key it as list_halted_refires does (second_round: target = the bundle's first objection event id). Refused for anything not currently in list_halted_refires.",
      inputSchema: refireKeySchema.shape,
    },
    async (key) => domainResult(() => ({ event_id: markHaltedRefire(deps.db, "refire_retried", key, "mcp", deps.clock.now()) })),
  );
  server.registerTool(
    "dismiss_halted_refire",
    {
      description:
        "Dismiss a halted refire: it leaves the list and the board never fires it again (nothing to learn, you wrote the behavior yourself, " +
        "or the episode is not worth an allocation review). " +
        "Key it as list_halted_refires does (second_round: target = the bundle's first objection event id). Refused for anything not currently in list_halted_refires.",
      inputSchema: refireKeySchema.shape,
    },
    async (key) => domainResult(() => ({ event_id: markHaltedRefire(deps.db, "refire_dismissed", key, "mcp", deps.clock.now()) })),
  );
  server.registerTool(
    "rebuild_memory_index",
    { description: "Rebuild the memory entry table and its search index by replaying the board's memory events." },
    async () => toolResult({ event_id: rebuildMemoryIndex(deps.db, HUMAN_WORKER_ID, "mcp", deps.clock.now()) }),
  );
  server.registerTool(
    "cancel_task",
    {
      description: `Cancel a task and its unsettled descendants. The task must be human-authored, or a board-registered root other than a question. ${TASK_ACK_DESCRIPTION}`,
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
      return result.ok ? toolResult(taskAck(result.value)) : toolError(result.failure.error);
    },
  );
  server.registerTool(
    "edit_task",
    {
      description: "Edit the unconsumed fields of a human-authored task.",
      inputSchema: {
        task_id: z.string(),
        title: z.string().optional(),
        purpose: z.string().optional(),
        completion_criteria: z.string().optional(),
        assignee: z.string().optional(),
        workspace: z.string().optional(),
        risk_flag: z.boolean().optional(),
        review_flag: z.boolean().optional().describe(`${REVIEW_FLAG_ONLY_ON_WORK_CHILDREN}\n${JUDGED_AFTER_THE_EDIT}`),
        review_by: z.array(requiredTextSchema).optional()
          .describe(`${REVIEWER_NAMES} ${ONLY_WHERE_COMPLETION_REVIEW_FIRES}\n${JUDGED_AFTER_THE_EDIT}`),
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
            review_flag: z.boolean().optional().describe("Refused on a child assigned to human, whose completion raises no review."),
            tier: z.string().optional().describe(tierDescriptions.tier),
            review_by: z.array(requiredTextSchema).optional().describe(ONLY_WHERE_REVIEW_FIRES),
            review_tier: z.string().optional().describe(`${tierDescriptions.review_tier}\n${ONLY_WHERE_REVIEW_FIRES}`),
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
      description:
        "Complete a task assigned to the human, optionally with the handoff doc: " +
        describeHandoffFields() +
        `. ${TASK_ACK_DESCRIPTION}`,
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
      return result.ok ? toolResult(taskAck(result.value)) : toolError(result.failure.error);
    },
  );
  server.registerTool(
    "add_issue_comment",
    {
      description: "Add a human-approved comment to a GitHub issue.",
      inputSchema: {
        workspace: z.string(),
        github_issue_number: z.number().superRefine((value, ctx) => {
          const reason = whyNotPositiveInteger(value);
          if (reason) ctx.addIssue({ code: "custom", message: reason });
        }),
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
  // ADR 0111 追記10: review task の要求は review_tier だけ
  const WORK_TASKS_ONLY = "For work tasks only: refused on a review task, which takes review_tier instead.";
  server.registerTool(
    "register_task",
    {
      description: `Register a human work or review task, optionally backed by a GitHub issue. ${TASK_ACK_DESCRIPTION}`,
      inputSchema: {
        type: z.string(),
        title: z.string().optional(),
        purpose: z.string().optional(),
        completion_criteria: z.string().optional(),
        github_issue_number: z.number().superRefine((value, ctx) => {
          const reason = whyNotPositiveInteger(value);
          if (reason) ctx.addIssue({ code: "custom", message: reason });
        }).optional(),
        parent_id: z.string().optional(),
        assignee: z.string().optional(),
        workspace: z.string().optional(),
        risk_flag: z.boolean().optional(),
        review_flag: z.boolean().optional().describe(REVIEW_FLAG_ONLY_ON_WORK_CHILDREN),
        tier: z.string().optional().describe(`${tierDescriptions.tier}\n${WORK_TASKS_ONLY}`),
        review_by: z.array(requiredTextSchema).optional()
          .describe(`${REVIEWER_NAMES} Omit to use the board Auditor. ${ONLY_WHERE_COMPLETION_REVIEW_FIRES}`),
        review_tier: z.string().optional().describe(`${REVIEW_TIER_BY_TYPE}\n${tierDescriptions.review_tier_choices}`),
        priority: z.string().optional().describe(`${PRIORITY_FIELD_DESCRIPTION}\n${WORK_TASKS_ONLY}`),
        decompose_reason: z.string().optional(),
      },
    },
    async (input) => {
      const result = await registerThroughHumanDoor(
        deps,
        input as import("./human-verbs.js").HumanRegisterInput,
        () => deps.clock.now(),
        "mcp",
      );
      return result.ok ? toolResult(taskAck(result.task)) : toolError(JSON.stringify(result.failure));
    },
  );
  server.registerTool(
    "answer_question",
    {
      description:
        "Answer every item of a question task as the human. amendment is accepted only with approve: on a routing row proposal, " +
        "tier and/or effort to apply instead of the proposed values; on an agent tier proposal, to — any tier below the agent's current one; " +
        "on a memory approve or consolidate proposal, title, text and/or addressee (null = every agent) to approve instead of the candidate's, " +
        "with original_title + original_text together if you wrote it in another language; an exemplar candidate takes title, addressee " +
        "and/or annotations (the whole list, each quote verbatim in its case — see preview_case) instead of text and originals. An amended " +
        "memory approval is written as your own approved entry and supersedes the candidate. The answers in the question's needs_comment require a " +
        "non-blank comment: why for a reject on any proposal or approval question, what is still undecided for a defer on a memory proposal. Every other answer takes an optional comment.",
      inputSchema: answerInputSchema.extend({ task_id: z.string() }),
    },
    async ({ task_id, answers, comment, amendment }) => {
      const task = getTask(deps.db, task_id);
      if (!task) return toolError("task not found");
      try {
        return toolResult(
          await submitAnswer(
            deps,
            task,
            answers,
            comment,
            () => deps.clock.now(),
            "mcp",
            false,
            amendment,
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
