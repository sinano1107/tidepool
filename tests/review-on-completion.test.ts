import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { completeTask, listBoard, registerTask } from "../src/tasks.js";

describe("completeTask は review_flag 付き work タスクの完了で review task を自動生成する(issue #15, layer 1 の review_flag 側)", () => {
  it("review_flag: true な work タスクの完了で、その子として review タスクが生成される", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      {
        type: "work",
        title: "wire the moisture sensor",
        purpose: "get readings flowing",
        completion_criteria: "dashboard shows a live number",
        review_flag: true,
        assignee: "reef-crab",
      },
      new Date(0),
    );

    completeTask(
      db,
      task,
      {
        outcome: "done",
        deliverables: "PR #1",
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
      "reef-crab",
      new Date(1),
    );

    const board = listBoard(db);
    const review = board.find((t) => t.type === "review" && t.parent_id === task.id);
    expect(review).toBeDefined();
    expect(listEvents(db, review!.id).find((event) => event.kind === "task_registered")?.origin).toBe(
      "worker",
    );
  });

  it("review_flag なしの work タスクの完了では review タスクは生成されない", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      {
        type: "work",
        title: "calibrate the sensor",
        purpose: "raw readings are uncalibrated",
        completion_criteria: "reading matches manual probe ±5%",
        assignee: "reef-crab",
      },
      new Date(0),
    );

    completeTask(
      db,
      task,
      {
        outcome: "done",
        deliverables: "PR #2",
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
      "reef-crab",
      new Date(1),
    );

    const board = listBoard(db);
    const review = board.find((t) => t.type === "review" && t.parent_id === task.id);
    expect(review).toBeUndefined();
  });
});

describe("分解子のレビューは既定で親に委譲され、risk_flag 付きの子は(review_flag なしでも)個別レビューが生成される(issue #15, AC2)", () => {
  function decomposedChild(db: ReturnType<typeof openDb>, riskFlag: boolean) {
    const parent = registerTask(
      db,
      {
        type: "work",
        title: "roll out the greenhouse dashboard",
        purpose: "ship the whole feature",
        completion_criteria: "dashboard live",
        assignee: "reef-crab",
      },
      new Date(0),
    );
    return registerTask(
      db,
      {
        type: "work",
        title: "wire the moisture sensor",
        purpose: "get readings flowing",
        completion_criteria: "dashboard shows a live number",
        risk_flag: riskFlag,
        parent_id: parent.id,
        assignee: "reef-crab",
      },
      new Date(1),
    );
  }

  it("risk_flag 付きの分解子は review_flag なしでも完了時に個別 review が生成される", () => {
    const db = openDb(":memory:");
    const child = decomposedChild(db, true);

    completeTask(
      db,
      child,
      {
        outcome: "done",
        deliverables: "PR #3",
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
      "reef-crab",
      new Date(2),
    );

    const board = listBoard(db);
    const review = board.find((t) => t.type === "review" && t.parent_id === child.id);
    expect(review).toBeDefined();
  });

  it("risk_flag も review_flag もない分解子の完了では個別 review は生成されない(親の完了時レビューに委譲)", () => {
    const db = openDb(":memory:");
    const child = decomposedChild(db, false);

    completeTask(
      db,
      child,
      {
        outcome: "done",
        deliverables: "PR #4",
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
      "reef-crab",
      new Date(2),
    );

    const board = listBoard(db);
    const review = board.find((t) => t.type === "review" && t.parent_id === child.id);
    expect(review).toBeUndefined();
  });
});

describe("risk_flag 付き work タスクは親の有無に関わらず完了時に review が自動生成される(issue #15, design vault: projects/tidepool/overview.md — layer 1 は risk/review flag のどちらかで opt-in、review_flag 単独ではない)", () => {
  it("親を持たない(root)risk_flag 付き work タスクも review_flag なしで review が生成される", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      {
        type: "work",
        title: "flip the greenhouse valve",
        purpose: "irreversible external effect",
        completion_criteria: "valve opened",
        risk_flag: true,
        assignee: "reef-crab",
      },
      new Date(0),
    );

    completeTask(
      db,
      task,
      {
        outcome: "done",
        deliverables: "n/a",
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
      "reef-crab",
      new Date(1),
    );

    const board = listBoard(db);
    const review = board.find((t) => t.type === "review" && t.parent_id === task.id);
    expect(review).toBeDefined();
  });
});

describe("自動生成される review タスクはレビュー対象タスクの workspace を継承する(CONTEXT.md: 子タスクは親の workspace を既定で継承する)", () => {
  it("非デフォルト workspace で完了したタスクの review 子タスクは同じ workspace に登録される", () => {
    const db = openDb(":memory:");
    const task = registerTask(
      db,
      {
        type: "work",
        title: "wire the moisture sensor",
        purpose: "get readings flowing",
        completion_criteria: "dashboard shows a live number",
        review_flag: true,
        assignee: "reef-crab",
        workspace: "greenhouse",
      },
      new Date(0),
    );

    completeTask(
      db,
      task,
      {
        outcome: "done",
        deliverables: "PR #5",
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
      "reef-crab",
      new Date(1),
    );

    const board = listBoard(db);
    const review = board.find((t) => t.type === "review" && t.parent_id === task.id);
    expect(review?.workspace).toBe("greenhouse");
  });
});
