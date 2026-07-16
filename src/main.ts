import { mkdirSync } from "node:fs";
import { resolveExecutionAgent, UnknownAgentError } from "./agent.js";
import { ClaudeDraftClient } from "./claude-draft-client.js";
import { ClaudeCodeWorker } from "./claude-worker.js";
import { SystemClock } from "./clock.js";
import type { DraftClient } from "./draft.js";
import { GhCliClient } from "./github.js";
import { type PushClient, type VapidConfig, WebPushClient } from "./push.js";
import {
  loadRegistry,
  type AuthorityProfile,
  type RegistryCandidates,
  type RosterAgent,
} from "./registry.js";
import { startServer, type WorkerFactory } from "./server.js";
import { DEFAULT_AUDITOR_NAME, type Task } from "./tasks.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";
import {
  resolveExecutionWorkspace,
  resolveWorkspacesBaseDir,
  type WorkspaceConfig,
} from "./workspace.js";

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
      "Current session: 0% used · resets Jan 1 at 12:00am (UTC)\n" +
      "Current week (all models): 0% used · resets Jan 1 at 12:00am (UTC)\n"
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
const defaultAgentName = process.env.TIDEPOOL_AGENT ?? "deckhand";
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
  return (name) => name in loadRegistry(registryDir).agents;
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
  return (name) => loadRegistry(registryDir).workspaces[name]?.protected === true;
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
  return {
    assignees: [...Object.keys(registry.agents), "human"],
    workspaces: Object.keys(registry.workspaces),
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

const server = await startServer({
  dbPath: process.env.TIDEPOOL_DB ?? "board.sqlite",
  port,
  mcpPort,
  clock: new SystemClock(),
  worker: workerFactory(),
  workspace: workspaceConfig(),
  resolveWorkspace: workspaceResolver(),
  github: new GhCliClient(),
  resolveAuthority: authorityResolver(),
  agentRegistered: agentRegisteredChecker(),
  isProtectedWorkspace: protectedWorkspaceChecker(),
  listAgents: listAgentsResolver(),
  registryCandidates: registryCandidates(),
  draftClient: draftClientFactory(),
  push: pushClient(),
  vapidPublicKey: vapidConfig()?.publicKey,
  auditorName,
});
console.log(`tidepool listening on http://127.0.0.1:${server.port}`);
console.log(`  /mcp listening on http://127.0.0.1:${server.mcpPort}/mcp`);
