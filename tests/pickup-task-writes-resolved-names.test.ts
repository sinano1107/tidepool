import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { editTask, getTask, pickupTask, registerTask } from "../src/tasks.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { defaultingTo, GIT_FIXTURE_TEST_TIMEOUT, HUMAN_WEBUI, makeWorkspace } from "./harness.js";

// ADR 0233: 既定への参照は pickup で終わる —— 解決した名前を空の列にだけ書き(指定済みは ADR 0012 のまま)、書いた列と名前を pickup の event に残す
describe("pickupTask は呼び手が解決した名前を空の列にだけ書く(ADR 0233 / ADR 0012)", () => {
  const pickedUpPayload = (db: ReturnType<typeof openDb>, taskId: string) =>
    listEvents(db, taskId).find((e) => e.kind === "task_picked_up")?.payload;
  const unspecified = (db: ReturnType<typeof openDb>) =>
    registerTask(db, { type: "work", title: "unspecified", purpose: "p", completion_criteria: "c" }, new Date(0), ...HUMAN_WEBUI);

  it("空の assignee と workspace に渡された名前が書かれ、event に両方が載る", () => {
    const db = openDb(":memory:");
    const task = unspecified(db);

    const picked = pickupTask(db, task, "tako", new Date(1), { assignee: "tako", workspace: "sandbox" })!;

    expect(picked).toMatchObject({ status: "in_progress", assignee: "tako", workspace: "sandbox" });
    expect(pickedUpPayload(db, task.id)).toEqual({
      kind: "task_picked_up",
      resolved_from_default: { assignee: "tako", workspace: "sandbox" },
    });
  });

  it("pickup イベントの worker_id には呼び出し側が渡した(解決済みの)id が記録される", () => {
    const db = openDb(":memory:");
    const task = unspecified(db);

    pickupTask(db, task, "deckhand", new Date(1));

    expect(listEvents(db, task.id).find((e) => e.kind === "task_picked_up")?.worker_id).toBe("deckhand");
  });

  it("指定済みの assignee(委譲先)と workspace は書き換えず、event にも載らない", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      { type: "work", title: "named", purpose: "p", completion_criteria: "c", assignee: "navigator", workspace: "prod" },
      new Date(0),
      ...HUMAN_WEBUI,
    );

    const picked = pickupTask(db, task, "navigator", new Date(1), { assignee: "tako", workspace: "sandbox" })!;

    expect(picked).toMatchObject({ assignee: "navigator", workspace: "prod" });
    expect(pickedUpPayload(db, task.id)).toEqual({ kind: "task_picked_up" });
  });

  it("選んだ後に人間が workspace を指定したら、pickup はその名前を書き換えず、event にも載せない(issue #972 の窓)", () => {
    const db = openDb(":memory:");
    const head = unspecified(db);
    editTask(db, head, { workspace: "prod" }, new Date(1), "webui");

    const picked = pickupTask(db, head, "tako", new Date(2), { assignee: "tako", workspace: "sandbox" })!;

    expect(picked.workspace).toBe("prod");
    expect(pickedUpPayload(db, head.id)).toEqual({
      kind: "task_picked_up",
      resolved_from_default: { assignee: "tako" },
    });
  });

  it("人間の編集で空に戻したタスクは、次の pickup でその時の既定に解決し直される", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      { type: "work", title: "back to default", purpose: "p", completion_criteria: "c", assignee: "navigator", workspace: "prod" },
      new Date(0),
      ...HUMAN_WEBUI,
    );
    const cleared = editTask(db, task, { assignee: "", workspace: "" }, new Date(1), "webui");

    const picked = pickupTask(db, cleared, "tako", new Date(2), { assignee: "tako", workspace: "sandbox" })!;

    expect(picked).toMatchObject({ assignee: "tako", workspace: "sandbox" });
  });
});

// ADR 0233 決定1・3: 書くのは scheduler の pickup だけ —— 一度も pickup されないタスクは空のまま、review の空の assignee は Auditor への参照のまま
describe("scheduler の pickup が既定の名前を書く先", () => {
  it("pickup された review には既定 workspace の名前だけが書かれ、question・human 宛て・着手前の work は workspace も assignee も空のまま", async () => {
    const workspace = await makeWorkspace("pickup-fill");
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const scheduler = startScheduler({
      retrospectiveCalls: noRetrospectiveCalls,
      db,
      clock,
      slot: new Slot(),
      worker: new ScriptedWorker(clock, "tako"),
      containers: fakeContainers(),
      onSpawnFailed: () => {},
      taskExecutionCandidates: implicitTaskExecutionCandidates(db),
      workspace,
      resolveWorkspace: defaultingTo(workspace),
    });
    const register = (input: Omit<Parameters<typeof registerTask>[1], "purpose" | "completion_criteria">) =>
      registerTask(db, { purpose: "p", completion_criteria: "c", ...input }, clock.now(), ...HUMAN_WEBUI);
    // review が slot を埋めるので、後ろの work は着手前のまま残る
    const review = register({ type: "review", title: "review it" });
    const waiting = register({ type: "work", title: "waiting" });
    const human = register({ type: "work", title: "by hand", assignee: "human" });
    const question = register({ type: "question", title: "ask", question: [{ title: "choose", options: ["yes", "no"], recommendation: "yes" }] });

    await clock.advance(HOURLY);

    expect(getTask(db, review.id)).toMatchObject({ status: "in_progress", assignee: null, workspace: workspace.name });
    expect(getTask(db, waiting.id)).toMatchObject({ status: "todo", assignee: null, workspace: null });
    expect(getTask(db, human.id)).toMatchObject({ assignee: "human", workspace: null });
    expect(getTask(db, question.id)).toMatchObject({ assignee: question.assignee, workspace: null });

    scheduler.stop();
  }, GIT_FIXTURE_TEST_TIMEOUT);
});
