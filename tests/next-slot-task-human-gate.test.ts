import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { nextSlotTask, registerTask } from "../src/tasks.js";

describe("nextSlotTask は human 宛てタスクを slot の外に置く(issue #36 / ADR 0012)", () => {
  it("assignee: human の todo は飛ばされ、他の assignee の todo が返る", () => {
    const db = openDb(":memory:");
    const human = registerTask(
      db,
      { type: "work", title: "human's own todo", purpose: "p", completion_criteria: "c", assignee: "human" },
      new Date(0),
    );
    const agent = registerTask(
      db,
      { type: "work", title: "agent-executable todo", purpose: "p", completion_criteria: "c" },
      new Date(1),
    );

    const head = nextSlotTask(db);
    expect(head?.id).toBe(agent.id);
    expect(head?.id).not.toBe(human.id);
  });

  it("human 宛てタスクしかなければ nextSlotTask は undefined を返す", () => {
    const db = openDb(":memory:");
    registerTask(
      db,
      { type: "work", title: "human's own todo", purpose: "p", completion_criteria: "c", assignee: "human" },
      new Date(0),
    );

    expect(nextSlotTask(db)).toBeUndefined();
  });
});
