import { expect, it, vi } from "vitest";
import { taskPrompt } from "../src/board-prose.js";
import type { ContainmentCapability } from "../src/containment.js";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { logDecision, pickupTask, registerTask } from "../src/tasks.js";
import { definitionPart, FakeClock, fakeContainers, noRetrospectiveCalls, recordPrompt, ScriptedWorker } from "./fakes.js";
import { HUMAN_WEBUI, WORKER_SPAWNED } from "./harness.js";
import { tempDir } from "./temp-dir.js";

/** ADR 0119 決定5: poll 中に届いた契機は捨てる(合体しない)。それで取りこぼさないのは、poll が
 *  最初の await より前に slot を読み、候補の読み取りを await の後に置いているからである ——
 *  この順序の不変条件を固定する。 */
it("poll が封じ込め検査の await に居る間に登録されたタスクは、その poll で拾われる", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  let release!: (capability: ContainmentCapability) => void;
  let entered!: () => void;
  const inContainment = new Promise<void>((resolve) => (entered = resolve));
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
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    containment: () => {
      entered();
      return new Promise((resolve) => (release = resolve));
    },
  });

  // 空のキューで poll を撃ち、封じ込め検査の await で止める(poll は収束の回の後に始まる —— ADR 0241 決定5)
  scheduler.pollNow();
  await inContainment;
  // その poll の最中に登録が届く。登録が撃つ契機は inFlight で捨てられる
  const task = registerTask(
    db,
    { type: "work", title: "arrived mid-poll", purpose: "p", completion_criteria: "c" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  scheduler.pollNow();
  release({ available: true });
  await new Promise((resolve) => setImmediate(resolve));

  expect(worker.started.map((t) => t.id)).toEqual([task.id]);
  scheduler.stop();
});


it.each(["claude-code", "codex"] as const)("%s: RCA pickupは親のtaskだけを記録から凍結し、自分のtask本文もSlotとworkerで一致する", async (harness) => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const slot = new Slot();
  const recordDir = await tempDir("tidepool-parent-prompt-");
  const parent = pickupTask(db, registerTask(db, { type: "work", title: "parent", purpose: "old purpose", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), worker.id, clock.now())!;
  const spawned = appendEvent(db, { taskId: parent.id, actorId: worker.id, origin: "board", at: clock.now(), payload: WORKER_SPAWNED });
  const parentText = "parent task only\nPurpose: original\nCompletion criteria: complete\n\n";
  recordPrompt(recordDir, parent.id, spawned, [definitionPart("board definition"), { part: "memory", text: "injected memory" }], parentText, harness);
  const entry = logDecision(db, parent, "decision", worker.id, clock.now(), "worker");
  const objection = appendEvent(db, { taskId: parent.id, actorId: HUMAN_WEBUI[0], origin: "webui", at: clock.now(), payload: { kind: "objection_raised", entry_id: entry, comment: "why?", session_id: 1 } });
  const child = registerTask(db, { type: "review", title: "RCA", purpose: "review why", completion_criteria: "cause", parent_id: parent.id, assignee: worker.id, opened_on_event_ids: [objection] }, clock.now(), ...HUMAN_WEBUI);
  const scheduler = startScheduler({
    db, clock, slot, worker, containers: fakeContainers(),
    retrospectiveCalls: { ...noRetrospectiveCalls, recordDir }, converge: async () => [],
    onSpawnFailed: () => {}, onRecordContainerFailed: () => {}, onPickupStopped: () => {},
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
  });
  try {
    scheduler.pollNow();
    await vi.waitFor(() => expect(worker.started.map((task) => task.id)).toEqual([child.id]));
    expect(slot.parentBriefing).toEqual({ briefing_as_spawned: [{ text: parentText, for: [entry] }] });
    expect(slot.content).toEqual({ title: "RCA", purpose: "review why", completion_criteria: "cause" });
    expect(taskPrompt(worker.started[0]!)).toBe(`First call get_current_task for task ${child.id}, then complete this task: RCA\n\nPurpose: review why\nCompletion criteria: cause`);
  } finally {
    scheduler.stop();
  }
});
