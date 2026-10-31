import { expect, it } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { loadExecutionSettingTable } from "../src/execution-setting.js";
import { ProcessContainers } from "../src/process-container.js";
import { Slot } from "../src/slot.js";
import { getTask, listBoard, moveTask, nextSlotTask, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { type TeardownDeps, teardownStep } from "../src/teardown.js";
import { RecordContainerError } from "../src/transcript-store.js";
import { queueReturnHandler, recordContainerHaltHandler, rowRefusalHandler } from "../src/watchdog.js";
import { FakeClock, FakeContainerRuntime } from "./fakes.js";
import { HUMAN_WEBUI, WORKER_SPAWNED } from "./harness.js";

/** キュー順(GLOSSARY.md / ADR 0333 決定1・2): 盤面が自分の都合で todo へ戻す task は位置を変えない —— 順を動かすのは登録と人間の行為だけ。 */

const settle = () => new Promise((resolve) => setImmediate(resolve));

type BoardReturn = (deps: TeardownDeps, containers: ProcessContainers, task: Task) => void;

const RETURNS: [string, BoardReturn][] = [
  ["cap_interrupted", (deps, _, task) => teardownStep(deps.db, task.id).transition!(task, deps.clock.now())],
  ["pickup_stopped", (deps, containers, task) => queueReturnHandler(deps, containers)(task.id, { kind: "pickup_stopped", quarantine: "workspace", value: "ghost", reason: "unknown workspace: ghost" })],
  ["record_container_unwritable", (deps, containers, task) => recordContainerHaltHandler(deps, containers)(task.id, new RecordContainerError(task.id, "/logs", "EACCES"))],
  ["session_stopped_by_resource", (deps, containers, task) => {
    const spawned = appendEvent(deps.db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: deps.clock.now() });
    queueReturnHandler(deps, containers)(task.id, { kind: "session_stopped_by_resource", quarantine: "providerAuth", value: "anthropic", reason: "401", worker_spawned_event_id: spawned });
  }],
  ["row_refused", (deps, _, task) => {
    const { provider, model } = loadExecutionSettingTable(deps.db)[0]!;
    rowRefusalHandler(deps)(task.id, { provider, model, cause: "api_404", worker_spawned_event_id: 1 }, Promise.resolve());
  }],
];

it.each(RETURNS)("盤面が %s で todo へ戻した task は拾われる前の位置に居て、走行中に人間が先頭へ動かした task が先に拾われる(ADR 0333 決定1)", async (_, boardReturn) => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const containers = new ProcessContainers(new FakeContainerRuntime());
  const register = (title: string) => registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI);
  const [a, b, c] = [register("A"), register("B"), register("C")];
  const picked = pickupTask(db, b, "deckhand", clock.now())!;
  slot.occupy(picked.id);
  containers.open(picked.id);
  // 走行中に人間が C を先頭へ動かす
  moveTask(db, c, null, clock.now(), ...HUMAN_WEBUI);

  boardReturn({ db, clock, slot, resolve: undefined, pollNow: () => {} }, containers, picked);
  await settle();

  const ids = [a.id, b.id, c.id];
  const order = listBoard(db).filter((t) => ids.includes(t.id)).sort((x, y) => x.sort_key - y.sort_key).map((t) => t.title);
  expect(order).toEqual(["C", "A", "B"]);
  expect(nextSlotTask(db)?.id).toBe(c.id);
  const returned = getTask(db, b.id)!;
  expect(returned.status).toBe("todo");
  expect(returned.sort_key).toBe(b.sort_key);
  expect(listEvents(db, b.id).map((e) => e.kind)).not.toContain("task_moved");
  // task の移動の event の actor は常に人間(ADR 0333 決定2)
  expect(ids.flatMap((id) => listEvents(db, id)).filter((e) => e.kind === "task_moved" && e.actor_id === BOARD_ACTOR_ID)).toEqual([]);
});
