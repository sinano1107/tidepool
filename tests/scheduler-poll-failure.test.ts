import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { setPaused } from "../src/pause.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { registerTask } from "../src/tasks.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { HUMAN_WEBUI, unhandledRejectionsDuring } from "./harness.js";

/** ADR 0294 決定1: slot を握る前の poll の想定外の例外は盤面を落とさず、「最後の poll の失敗」の行に残して次の poll に任せる。 */
function board(overrides: Partial<Parameters<typeof startScheduler>[0]> = {}) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const candidates = implicitTaskExecutionCandidates(db);
  const state = { broken: true, calls: 0 };
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: async () => [],
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: () => {},
    taskExecutionCandidates: (task) => {
      state.calls++;
      if (state.broken) throw new Error("registry is broken");
      return candidates(task);
    },
    ...overrides,
  });
  registerTask(db, { type: "work", title: "head", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);
  return { db, clock, worker, scheduler, state };
}

it("候補の読みが投げても unhandledRejection は撃たれず、次の tick も本体に入り、最後の poll の失敗が時刻と本文で残る", async () => {
  const { clock, worker, scheduler, state } = board();

  const rejections = await unhandledRejectionsDuring(async () => {
    await clock.advance(HOURLY);
    await clock.advance(HOURLY);
  });

  expect(rejections).toEqual([]);
  expect(state.calls).toBe(2);
  expect(worker.started).toEqual([]);
  expect(scheduler.lastPollFailure()).toEqual({ at: clock.now().toISOString(), message: "registry is broken" });
  scheduler.stop();
});

it("門で返った poll(Pause)は行を残し、Pause を解いて本体に入った poll が投げずに終われば行は消える", async () => {
  const { db, clock, worker, scheduler, state } = board();
  await clock.advance(HOURLY);
  const failure = scheduler.lastPollFailure();

  setPaused(db, true);
  await clock.advance(HOURLY);
  expect(scheduler.lastPollFailure()).toEqual(failure);

  setPaused(db, false);
  state.broken = false;
  await clock.advance(HOURLY);
  expect(worker.started.map((t) => t.title)).toEqual(["head"]);
  expect(scheduler.lastPollFailure()).toBeUndefined();
  scheduler.stop();
});

it("後始末の一撃そのものが投げても process は生きて行が残り、一撃は撃ち直されない(ADR 0294 決定5)", async () => {
  let shots = 0;
  const { clock, worker, scheduler, state } = board({
    onSpawnFailed: () => {
      shots++;
      throw new Error("teardown one-shot blew up");
    },
  });
  state.broken = false;
  worker.scriptStartFailure(new Error("spawn blew up"));

  const rejections = await unhandledRejectionsDuring(async () => {
    await clock.advance(HOURLY);
    await clock.advance(HOURLY);
  });

  expect(rejections).toEqual([]);
  expect(shots).toBe(1);
  expect(scheduler.lastPollFailure()?.message).toBe("teardown one-shot blew up");
  scheduler.stop();
});

it("pickup の契機で収束が reject しても unhandledRejection は撃たれない", async () => {
  const { scheduler } = board({
    converge: async () => {
      throw new Error("convergence blew up");
    },
  });

  const rejections = await unhandledRejectionsDuring(async () => scheduler.pollNow());

  expect(rejections).toEqual([]);
  scheduler.stop();
});
