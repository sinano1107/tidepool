import { SystemClock } from "./clock.js";
import { startServer } from "./server.js";
import type { Task } from "./tasks.js";
import type { WorkerAdapter } from "./worker.js";

/** Placeholder until the Claude-Code-worker adapter slice: logs the pickup so a
 *  human can drive the MCP verbs by hand. */
class LoggingWorker implements WorkerAdapter {
  readonly id = "logging-worker";
  start(task: Task): void {
    console.log(`[worker] picked up ${task.id}: ${task.title}`);
  }
}

const server = await startServer({
  dbPath: process.env.TIDEPOOL_DB ?? "board.sqlite",
  port: Number(process.env.PORT ?? 4589),
  clock: new SystemClock(),
  worker: new LoggingWorker(),
});
console.log(`tidepool listening on http://127.0.0.1:${server.port}`);
