import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { nextSlotTask, registerTask } from "../src/tasks.js";
import { quarantineAgentRow } from "./harness.js";

describe("nextSlotTask の per-task agent ゲート(ADR 0012 / issue #36)", () => {
  it("quarantine 済み agent 名を assignee に持つ todo は飛ばされ、他 agent 宛ての todo が返る", () => {
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

    const head = nextSlotTask(db, undefined, "deckhand");
    expect(head?.id).toBe(runnable.id);
    expect(head?.id).not.toBe(stuck.id);
  });

  it("assignee が未指定(null)なら盤面既定 agent 名で quarantine 判定される", () => {
    const db = openDb(":memory:");
    quarantineAgentRow(db, "deckhand");
    registerTask(
      db,
      { type: "work", title: "inherits default agent", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );

    expect(nextSlotTask(db, undefined, "deckhand")).toBeUndefined();
  });

  it("defaultAgentName を渡さないときはゲートが働かない", () => {
    const db = openDb(":memory:");
    quarantineAgentRow(db, "deckhand");
    const task = registerTask(
      db,
      { type: "work", title: "no agent tracking", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );

    expect(nextSlotTask(db)?.id).toBe(task.id);
  });

  it("review type かつ assignee 未設定のタスクは、defaultAgentName が健全でも auditorName の quarantine で pickup を止める(issue #42)", () => {
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

    const head = nextSlotTask(db, undefined, "deckhand", "auditor");
    expect(head?.id).toBe(work.id);
    expect(head?.id).not.toBe(review.id);
  });
});
