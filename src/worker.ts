import type { Harness } from "./registry.js";
import type { Task } from "./tasks.js";

/** The watchdog's closed reclaim vocabulary (#9): SIGTERM first, SIGKILL
 *  after grace. Named here so it isn't repeated as a raw union at every
 *  WorkerAdapter implementation and fake. */
export type KillSignal = "SIGTERM" | "SIGKILL";

/** Boundary between the board and whatever executes tasks (design principle 7:
 *  the board speaks tasks; adapters speak vendors). The real adapter spawns a
 *  Claude Code child process; tests substitute a scripted fake here. */
export interface WorkerAdapter {
  /** The board's default agent name (ADR 0012 / issue #36) — a pointer to
   *  whichever registry agent an unspecified assignee resolves to, not "the
   *  one worker" (that concept doesn't exist: slot is capacity, not
   *  identity). Used as the pickup/spawn-time fallback and as the
   *  attribution on events an unspecified assignee's task generates; never
   *  written onto a task's own `assignee` column. */
  readonly id: string;
  /** Fire-and-forget: the worker acts back on the board via MCP. */
  start(task: Task): void;
  /** Signal the process running `taskId`, if any. The watchdog owns the
   *  SIGTERM → grace → SIGKILL timing (#9); the adapter only delivers. A
   *  signal to an unknown/already-gone task is a no-op. */
  kill(taskId: string, signal: KillSignal): void;
  /** Just-in-time usage check (ADR 0008): the raw `result` text of
   *  `claude -p "/usage" --output-format json`, or null if the check itself
   *  failed (spawn error, non-zero exit, unparseable JSON). The scheduler
   *  treats a null the same as an unrecognized snapshot — fail-closed. */
  checkUsage(): Promise<string | null>;
}

/** The board-facing adapter that selects the one canonical Harness for a
 *  picked task. Each vendor adapter keeps its own live root child; broadcasting
 *  kill is safe because WorkerAdapter.kill is a no-op for unknown task ids and
 *  avoids a second routing table that could drift from process reality. */
export class CanonicalWorkerRouter implements WorkerAdapter {
  readonly id: string;
  private readonly resolveHarness: (task: Task) => Harness;
  private readonly adapters: Record<Harness, WorkerAdapter>;

  constructor(options: {
    id: string;
    resolveHarness: (task: Task) => Harness;
    adapters: Record<Harness, WorkerAdapter>;
  }) {
    this.id = options.id;
    this.resolveHarness = options.resolveHarness;
    this.adapters = options.adapters;
  }

  start(task: Task): void {
    this.adapters[this.resolveHarness(task)].start(task);
  }

  kill(taskId: string, signal: KillSignal): void {
    for (const adapter of Object.values(this.adapters)) adapter.kill(taskId, signal);
  }

  /** Provider-specific usage selection belongs to #454. Until that slice,
   *  preserve the existing Claude board usage observation unchanged. */
  checkUsage(): Promise<string | null> {
    return this.adapters["claude-code"].checkUsage();
  }
}
