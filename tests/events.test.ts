import { afterEach, expect, it } from "vitest";
import { appendEvent, currentAttributions, latestEventOfTask, listEventsOfKinds } from "../src/events.js";
import { api, bootTidepool, bundledObjection, FIXTURE_OTHER_TASK, FIXTURE_TASK, HOUR, mcpClient, seedFixtureBoard, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("every state change is appended as a typed event, readable via the events API", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "traceable task",
      purpose: "prove the event trail",
      completion_criteria: "events recorded",
    })
  ).json;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    await client.callTool({
      name: "complete_task",
      arguments: {
        handoff: {
          outcome: "done as specified",
          deliverables: "n/a",
          decision_refs: "none",
          dead_ends: "none",
          resume_context: "none",
          known_issues: "none",
        },
      },
    });
  } finally {
    await client.close();
  }

  const res = await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`);
  expect(res.status).toBe(200);
  const events = res.json;
  expect(events.map((e: any) => e.kind)).toEqual([
    "task_registered",
    "task_picked_up",
    "task_completed",
  ]);

  const [registered, pickedUp, completed] = events;
  // registration through the bare JSON API is attributed to the human worker
  expect(registered.worker_id).toBe("human");
  expect(registered.origin).toBe("webui");
  expect(registered.payload.type).toBe("work");
  expect(pickedUp.worker_id).toBe(t.worker.id);
  expect(pickedUp.origin).toBe("board");
  expect(completed.worker_id).toBe(t.worker.id);
  expect(completed.origin).toBe("worker");
  expect(completed.payload.handoff_present).toBe(true);
  // append-only trail: every event carries its task and a timestamp
  for (const e of events) {
    expect(e.task_id).toBe(task.id);
    expect(e.created_at).toBeTruthy();
  }
});

it("kind で引く読み口は、指定した kind の event だけを盤面全体から id 順で返す(issue #1073)", () => {
  const db = seedFixtureBoard();
  // kind の並びを id の並びと逆にして渡す —— 返す順は kind の順でなく id の順
  expect(listEventsOfKinds(db, ["worker_exited", "decision_logged"]).map((e) => [e.id, e.kind])).toEqual([
    [6, "decision_logged"],
    [7, "decision_logged"],
    [8, "decision_logged"],
    [11, "worker_exited"],
  ]);
});

it("kind で引く読み口の id の範囲は、下限の id ちょうどを含まず上限の id ちょうどを含み、省略すれば全件(issue #1126)", () => {
  const db = seedFixtureBoard();
  const ids = (range?: { after?: number; upTo?: number }) => listEventsOfKinds(db, ["worker_exited", "decision_logged"], range).map((e) => e.id);
  expect(ids({ after: 7 })).toEqual([8, 11]);
  expect(ids({ upTo: 7 })).toEqual([6, 7]);
  expect(ids({ after: 6, upTo: 8 })).toEqual([7, 8]);
  expect(ids({})).toEqual([6, 7, 8, 11]);
});

it("タスク単位の最新1件の読み口は、同じタスク・同じ kind の後の方を返し、他タスクの event は返さず、無ければ undefined(issue #1126)", () => {
  const db = seedFixtureBoard();
  const later = appendEvent(db, {
    taskId: FIXTURE_OTHER_TASK,
    workerId: "tidepool",
    origin: "worker",
    payload: { kind: "decision_logged", line: "other task" },
    at: new Date("2026-09-28T00:00:00.000Z"),
  });
  // FIXTURE_TASK の decision_logged は 6 / 7 / 8。他タスクの後の event(later)は返さない
  expect(latestEventOfTask(db, FIXTURE_TASK, "decision_logged")?.id).toBe(8);
  expect(latestEventOfTask(db, FIXTURE_OTHER_TASK, "decision_logged")?.id).toBe(later);
  expect(latestEventOfTask(db, FIXTURE_OTHER_TASK, "worker_spawned")).toBeUndefined();
});

it("今の判定の読み口は、同じ異議群に initial と after_rca の帰責があるとき after_rca を返す(ADR 0170 / issue #1073)", () => {
  const db = seedFixtureBoard();
  const at = new Date("2026-09-28T00:00:00.000Z");
  const objection = bundledObjection(db, FIXTURE_TASK, 7, at);
  const attribute = (cause: "uncertain" | "preference", round: "initial" | "after_rca") =>
    appendEvent(db, {
      taskId: FIXTURE_TASK,
      workerId: "tidepool",
      origin: "board",
      payload: { kind: "objection_attributed", entry_id: 7, objection_event_ids: [objection], cause, evidence: "e", entries: null, round },
      at,
    });
  attribute("uncertain", "initial");
  const later = attribute("preference", "after_rca");

  expect(currentAttributions(db).get(7)).toMatchObject({ id: later, cause: "preference", round: "after_rca" });
});
