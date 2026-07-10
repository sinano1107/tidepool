import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { getTask, pickupTask, registerTask } from "../src/tasks.js";

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
    );

    const picked = pickupTask(db, task, "deckhand", new Date(1));

    expect(picked.status).toBe("in_progress");
    expect(picked.assignee).toBe("navigator");
    expect(getTask(db, task.id)!.assignee).toBe("navigator");
  });

  it("未指定(null)の assignee は pickup 後も null のまま焼き込まれない(既定 agent への参照は都度解決)", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      { type: "work", title: "unspecified assignee", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );
    expect(task.assignee).toBeNull();

    const picked = pickupTask(db, task, "deckhand", new Date(1));

    expect(picked.status).toBe("in_progress");
    expect(picked.assignee).toBeNull();
  });

  it("pickup イベントの worker_id には呼び出し側が渡した(解決済みの)id が記録される", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      { type: "work", title: "unspecified assignee", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );

    pickupTask(db, task, "deckhand", new Date(1));

    const event = listEvents(db, task.id).find((e) => e.kind === "task_picked_up");
    expect(event?.worker_id).toBe("deckhand");
  });
});
