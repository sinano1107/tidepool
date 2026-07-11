import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { cancelTask, completeTask, listBoard, listQueue, registerTask } from "../src/tasks.js";

const HANDOFF = {
  outcome: "done",
  deliverables: "n/a",
  decision_refs: "n/a",
  dead_ends: "n/a",
  resume_context: "n/a",
  known_issues: "n/a",
} as const;

describe("Board は settled ツリーを退かせる(issue #35)", () => {
  it("cancelled タスクは、計画がまだ生きていても即座に board から消える", () => {
    const db = openDb(":memory:");
    const parent = registerTask(
      db,
      { type: "work", title: "roll out the tide gauge", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );
    const stillOpen = registerTask(
      db,
      { type: "work", title: "survey the north reef", purpose: "p", completion_criteria: "c", parent_id: parent.id },
      new Date(1),
    );
    const abandoned = registerTask(
      db,
      { type: "work", title: "chase a dead lead", purpose: "p", completion_criteria: "c", parent_id: parent.id },
      new Date(2),
    );
    cancelTask(db, abandoned, "origin-question", "tidepool", new Date(3));

    const board = listBoard(db);

    expect(board.some((t) => t.id === abandoned.id)).toBe(false);
    // 計画自体はまだ生きている(stillOpen が todo)ので、親と生きた子は見え続ける
    expect(board.find((t) => t.id === stillOpen.id)?.status).toBe("todo");
    expect(board.find((t) => t.id === parent.id)?.status).toBe("blocked");
  });

  it("子を持たないルートが done になり、ツリー全体が settled になると board から消える", () => {
    const db = openDb(":memory:");
    const root = registerTask(
      db,
      { type: "work", title: "flip the greenhouse valve", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );
    completeTask(db, root, HANDOFF, "reef-crab", new Date(1));

    const board = listBoard(db);

    expect(board.some((t) => t.id === root.id)).toBe(false);
  });

  it("ルートが done でも、完了時レビュー子が未決着なら root もレビュー子も board に残る(issue #35 コメントの訂正)", () => {
    const db = openDb(":memory:");
    const root = registerTask(
      db,
      {
        type: "work",
        title: "wire the moisture sensor",
        purpose: "p",
        completion_criteria: "c",
        review_flag: true,
      },
      new Date(0),
    );
    completeTask(db, root, HANDOFF, "reef-crab", new Date(1));

    const board = listBoard(db);
    const review = board.find((t) => t.type === "review" && t.parent_id === root.id);

    expect(board.find((t) => t.id === root.id)?.status).toBe("done");
    expect(review?.status).toBe("todo");
  });

  it("listQueue も同じ導出フィルタを共有する — settled ツリーは queue にも現れない", () => {
    const db = openDb(":memory:");
    const root = registerTask(
      db,
      { type: "work", title: "flip the greenhouse valve", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );
    completeTask(db, root, HANDOFF, "reef-crab", new Date(1));

    const queue = listQueue(db, false);

    expect(queue.some((t) => t.id === root.id)).toBe(false);
  });
});
