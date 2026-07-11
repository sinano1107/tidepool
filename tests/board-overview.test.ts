import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { cancelTask, completeTask, listBoard, pickupTask, registerTask } from "../src/tasks.js";

describe("listBoard は進捗俯瞰に必要な形を一望できる(issue #16)", () => {
  it("全ステータス・type・親子関係が揃い、blocked は導出値、skipped は現れない", () => {
    const db = openDb(":memory:");

    const parent = registerTask(
      db,
      { type: "work", title: "decompose the reef survey", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );
    const openChild = registerTask(
      db,
      { type: "work", title: "survey the north reef", purpose: "p", completion_criteria: "c", parent_id: parent.id },
      new Date(1),
    );
    const doneChild = registerTask(
      db,
      { type: "review", title: "review the south reef data", purpose: "p", completion_criteria: "c", parent_id: parent.id },
      new Date(2),
    );
    completeTask(
      db,
      doneChild,
      {
        outcome: "done",
        deliverables: "n/a",
        decision_refs: "n/a",
        dead_ends: "n/a",
        resume_context: "n/a",
        known_issues: "n/a",
      },
      "reef-crab",
      new Date(3),
    );

    const running = registerTask(
      db,
      { type: "work", title: "tag the drifting buoy", purpose: "p", completion_criteria: "c" },
      new Date(4),
    );
    pickupTask(db, running, "reef-crab", new Date(5));

    const abandoned = registerTask(
      db,
      { type: "work", title: "chase a dead lead", purpose: "p", completion_criteria: "c" },
      new Date(6),
    );
    cancelTask(db, abandoned, "origin-question", "tidepool", new Date(7));

    const board = listBoard(db);

    // AC1: 全ステータスが俯瞰できる
    expect(board.find((t) => t.id === running.id)?.status).toBe("in_progress");
    expect(board.find((t) => t.id === doneChild.id)?.status).toBe("done");
    expect(board.find((t) => t.id === abandoned.id)?.status).toBe("cancelled");

    // AC2: type と親子関係が見える
    expect(board.find((t) => t.id === openChild.id)).toMatchObject({
      type: "work",
      parent_id: parent.id,
    });
    expect(board.find((t) => t.id === doneChild.id)).toMatchObject({
      type: "review",
      parent_id: parent.id,
    });

    // AC3: blocked は親子関係からの導出値 — openChild が todo である限り parent は blocked
    expect(board.find((t) => t.id === parent.id)?.status).toBe("blocked");

    // AC4: skipped はボードに現れない
    expect(board.some((t) => t.status === "skipped")).toBe(false);
  });
});
