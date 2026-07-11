import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listBoard, listQueue, registerTask } from "../src/tasks.js";
import { quarantineAgentRow } from "./harness.js";

describe("listQueue は quarantine 済み agent 宛ての todo を skipped と表示する(ADR 0012 / issue #36)", () => {
  it("quarantine 済み agent 宛ての todo はキュービューで skipped、他 agent 宛てはそのまま todo", () => {
    const db = openDb(":memory:");
    quarantineAgentRow(db, "navigator");
    const stuck = registerTask(
      db,
      {
        type: "work",
        title: "delegated to quarantined navigator",
        purpose: "p",
        completion_criteria: "c",
        assignee: "navigator",
      },
      new Date(0),
    );
    const runnable = registerTask(
      db,
      {
        type: "work",
        title: "delegated to deckhand",
        purpose: "p",
        completion_criteria: "c",
        assignee: "deckhand",
      },
      new Date(1),
    );

    const queue = listQueue(db, false, undefined, "deckhand");
    expect(queue.find((t) => t.id === stuck.id)?.status).toBe("skipped");
    expect(queue.find((t) => t.id === runnable.id)?.status).toBe("todo");

    // skipped is queue-view-only — the board itself keeps showing plain todo
    const board = listBoard(db);
    expect(board.find((t) => t.id === stuck.id)?.status).toBe("todo");
  });

  it("defaultAgentName を渡さないときはゲートが働かない", () => {
    const db = openDb(":memory:");
    quarantineAgentRow(db, "deckhand");
    const task = registerTask(
      db,
      { type: "work", title: "no agent tracking", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );

    expect(listQueue(db, false).find((t) => t.id === task.id)?.status).toBe("todo");
  });

  it("review type かつ assignee 未設定のタスクは、defaultAgentName が健全でも auditorName の quarantine で skipped になる(issue #42)", () => {
    const db = openDb(":memory:");
    quarantineAgentRow(db, "auditor");
    const review = registerTask(
      db,
      { type: "review", title: "independent rca", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );
    const work = registerTask(
      db,
      { type: "work", title: "inherits default agent", purpose: "p", completion_criteria: "c" },
      new Date(1),
    );

    const queue = listQueue(db, false, undefined, "deckhand", "auditor");
    expect(queue.find((t) => t.id === review.id)?.status).toBe("skipped");
    expect(queue.find((t) => t.id === work.id)?.status).toBe("todo");
  });
});
