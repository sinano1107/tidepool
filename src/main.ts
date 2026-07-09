import { mkdirSync } from "node:fs";
import { ClaudeCodeWorker } from "./claude-worker.js";
import { SystemClock } from "./clock.js";
import { loadRegistry } from "./registry.js";
import { startServer, type WorkerFactory } from "./server.js";
import type { Task } from "./tasks.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";
import type { WorkspaceConfig } from "./workspace.js";

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
const registryDir = process.env.TIDEPOOL_REGISTRY;
const workspaceName = process.env.TIDEPOOL_WORKSPACE ?? "sandbox";

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
      agent: process.env.TIDEPOOL_AGENT ?? "deckhand",
      workspace: workspaceName,
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      logDir,
    });
}

/** The board's own view of the workspace (branch discipline + tree rule):
 *  the same registry entry the worker runs in, resolved to its path. */
function workspaceConfig(): WorkspaceConfig | undefined {
  if (!registryDir) return undefined;
  const entry = loadRegistry(registryDir).workspaces[workspaceName];
  if (!entry) throw new Error(`unknown workspace: ${workspaceName}`);
  return { name: workspaceName, path: entry.path };
}

const server = await startServer({
  dbPath: process.env.TIDEPOOL_DB ?? "board.sqlite",
  port,
  clock: new SystemClock(),
  worker: workerFactory(),
  workspace: workspaceConfig(),
});
console.log(`tidepool listening on http://127.0.0.1:${server.port}`);
