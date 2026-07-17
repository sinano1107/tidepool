import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { registerTask } from "../src/tasks.js";
import type { Task } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import { FakeClock, NOT_THROTTLED_USAGE_TEXT } from "./fakes.js";

it("worker.start の throw はボードを落とさない: タスクは slot を保持したまま残る(解放経路は #9)", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const started: string[] = [];
  const worker: WorkerAdapter = {
    id: "broken-worker",
    start(task: Task): void {
      started.push(task.id);
      throw new Error("registry went bad after boot");
    },
    kill(): void {},
    async checkUsage() {
      return NOT_THROTTLED_USAGE_TEXT;
    },
  };
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c" },
    clock.now(),
  );
  const scheduler = startScheduler({ db, clock, slot, worker });

  // the tick that hits the throwing worker must not propagate the crash
  await expect(clock.advance(HOURLY)).resolves.toBeUndefined();
  expect(started).toEqual([task.id]);
  // same deliberate wedge as a restart-interrupted task: the slot stays
  // occupied so nothing else runs beside the half-started task
  expect(slot.currentTaskId).toBe(task.id);

  // and the next tick does not double-pick
  await clock.advance(HOURLY);
  expect(started).toEqual([task.id]);
  scheduler.stop();
});
