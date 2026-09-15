import { expect, it } from "vitest";
import type { ContainmentCapability } from "../src/containment.js";
import { openDb } from "../src/db.js";
import { startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { registerTask } from "../src/tasks.js";
import { FakeClock, fakeContainers, ScriptedWorker } from "./fakes.js";

/** ADR 0119 決定5: poll 中に届いた契機は捨てる(合体しない)。それで取りこぼさないのは、poll が
 *  最初の await より前に slot を読み、候補の読み取りを await の後に置いているからである ——
 *  この順序の不変条件を固定する。 */
it("poll が封じ込め検査の await に居る間に登録されたタスクは、その poll で拾われる", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  let release!: (capability: ContainmentCapability) => void;
  const scheduler = startScheduler({
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    containment: () => new Promise((resolve) => (release = resolve)),
  });

  // 空のキューで poll を撃ち、封じ込め検査の await で止める
  scheduler.pollNow();
  // その poll の最中に登録が届く。登録が撃つ契機は inFlight で捨てられる
  const task = registerTask(
    db,
    { type: "work", title: "arrived mid-poll", purpose: "p", completion_criteria: "c" },
    clock.now(),
  );
  scheduler.pollNow();
  release({ available: true });
  await new Promise((resolve) => setImmediate(resolve));

  expect(worker.started.map((t) => t.id)).toEqual([task.id]);
  scheduler.stop();
});
