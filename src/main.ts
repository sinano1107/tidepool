import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutionAgent, UnknownAgentError } from "./agent.js";
import { type AgentAdmin, createAgent, listAgentViews, updateAgent } from "./agent-create.js";
import { ClaudeDraftClient } from "./claude-draft-client.js";
import { ClaudeTranslationClient } from "./claude-translation-client.js";
import { ClaudeCodeWorker, enumerateHostSkills } from "./claude-worker.js";
import { SystemClock } from "./clock.js";
import type { DraftClient } from "./draft.js";
import { GhCliClient } from "./github.js";
import { loadGitHubAuth } from "./github-auth.js";
import { parseGlossary } from "./glossary.js";
import {
  createProfile,
  listProfileViews,
  type ProfileAdmin,
  updateProfile,
} from "./profile-create.js";
import { type PushClient, type VapidConfig, WebPushClient } from "./push.js";
import {
  type AuthorityProfile,
  loadRegistry,
  ownEntry,
  type RegistryCandidates,
  type RosterAgent,
} from "./registry.js";
import { startServer, type WorkerFactory } from "./server.js";
import { DEFAULT_AUDITOR_NAME, type Task } from "./tasks.js";
import type { TranslationClient } from "./translate.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";
import {
  resolveExecutionWorkspace,
  resolveWorkspacesBaseDir,
  type WorkspaceConfig,
} from "./workspace.js";
import {
  createWorkspace,
  listWorkspaceViews,
  updateWorkspace,
  type WorkspaceAdmin,
} from "./workspace-create.js";

/** Fallback when no registry clone is configured: logs the pickup so a human
 *  can drive the MCP verbs by hand. */
class LoggingWorker implements WorkerAdapter {
  readonly id = "logging-worker";
  start(task: Task): void {
    console.log(`[worker] picked up ${task.id}: ${task.title}`);
  }
  kill(taskId: string, signal: KillSignal): void {
    console.log(`[worker] would send ${signal} to ${taskId}`);
  }
  /** No registry means no real adapter behind this — report a well-under-
   *  threshold reading so pickup logging is never fail-closed by a check
   *  this placeholder cannot actually perform. */
  async checkUsage(): Promise<string | null> {
    return (
      "Current session\n0% used\nResets 12:00am (UTC)\n" +
      "Current week (all models)\n0% used\nResets Jan 1 at 12:00am (UTC)\n"
    );
  }
}

const port = Number(process.env.PORT ?? 4589);
// /mcp's own 127.0.0.1-only port (issue #37) — kept off `port` so
// `tailscale serve <port>` never also publishes MCP tool calls
const mcpPort = Number(process.env.MCP_PORT ?? port + 1);
const registryDir = process.env.TIDEPOOL_REGISTRY;
const workspaceName = process.env.TIDEPOOL_WORKSPACE ?? "sandbox";
// ADR 0018: base directory a path-omitting workspace entry derives from.
const workspacesDir = resolveWorkspacesBaseDir(process.env.TIDEPOOL_WORKSPACES_DIR);
// ADR 0012 / issue #36: TIDEPOOL_AGENT is a pointer to the board's default
// agent, not "the one worker" — an unspecified assignee resolves here, but a
// pre-set delegation to a different registry name overrides it per task
const defaultAgentName = process.env.TIDEPOOL_AGENT ?? "tako";
// issue #15 layer 2 / CONTEXT.md's Auditor: same shape as TIDEPOOL_AGENT
// above, a pointer to the board's independent-review agent.
const auditorName = process.env.TIDEPOOL_AUDITOR ?? DEFAULT_AUDITOR_NAME;

/** TIDEPOOL_REGISTRY points at a local clone of the agent registry repository
 *  (`npm run start:live` supplies the conventional one); setting it swaps the
 *  logging placeholder for the real Claude Code worker. */
function workerFactory(): WorkerFactory {
  if (!registryDir) return () => new LoggingWorker();
  const logDir = process.env.TIDEPOOL_WORKER_LOGS ?? "worker-logs";
  mkdirSync(logDir, { recursive: true });
  return ({ db, clock }) =>
    new ClaudeCodeWorker({
      db,
      clock,
      registryDir,
      agent: defaultAgentName,
      auditorName,
      workspace: workspaceName,
      workspacesDir,
      mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
      logDir,
    });
}

/** The board's own view of the workspace (branch discipline + tree rule):
 *  the same registry entry the worker runs in, resolved to its path. */
function workspaceConfig(): WorkspaceConfig | undefined {
  if (!registryDir) return undefined;
  return resolveExecutionWorkspace(loadRegistry(registryDir), workspaceName, null, workspacesDir);
}

/** Resolves any task's execution workspace against the registry (issue #26 /
 *  ADR 0009): read fresh every call, never pinned to a path at pickup. Absent
 *  → every task runs against the single `workspaceConfig()` above (no
 *  registry configured at all). */
function workspaceResolver(): ((taskWorkspace: string | null) => WorkspaceConfig) | undefined {
  if (!registryDir) return undefined;
  return (taskWorkspace) =>
    resolveExecutionWorkspace(loadRegistry(registryDir), workspaceName, taskWorkspace, workspacesDir);
}

/** fable モデルに解決される agent 名の集合 (ADR 0030)、毎 poll registry から
 *  読み直す。CLI の --model は開かれた文字列("fable" でも "claude-fable-5"
 *  でも通る)なので、部分一致で fable 系と判定する。default agent が fable
 *  なら assignee 未設定のタスクもここに含まれる名前へ解決される(SQL 側の
 *  COALESCE)。registry なし → fable 判定は不可能、skip なし。 */
function fableAgentsResolver(): (() => string[]) | undefined {
  if (!registryDir) return undefined;
  return () =>
    Object.values(loadRegistry(registryDir).agents)
      .filter((agent) => agent.model?.toLowerCase().includes("fable"))
      .map((agent) => agent.name);
}

/** Resolves the executing task's own agent's authority profile (ADR 0012 /
 *  issue #36), read fresh against the registry every call from the task's own
 *  `assignee` (null → the board's default agent, `TIDEPOOL_AGENT`) — the
 *  delegation-aware successor to a single board-wide fixed profile, which
 *  every task shared regardless of who it was actually assigned to. An
 *  assignee the registry no longer knows (drift since the owning task's own
 *  session spawned) falls back to unrestricted here rather than throwing —
 *  the spawn-time gate (ClaudeCodeWorker.start) is what quarantines that.
 *  Without a registry, no agent's authority is knowable at all — unrestricted. */
function authorityResolver(): ((assignee: string | null) => AuthorityProfile | undefined) | undefined {
  if (!registryDir) return undefined;
  return (assignee) => {
    try {
      return resolveExecutionAgent(loadRegistry(registryDir), defaultAgentName, assignee).profile;
    } catch (err) {
      if (!(err instanceof UnknownAgentError)) throw err;
      return undefined;
    }
  };
}

/** Whether an agent name is currently registered (ADR 0012 / issue #36), read
 *  fresh against the registry — one half of an agent quarantine Confirmation
 *  question's clearance check (api.ts). Without a registry, no name is ever
 *  "back" — only "no more todo tasks depend on it" can clear it. */
function agentRegisteredChecker(): ((name: string) => boolean) | undefined {
  if (!registryDir) return undefined;
  // ownEntry, not `in`: `in` walks the prototype chain, so a name like
  // "toString" would clear an agent quarantine without any repair (issue #69)
  return (name) => ownEntry(loadRegistry(registryDir).agents, name) !== undefined;
}

/** Whether an explicitly named workspace is protected (issue #15 layer 2 /
 *  ADR 0013), read fresh against the registry — a decompose child naming a
 *  protected workspace converts to an approval question unconditionally
 *  (mcp.ts), and a task executing against one always asks before merging its
 *  PR (tasks.ts's recordPrOpened), regardless of the registering/executing
 *  worker's authority profile. Without a registry, no workspace is ever
 *  protected. */
function protectedWorkspaceChecker(): ((name: string) => boolean) | undefined {
  if (!registryDir) return undefined;
  // ownEntry for consistency with issue #69's sweep — a prototype hit would
  // already answer "not protected", but bare bracket access on registry
  // records is the exact pattern the sweep exists to remove
  return (name) => ownEntry(loadRegistry(registryDir).workspaces, name)?.protected === true;
}

/** The pull half of the roster (issue #43 / ADR 0014), read fresh against the
 *  registry — same pattern as agentRegisteredChecker. Without a registry
 *  there's nothing to list beyond list_agents's own fixed `human` line. */
function listAgentsResolver(): (() => RosterAgent[]) | undefined {
  if (!registryDir) return undefined;
  return () =>
    Object.values(loadRegistry(registryDir).agents).map((agent) => ({
      name: agent.name,
      description: agent.description,
    }));
}

/** Assignee/workspace candidates for the registration screen (issue #12).
 *  Without a registry there's nothing to suggest from. */
function registryCandidates(): RegistryCandidates | undefined {
  if (!registryDir) return undefined;
  const registry = loadRegistry(registryDir);
  const icons: Record<string, string> = {};
  for (const agent of Object.values(registry.agents)) {
    if (agent.icon !== undefined) icons[agent.name] = agent.icon;
  }
  return {
    assignees: [...Object.keys(registry.agents), "human"],
    workspaces: Object.keys(registry.workspaces),
    icons,
  };
}

/** DraftClient (issue #12's brain-dump-to-fields LLM draft), wired to the
 *  real Claude CLI (issue #25) only when a registry is configured — same
 *  registryDir gate as workerFactory() above. Without it there's no worker
 *  either, so the board runs the LoggingWorker with drafting off too. */
function draftClientFactory(): DraftClient | undefined {
  if (!registryDir) return undefined;
  return new ClaudeDraftClient({ candidates: registryCandidates() });
}

// this board's own CONTEXT.md (issue #47): resolved against the module's own
// file location, not process.cwd(), so it finds the checkout regardless of
// where the process was launched from — same posture as server.ts's static
// `root` (dirname(fileURLToPath(import.meta.url)) + "..").
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** CONTEXT.md's own `## Term(日本語)` pairs (issue #47), parsed once at boot
 *  for the translation client's prompt. Absent/unreadable CONTEXT.md → no
 *  glossary guidance rather than a boot failure — the glossary sharpens
 *  translation quality, it isn't required for the feature to function. */
function boardGlossary(): ReturnType<typeof parseGlossary> {
  try {
    return parseGlossary(readFileSync(join(repoRoot, "CONTEXT.md"), "utf8"));
  } catch {
    return [];
  }
}

/** TranslationClient (issue #47 / ADR 0015's display-time translation),
 *  wired to the real Claude CLI. Unlike draftClientFactory, this needs no
 *  registry — only the `claude` CLI and the board's own CONTEXT.md — so it's
 *  always configured, never gated. */
function translationClientFactory(): TranslationClient {
  return new ClaudeTranslationClient({ glossary: boardGlossary() });
}

/** Web Push (issue #14): all three VAPID env vars must be set together, or
 *  push stays off — a partial configuration would silently drop every send.
 *  The single source both pushClient() and the API's vapidPublicKey option
 *  read from, so the "all three or none" gate is never checked twice. */
function vapidConfig(): VapidConfig | undefined {
  const subject = process.env.TIDEPOOL_VAPID_SUBJECT;
  const publicKey = process.env.TIDEPOOL_VAPID_PUBLIC_KEY;
  const privateKey = process.env.TIDEPOOL_VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) return undefined;
  return { subject, publicKey, privateKey };
}

function pushClient(): PushClient | undefined {
  const vapid = vapidConfig();
  return vapid ? new WebPushClient(vapid) : undefined;
}

// ADR 0024 / issue #50: the board's GitHub identity is the machine-user token
// in this mode-600 secrets file — no file, no identity, and every GitHub
// feature stays fail-closed off (the optional `github` shape below). The
// token itself never enters process.env: workers inherit that wholesale.
const githubAuth = loadGitHubAuth(process.env.TIDEPOOL_GITHUB_TOKEN_FILE);
const github = githubAuth && new GhCliClient(githubAuth);

/** The settings surface's workspace verbs (issue #57), bound to this board's
 *  registry clone, base dir (ADR 0018) and GitHub client here at the
 *  composition root — the API layer only ever sees the finished callbacks.
 *  Without a registry there is nowhere to administer workspaces at all. */
function workspaceAdmin(): WorkspaceAdmin | undefined {
  if (!registryDir) return undefined;
  const deps = { registryDir, workspacesBaseDir: workspacesDir, githubAuth };
  return {
    create: (input) => createWorkspace(input, { ...deps, github }),
    list: () => listWorkspaceViews(deps),
    update: (input) => updateWorkspace(input, deps),
  };
}

/** The settings surface's agent verbs (issue #71), workspaceAdmin's twin:
 *  bound to this board's registry clone here at the composition root — the
 *  API layer only ever sees the finished callbacks. Without a registry there
 *  is nowhere to administer agents at all. */
function agentAdmin(): AgentAdmin | undefined {
  if (!registryDir) return undefined;
  const deps = { registryDir, githubAuth };
  return {
    create: (input) => createAgent(input, deps),
    list: () => listAgentViews(deps),
    update: (input) => updateAgent(input, deps),
    // registry-global, not per-agent (issue #71) — read directly here, same
    // posture as registryCandidates()/agentRegisteredChecker() above
    authorityProfiles: () => Object.keys(loadRegistry(registryDir).authority),
  };
}

/** The settings surface's profile verbs (issue #77), agentAdmin's twin: bound
 *  to this board's registry clone here at the composition root. The API layer
 *  runs the confirmation gate; these verbs only persist. Without a registry
 *  there is nowhere to administer profiles at all. */
function profileAdmin(): ProfileAdmin | undefined {
  if (!registryDir) return undefined;
  const deps = { registryDir, githubAuth };
  return {
    create: (input) => createProfile(input, deps),
    list: () => listProfileViews(deps),
    update: (input) => updateProfile(input, deps),
  };
}

const server = await startServer({
  dbPath: process.env.TIDEPOOL_DB ?? "board.sqlite",
  port,
  mcpPort,
  clock: new SystemClock(),
  worker: workerFactory(),
  workspace: workspaceConfig(),
  resolveWorkspace: workspaceResolver(),
  github,
  workspaceAdmin: workspaceAdmin(),
  agentAdmin: agentAdmin(),
  profileAdmin: profileAdmin(),
  resolveAuthority: authorityResolver(),
  agentRegistered: agentRegisteredChecker(),
  isProtectedWorkspace: protectedWorkspaceChecker(),
  listAgents: listAgentsResolver(),
  // pass the provider itself, not a boot-time snapshot: the register screen's
  // candidates must reflect agents/workspaces created live through settings
  registryCandidates: registryCandidates,
  draftClient: draftClientFactory(),
  translationClient: translationClientFactory(),
  push: pushClient(),
  vapidPublicKey: vapidConfig()?.publicKey,
  auditorName,
  // the skills picker's candidate source (issue #106): the real `claude` CLI's
  // neutral-cwd enumeration — always available on a real host, faked in tests
  hostSkills: enumerateHostSkills,
  fableAgents: fableAgentsResolver(),
});
console.log(`tidepool listening on http://127.0.0.1:${server.port}`);
console.log(`  /mcp listening on http://127.0.0.1:${server.mcpPort}/mcp`);
