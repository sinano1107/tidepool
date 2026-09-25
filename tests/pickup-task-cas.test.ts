import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { cancelTaskDirectly, editTask, getTask, pickupTask, registerTask } from "../src/tasks.js";

// scheduler は head を選んでから pickupTask までに実 I/O を await する(issue #972)。
// その窓で人間の扉が行を書き換えたら、選んだときの古い Task で in_progress にしない
describe("pickupTask は選んだ後に書き換わった head を拾わない(issue #972)", () => {
  function queued() {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      { type: "work", title: "head", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );
    return { db, task };
  }

  it("窓の間に assignee が human に付け替えられた task は pickup されず、event も残らない", () => {
    const { db, task } = queued();
    editTask(db, task, { assignee: "human" }, new Date(1));

    expect(pickupTask(db, task, "deckhand", new Date(2))).toBeNull();

    expect(getTask(db, task.id)!.status).toBe("todo");
    expect(listEvents(db, task.id).some((e) => e.kind === "task_picked_up")).toBe(false);
  });

  it("窓の間に直接 cancel された task は pickup されず、event も残らない", () => {
    const { db, task } = queued();
    cancelTaskDirectly(db, task, null, new Date(1), {});

    expect(pickupTask(db, task, "deckhand", new Date(2))).toBeNull();

    expect(getTask(db, task.id)!.status).toBe("cancelled");
    expect(listEvents(db, task.id).some((e) => e.kind === "task_picked_up")).toBe(false);
  });
});
