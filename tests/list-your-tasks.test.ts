import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { completeTask, listYourTasks, registerTask } from "../src/tasks.js";

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
    );
    const parent = registerTask(
      db,
      { type: "work", title: "parent", purpose: "p", completion_criteria: "c" },
      new Date(1),
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
    );

    const blocking = new Map(listYourTasks(db).map((t) => [t.id, t.blocking]));
    expect(blocking.get(lone.id)).toBeNull();
    expect(blocking.get(awaited.id)).toBe(parent.id);
    expect(blocking.get(attached.id)).toBeNull();

    db.close();
  });
});
