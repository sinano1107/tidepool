import { mkdirSync } from "node:fs";
import { ClaudeCodeWorker } from "./claude-worker.js";
import { SystemClock } from "./clock.js";
import { startServer, type WorkerFactory } from "./server.js";
import type { Task } from "./tasks.js";
import type { WorkerAdapter } from "./worker.js";

/** Fallback when no registry clone is configured: logs the pickup so a human
 *  can drive the MCP verbs by hand. */
class LoggingWorker implements WorkerAdapter {
  readonly id = "logging-worker";
  start(task: Task): void {
    console.log(`[worker] picked up ${task.id}: ${task.title}`);
  }
}

const port = Number(process.env.PORT ?? 4589);

/** TIDEPOOL_REGISTRY points at a local clone of the agent registry repository;
 *  setting it swaps the logging placeholder for the real Claude Code worker. */
function makeWorker(): WorkerAdapter | WorkerFactory {
  const registryDir = process.env.TIDEPOOL_REGISTRY;
  if (!registryDir) return new LoggingWorker();
  const logDir = process.env.TIDEPOOL_WORKER_LOGS ?? "worker-logs";
  mkdirSync(logDir, { recursive: true });
  return ({ db, clock }) =>
    new ClaudeCodeWorker({
      db,
      clock,
      registryDir,
      agent: process.env.TIDEPOOL_AGENT ?? "deckhand",
      workspace: process.env.TIDEPOOL_WORKSPACE ?? "sandbox",
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      logDir,
    });
}

const server = await startServer({
  dbPath: process.env.TIDEPOOL_DB ?? "board.sqlite",
  port,
  clock: new SystemClock(),
  worker: makeWorker(),
});
console.log(`tidepool listening on http://127.0.0.1:${server.port}`);
