import type { Clock } from "../src/clock.js";
import type { Task } from "../src/tasks.js";
import type { KillSignal, WorkerAdapter } from "../src/worker.js";

/** A reading well under the default threshold — the harness default so tests
 *  unrelated to throttling never need to script usage themselves. */
const NOT_THROTTLED_USAGE_TEXT =
  "Current session: 0% used · resets Jan 1 at 12:00am (UTC)\n" +
  "Current week (all models): 0% used · resets Jan 1 at 12:00am (UTC)\n";

interface ScheduledInterval {
  fn: () => void;
  ms: number;
  nextAt: number;
  cancelled: boolean;
}

/** Deterministic clock: time moves only when the test calls advance(). */
export class FakeClock implements Clock {
  private t = 0;
  private intervals: ScheduledInterval[] = [];

  now(): Date {
    return new Date(this.t);
  }

  setInterval(fn: () => void, ms: number): () => void {
    const entry: ScheduledInterval = { fn, ms, nextAt: this.t + ms, cancelled: false };
    this.intervals.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = this.intervals
        .filter((i) => !i.cancelled && i.nextAt <= target)
        .sort((a, b) => a.nextAt - b.nextAt)[0];
      if (!due) break;
      this.t = due.nextAt;
      due.nextAt += due.ms;
      due.fn();
      // let async effects of the tick settle before firing the next one
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.t = target;
  }
}

/** Scripted stand-in at the WorkerAdapter seam: records what it was asked to
 *  start and killed, in call order. */
export class ScriptedWorker implements WorkerAdapter {
  readonly id = "fake-worker";
  readonly started: Task[] = [];
  readonly killed: Array<{ taskId: string; signal: KillSignal }> = [];
  private usageText: string | null = NOT_THROTTLED_USAGE_TEXT;

  start(task: Task): void {
    this.started.push(task);
  }

  kill(taskId: string, signal: KillSignal): void {
    this.killed.push({ taskId, signal });
  }

  async checkUsage(): Promise<string | null> {
    return this.usageText;
  }

  /** Scripts what the next checkUsage() call(s) return (ADR 0008) — the same
   *  seam the real ClaudeCodeWorker's `/usage` JIT poll returns through. Pass
   *  null to script a check failure (fail-closed). */
  scriptUsage(resultText: string | null): void {
    this.usageText = resultText;
  }
}
