import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listBoard, listQueue, registerTask } from "../src/tasks.js";

describe("listQueue は human 宛てタスクを実行キューから除外する(issue #13)", () => {
  it("assignee: human の todo はキュービューに現れず、他 assignee の todo はそのまま現れる", () => {
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
      { type: "work", title: "agent-executable todo", purpose: "p", completion_criteria: "c" },
      new Date(1),
    );

    const queue = listQueue(db, false);
    expect(queue.map((t) => t.id)).not.toContain(human.id);
    expect(queue.map((t) => t.id)).toContain(agent.id);

    // human 宛てタスクはボード自体からは退かない — your tasks 専用のキュー除外
    const board = listBoard(db);
    expect(board.map((t) => t.id)).toContain(human.id);
  });
});
