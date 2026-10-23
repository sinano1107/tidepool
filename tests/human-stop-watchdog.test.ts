import { expect, it, onTestFinished } from "vitest";
import { openDb } from "../src/db.js";
import { ProcessContainers } from "../src/process-container.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { Slot } from "../src/slot.js";
import { listChildren, pickupTask, registerTask } from "../src/tasks.js";
import { sessionInTeardown } from "../src/teardown.js";
import { recordHumanStop, startWatchdog } from "../src/watchdog.js";
import { prepareWorkspaceAtPickup, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, FakeContainerRuntime, ScriptedWorker } from "./fakes.js";
import { commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace } from "./harness.js";

const MIN = 60 * 1000;
function fixture(workspace?: WorkspaceConfig) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const runtime = new FakeContainerRuntime();
  const containers = new ProcessContainers(runtime);
  const worker = new ScriptedWorker(clock);
  const task = pickupTask(db, registerTask(db, { type: "work", title: "one", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), "deckhand", clock.now())!;
  slot.occupy(task.id);
  containers.open(task.id);
  runtime.hold(task.id);
  let pickups = 0;
  const watchdog = startWatchdog({ db, clock, slot, worker, containers, workspace, pollNow: () => { pickups++; }, config: { timeLimits: {}, grace: 2 * MIN, reclaimTimeout: 3 * MIN } });
  onTestFinished(() => { watchdog.stop(); db.close(); });
  return { db, clock, slot, runtime, worker, task, watchdog, pickups: () => pickups };
}

it("human stop sends graceful stop, waits the grace, force-reclaims, and releases only on the empty observation", async () => {
  const ws = await makeWorkspace("human-stop");
  const f = fixture(ws);
  await prepareWorkspaceAtPickup(f.db, ws, f.task);
  commitWork(ws.path, "draft.txt", "unfinished work\n");
  expect(f.watchdog.stopSession(f.task.id, () => recordHumanStop(f.db, f.task.id, "stop", f.clock.now(), "webui"))).toBeUndefined();
  expect(f.worker.gracefulStops).toEqual([f.task.id]);
  expect(f.slot.inTeardown).toBe(true);
  await f.clock.advance(MIN);
  expect(f.runtime.forceReclaims).toEqual([]);
  await f.clock.advance(MIN);
  expect(f.runtime.forceReclaims).toEqual([f.task.id]);
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(f.pickups()).toBe(0);
  expect(git(ws.path, "branch", "--show-current")).toBe(`task/${f.task.id}`);
  f.runtime.fireEmpty(f.task.id);
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.slot.currentTaskId).toBeNull();
  expect(sessionInTeardown(f.db)).toBeUndefined();
  expect(f.pickups()).toBe(1);
  expect(git(ws.path, "branch", "--show-current")).toBe("main");
}, GIT_FIXTURE_TEST_TIMEOUT);

it("nothing running and already ending refuse before the record callback", () => {
  const f = fixture();
  const mustNotRecord = () => { throw new Error("must not record"); };
  expect(f.watchdog.stopSession("another task", mustNotRecord)).toBe("nothing running");
  f.watchdog.stopSession(f.task.id, () => recordHumanStop(f.db, f.task.id, undefined, f.clock.now(), "webui"));
  expect(f.watchdog.stopSession(f.task.id, mustNotRecord)).toBe("already ending");
  f.slot.release();
  expect(f.watchdog.stopSession(f.task.id, mustNotRecord)).toBe("nothing running");
});

it("a human stop that times out keeps its failure and waits for containment confirmation even after a late empty observation", async () => {
  const f = fixture();
  f.watchdog.stopSession(f.task.id, () => recordHumanStop(f.db, f.task.id, undefined, f.clock.now(), "webui"));
  const failure = listChildren(f.db, f.task.id);
  await f.clock.advance(5 * MIN);
  expect(openQuarantineQuestion(f.db, "containment", null)).toBeDefined();
  expect(listChildren(f.db, f.task.id)).toEqual(failure);
  f.runtime.fireEmpty(f.task.id);
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(f.pickups()).toBe(0);
  f.watchdog.acceptReclaimed();
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.slot.currentTaskId).toBeNull();
  expect(f.pickups()).toBe(1);
});
