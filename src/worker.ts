import type { Task } from "./tasks.js";

/** The watchdog's closed reclaim vocabulary (#9): SIGTERM first, SIGKILL
 *  after grace. Named here so it isn't repeated as a raw union at every
 *  WorkerAdapter implementation and fake. */
export type KillSignal = "SIGTERM" | "SIGKILL";

/** Boundary between the board and whatever executes tasks (design principle 7:
 *  the board speaks tasks; adapters speak vendors). The real adapter spawns a
 *  Claude Code child process; tests substitute a scripted fake here. */
export interface WorkerAdapter {
  /** Worker id recorded as the task assignee. */
  readonly id: string;
  /** Fire-and-forget: the worker acts back on the board via MCP. */
  start(task: Task): void;
  /** Signal the process running `taskId`, if any. The watchdog owns the
   *  SIGTERM → grace → SIGKILL timing (#9); the adapter only delivers. A
   *  signal to an unknown/already-gone task is a no-op. */
  kill(taskId: string, signal: KillSignal): void;
}
