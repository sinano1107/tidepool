import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { completeTask, getTask, registerTask } from "../src/tasks.js";

describe("completeTask は human 宛て work タスクのハンドオフ必須チェックを免除する(issue #13)", () => {
  it("human 宛てタスクはハンドオフなしで complete でき、他 assignee はこれまで通り必須のまま", () => {
    const db = openDb(":memory:");
    const human = registerTask(
      db,
      {
        type: "work",
        title: "physically water the greenhouse",
        purpose: "p",
        completion_criteria: "c",
        assignee: "human",
      },
      new Date(0),
    );
    const agent = registerTask(
      db,
      {
        type: "work",
        title: "agent-executable todo",
        purpose: "p",
        completion_criteria: "c",
        assignee: "reef-crab",
      },
      new Date(1),
    );

    const done = completeTask(db, human, undefined, "human", new Date(2));
    expect(done.status).toBe("done");
    expect(getTask(db, human.id)?.status).toBe("done");

    expect(() => completeTask(db, agent, undefined, "reef-crab", new Date(3))).toThrow(
      /handoff doc/,
    );
  });
});
