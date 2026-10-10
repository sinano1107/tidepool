import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { editTask, getTask, pickupTask, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

describe("pickupTask は assignee を上書きしない(issue #36 / ADR 0012)", () => {
  it("事前割当された assignee(委譲先)は pickup 後もそのまま残る", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      {
        type: "work",
        title: "delegated to navigator",
        purpose: "p",
        completion_criteria: "c",
        assignee: "navigator",
      },
      new Date(0),
      ...HUMAN_WEBUI,
    );

    const picked = pickupTask(db, task, "deckhand", new Date(1))!;

    expect(picked.status).toBe("in_progress");
    expect(picked.assignee).toBe("navigator");
    expect(getTask(db, task.id)!.assignee).toBe("navigator");
  });

  it("pickup イベントの worker_id には呼び出し側が渡した(解決済みの)id が記録される", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      { type: "work", title: "unspecified assignee", purpose: "p", completion_criteria: "c" },
      new Date(0),
      ...HUMAN_WEBUI,
    );

    pickupTask(db, task, "deckhand", new Date(1));

    const event = listEvents(db, task.id).find((e) => e.kind === "task_picked_up");
    expect(event?.worker_id).toBe("deckhand");
  });
});

// ADR 0233: 既定への参照は pickup で終わる —— 解決した名前を空の列にだけ書き、書いた列と名前を pickup の event に残す
describe("pickupTask は既定から解決した名前を空の列に書く(ADR 0233)", () => {
  const pickedUpPayload = (db: ReturnType<typeof openDb>, taskId: string) =>
    listEvents(db, taskId).find((e) => e.kind === "task_picked_up")?.payload;

  it("未指定の work は、解決した agent と既定 workspace の名前が pickup で書かれ、event に両方が載る", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      { type: "work", title: "unspecified", purpose: "p", completion_criteria: "c" },
      new Date(0),
      ...HUMAN_WEBUI,
    );

    const picked = pickupTask(db, task, "tako", new Date(1), "sandbox")!;

    expect(picked).toMatchObject({ status: "in_progress", assignee: "tako", workspace: "sandbox" });
    expect(pickedUpPayload(db, task.id)).toEqual({
      kind: "task_picked_up",
      resolved_from_default: { assignee: "tako", workspace: "sandbox" },
    });
  });

  it("指定済みの assignee と workspace は書き換えず、event にも載らない", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      { type: "work", title: "named", purpose: "p", completion_criteria: "c", assignee: "navigator", workspace: "prod" },
      new Date(0),
      ...HUMAN_WEBUI,
    );

    const picked = pickupTask(db, task, "navigator", new Date(1), "sandbox")!;

    expect(picked).toMatchObject({ assignee: "navigator", workspace: "prod" });
    expect(pickedUpPayload(db, task.id)).toEqual({ kind: "task_picked_up" });
  });

  it("review の空の assignee は Auditor ポインタへの参照のまま空に残り、workspace だけが書かれる", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      { type: "review", title: "review it", purpose: "p", completion_criteria: "c" },
      new Date(0),
      ...HUMAN_WEBUI,
    );

    const picked = pickupTask(db, task, "shako", new Date(1), "sandbox")!;

    expect(picked).toMatchObject({ assignee: null, workspace: "sandbox" });
    expect(pickedUpPayload(db, task.id)).toEqual({
      kind: "task_picked_up",
      resolved_from_default: { workspace: "sandbox" },
    });
  });

  it("選んだ後に人間が workspace を指定したら、pickup はその名前を書き換えず、event にも載せない(issue #972 の窓)", () => {
    const db = openDb(":memory:");
    const head = registerTask(
      db,
      { type: "work", title: "edited meanwhile", purpose: "p", completion_criteria: "c" },
      new Date(0),
      ...HUMAN_WEBUI,
    );
    editTask(db, head, { workspace: "prod" }, new Date(1), "webui");

    const picked = pickupTask(db, head, "tako", new Date(2), "sandbox")!;

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

    const picked = pickupTask(db, cleared, "tako", new Date(2), "sandbox")!;

    expect(picked).toMatchObject({ assignee: "tako", workspace: "sandbox" });
  });
});
