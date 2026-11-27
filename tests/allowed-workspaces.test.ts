import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { approvalAnnotation, cancelTaskDirectly, declarePremiseBreach, getTask, listChildren, placedRoots, presentTask, registerFailureQuestion, registerTask } from "../src/tasks.js";
import { answerQuestionViaWebui, decomposeTaskViaWorker, HUMAN_WEBUI, markPickedUp } from "./harness.js";

const NOW = new Date(0);
const edit = {
  title: "edit registry",
  purpose: "update the registry",
  completion_criteria: "the change is ready",
  place_in_workspace: "reg",
};

it.each([false, true])("requires approval for agent placement and creates a root with risk %s without raising the origin's risk", (risk_flag) => {
  const db = openDb(":memory:");
  try {
    const parent = registerTask(db, { type: "work", title: "plan", purpose: "p", completion_criteria: "c", workspace: "x" }, NOW, ...HUMAN_WEBUI);
    decomposeTaskViaWorker(db, parent, { reason: "the registry is a separate repo", children: [{ ...edit, risk_flag }] }, "deckhand", NOW);

    expect(placedRoots(db, parent.id)).toEqual([]);
    const [approval] = listChildren(db, parent.id);
    expect(approval).toMatchObject({ type: "question", question_items: [{ options: ["approve", "reject"] }] });
    expect(approvalAnnotation(db, approval!)).toEqual({ raises_parent_risk: false });

    answerQuestionViaWebui(db, approval!, ["approve"], NOW);

    const [root] = placedRoots(db, parent.id);
    expect(getTask(db, root!.id)).toMatchObject({
      parent_id: null,
      based_on_decision: null,
      workspace: "reg",
      risk_flag: risk_flag ? 1 : 0,
      origin_task_id: parent.id,
      origin_decision: approval!.based_on_decision,
    });
    expect(getTask(db, parent.id)?.risk_flag).toBe(0);
    expect(listEvents(db, parent.id).map(({ kind }) => kind)).not.toContain("risk_flag_raised");
  } finally {
    db.close();
  }
});

it.each([
  ["review", "cancel origin"],
  ["review", "cancel ancestor"],
  ["repair", "cancel origin"],
  ["repair", "cancel ancestor"],
])("roots placed from a %s origin stay independent when we %s", (kind, cancel) => {
  const db = openDb(":memory:");
  try {
    const task = { purpose: "p", completion_criteria: "c" };
    const work = registerTask(db, { ...task, type: "work", title: "work", workspace: "x" }, NOW, ...HUMAN_WEBUI);
    markPickedUp(db, work.id, NOW);
    const review = registerTask(db, { ...task, type: "review", title: "review", parent_id: work.id }, NOW, ...HUMAN_WEBUI);
    const origin = kind === "review" ? review
      : registerTask(db, { ...task, type: "work", title: "repair", parent_id: review.id }, NOW, ...HUMAN_WEBUI);
    decomposeTaskViaWorker(db, origin, {
      reason: "two registry changes",
      children: [edit, { ...edit, title: "a second registry edit" }],
    }, "deckhand", NOW);
    for (const question of listChildren(db, origin.id).filter((child) => child.type === "question")) {
      answerQuestionViaWebui(db, question, ["approve"], NOW);
    }

    const [first, second] = placedRoots(db, origin.id);
    const placed = getTask(db, first!.id)!;
    const child = registerTask(db, { ...task, type: "work", title: "part of the registry edit", parent_id: placed.id }, NOW, ...HUMAN_WEBUI);
    expect(presentTask(db, origin).status).toBe("todo");
    expect(() => declarePremiseBreach(db, placed, "the premise was wrong", "deckhand", NOW, "worker"))
      .toThrow(/a root task or an attached child escalates instead/);

    registerFailureQuestion(db, placed, "registry edit failed", "the registry edit failed", NOW);
    const failure = listChildren(db, placed.id).find((task) => task.type === "question")!;
    answerQuestionViaWebui(db, failure, ["abandon"], NOW, { comment: "drop this edit" });
    expect(getTask(db, placed.id)?.status).toBe("cancelled");
    expect(getTask(db, child.id)?.status).toBe("cancelled");
    expect(getTask(db, second!.id)?.status).toBe("todo");
    expect(getTask(db, origin.id)?.status).toBe("todo");

    const target = cancel === "cancel origin" ? origin : work;
    cancelTaskDirectly(db, target, null, NOW, {}, "webui");
    expect(getTask(db, target.id)?.status).toBe("cancelled");
    expect(getTask(db, second!.id)?.status).toBe("todo");
  } finally {
    db.close();
  }
});
