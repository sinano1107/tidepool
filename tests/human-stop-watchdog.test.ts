import { expect, it, onTestFinished, vi } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { ProcessContainers } from "../src/process-container.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { Slot } from "../src/slot.js";
import { getTask, listChildren, pickupTask, registerTask } from "../src/tasks.js";
import { sessionInTeardown } from "../src/teardown.js";
import { recordHumanStop, startWatchdog } from "../src/watchdog.js";
import { prepareWorkspaceAtPickup, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, FakeContainerRuntime, ScriptedWorker } from "./fakes.js";
import { answerQuestionViaWebui, commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, QUIET_EXIT, sessionId, WORKER_SPAWNED } from "./harness.js";

const MIN = 60 * 1000;
function fixture(workspace?: WorkspaceConfig, timeLimits: { work?: number } = {}, grace = 2 * MIN) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const runtime = new FakeContainerRuntime();
  const containers = new ProcessContainers(runtime);
  const worker = new ScriptedWorker(clock);
  const task = pickupTask(db, registerTask(db, { type: "work", title: "one", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), "deckhand", clock.now())!;
  slot.occupy(task.id, sessionId(db, task.id));
  containers.open(String(sessionId(db, task.id)));
  runtime.hold(String(sessionId(db, task.id)));
  let pickups = 0;
  const watchdog = startWatchdog({ db, clock, slot, worker, containers, workspace, pollNow: () => { pickups++; }, config: { timeLimits, grace, reclaimTimeout: 3 * MIN } });
  onTestFinished(() => { watchdog.stop(); db.close(); });
  return { db, clock, slot, runtime, containers, worker, task, watchdog, pickups: () => pickups };
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
  expect(f.runtime.forceReclaims).toEqual([String(sessionId(f.db, f.task.id))]);
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(f.pickups()).toBe(0);
  expect(git(ws.path, "branch", "--show-current")).toBe(`task/${f.task.id}`);
  f.runtime.fireEmpty(String(sessionId(f.db, f.task.id)));
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
  f.runtime.fireEmpty(String(sessionId(f.db, f.task.id)));
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(f.pickups()).toBe(0);
  f.watchdog.acceptReclaimed();
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.slot.currentTaskId).toBeNull();
  expect(f.pickups()).toBe(1);
});

async function retryWithoutAdvancingPickupTime() {
  const f = fixture(undefined, { work: MIN }, 0);
  const now = vi.spyOn(f.clock, "now").mockReturnValue(new Date(0));
  const oldSession = sessionId(f.db, f.task.id);
  const spawned = appendEvent(f.db, { taskId: f.task.id, actorId: "deckhand", origin: "board", at: f.clock.now(), payload: WORKER_SPAWNED });
  f.watchdog.onWorkerExited(f.task.id, { ...QUIET_EXIT, stderr_tail: "old session stderr" }, {
    sessionId: oldSession, workerSpawnedEventId: spawned, turnRan: true, writes: [], classification: Promise.resolve({ capInterrupted: false }),
  });
  f.watchdog.stopSession(f.task.id, () => recordHumanStop(f.db, f.task.id, "first stop", f.clock.now(), "webui"));
  await f.clock.advance(2 * MIN);
  f.runtime.fireEmpty(String(oldSession));
  await new Promise((resolve) => setImmediate(resolve));
  const failure = listChildren(f.db, f.task.id).find((task) => task.type === "question")!;
  answerQuestionViaWebui(f.db, failure, ["retry"], f.clock.now());
  const retried = pickupTask(f.db, getTask(f.db, f.task.id)!, "deckhand", f.clock.now())!;
  f.slot.occupy(retried.id, sessionId(f.db, retried.id));
  f.containers.open(String(sessionId(f.db, retried.id)));
  return { ...f, now, oldSession };
}

it("a retry picked up at the same clock time sends a fresh human stop", async () => {
  const f = await retryWithoutAdvancingPickupTime();

  expect(f.watchdog.stopSession(f.task.id, () => recordHumanStop(f.db, f.task.id, "second stop", f.clock.now(), "webui"))).toBeUndefined();

  expect(f.worker.gracefulStops).toEqual([f.task.id, f.task.id]);
  await f.clock.advance(2 * MIN);
  expect(f.runtime.forceReclaims).toEqual([String(f.oldSession), String(sessionId(f.db, f.task.id))]);
  expect(sessionInTeardown(f.db)).toBeUndefined();
});

it("a retry picked up at the same clock time gets a fresh time limit without the old human stop or exit", async () => {
  const f = await retryWithoutAdvancingPickupTime();
  f.now.mockReturnValue(new Date(MIN));

  await f.clock.advance(MIN);

  expect(f.worker.gracefulStops).toEqual([f.task.id, f.task.id]);
  await f.clock.advance(MIN);
  expect(f.runtime.forceReclaims).toEqual([String(f.oldSession), String(sessionId(f.db, f.task.id))]);
  const failure = listChildren(f.db, f.task.id).find((task) => task.title.startsWith("watchdog killed"))!;
  expect(failure.purpose).toContain("time limit (60000ms)");
  expect(failure.purpose).not.toContain("old session stderr");
  expect(sessionInTeardown(f.db)).toBeUndefined();
});
