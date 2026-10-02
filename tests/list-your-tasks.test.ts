import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { completeTask, listYourTasks, presentTask, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

describe("listYourTasks は human 宛ての未決着タスクを返す(issue #13)", () => {
  it("human 宛ての todo は含まれ、他 assignee 宛て・決着済みの human タスクは含まれない", () => {
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
      ...HUMAN_WEBUI,
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
      ...HUMAN_WEBUI,
    );
    const doneHuman = registerTask(
      db,
      {
        type: "work",
        title: "already watered yesterday",
        purpose: "p",
        completion_criteria: "c",
        assignee: "human",
      },
      new Date(2),
      ...HUMAN_WEBUI,
    );
    completeTask(
      db,
      doneHuman,
      {
        outcome: "watered",
        deliverables: "n/a",
        decision_refs: "n/a",
        dead_ends: "n/a",
        resume_context: "n/a",
        known_issues: "n/a",
      },
      "human",
      new Date(3),
      "worker",
    );

    const yours = listYourTasks(db);
    expect(yours.map((t) => t.id)).toEqual([human.id]);
    expect(yours.map((t) => t.id)).not.toContain(agent.id);
    expect(yours.map((t) => t.id)).not.toContain(doneHuman.id);
  });

  it("各行は自分が塞いでいる親を blocking で名指す — 付帯子は塞がない(ADR 0049 / issue #301)", () => {
    const db = openDb(":memory:");
    const lone = registerTask(
      db,
      {
        type: "work",
        title: "physically water the greenhouse",
        purpose: "p",
        completion_criteria: "c",
        assignee: "human",
      },
      new Date(0),
      ...HUMAN_WEBUI,
    );
    const parent = registerTask(
      db,
      { type: "work", title: "parent", purpose: "p", completion_criteria: "c" },
      new Date(1),
      ...HUMAN_WEBUI,
    );
    const awaited = registerTask(
      db,
      {
        type: "work",
        title: "sign the paperwork",
        purpose: "p",
        completion_criteria: "c",
        assignee: "human",
        parent_id: parent.id,
        based_on_decision: 1,
      },
      new Date(2),
      ...HUMAN_WEBUI,
    );
    const attached = registerTask(
      db,
      {
        type: "work",
        title: "repair task attached after the fact",
        purpose: "p",
        completion_criteria: "c",
        assignee: "human",
        parent_id: parent.id,
      },
      new Date(3),
      ...HUMAN_WEBUI,
    );

    const blocking = new Map(listYourTasks(db).map((t) => [t.id, t.blocking]));
    expect(blocking.get(lone.id)).toBeNull();
    expect(blocking.get(awaited.id)).toBe(parent.id);
    expect(blocking.get(attached.id)).toBeNull();

    db.close();
  });

  it("人間担当の親に待たれる子が付くと、行は盤面と同じ解決で blocked に見える(issue #1221)", () => {
    const db = openDb(":memory:");
    const parent = registerTask(
      db,
      { type: "work", title: "rebuild the tide gauge", purpose: "p", completion_criteria: "c", assignee: "human" },
      new Date(0),
      ...HUMAN_WEBUI,
    );
    registerTask(
      db,
      {
        type: "work",
        title: "order the replacement sensor",
        purpose: "p",
        completion_criteria: "c",
        assignee: "human",
        parent_id: parent.id,
        based_on_decision: 1,
      },
      new Date(1),
      ...HUMAN_WEBUI,
    );

    const row = listYourTasks(db).find((t) => t.id === parent.id)!;
    const board = presentTask(db, parent);
    expect(row).toMatchObject({ status: "blocked", assignee: "human", raw_assignee: "human" });
    expect({ status: row.status, assignee: row.assignee, raw_assignee: row.raw_assignee }).toEqual({
      status: board.status,
      assignee: board.assignee,
      raw_assignee: board.raw_assignee,
    });

    db.close();
  });

  it("未回答の question は解決後の assignee が human でも載らない —— 載るかは保存値で決まる(issue #1220)", () => {
    const db = openDb(":memory:");
    const question = registerTask(
      db,
      {
        type: "question",
        title: "which tide gauge?",
        purpose: "choose the data source",
        completion_criteria: "one source is selected",
        question: [{ title: "source", options: ["NOAA", "JMA"], recommendation: "JMA" }],
      },
      new Date(0),
      "planner",
      "webui",
    );

    expect(presentTask(db, question).assignee).toBe("human");
    expect(listYourTasks(db).map((t) => t.id)).not.toContain(question.id);

    db.close();
  });
});
