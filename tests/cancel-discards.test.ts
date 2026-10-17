import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  cancelTaskDirectly,
  completeTask,
  directCancelDiscards,
  getTask,
  listChildren,
  moveTask,
  presentTask,
  questionCancelDiscards,
  registerTask,
  type Task,
} from "../src/tasks.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { answerQuestionViaWebui, decomposeTaskViaWorker, FULL_HANDOFF, failureQuestion, HUMAN_WEBUI, interviewPinChild } from "./harness.js";

/** cancel の面が見せる「捨てられる done の work」の読み(ADR 0271 決定4)。範囲は cascade / abandon と同じ述語。 */
const NOW = new Date("2026-10-17T00:00:00.000Z");

let db: Db;
afterEach(() => db?.close());

function split(parent: Task, children: Array<{ title: string; assignee?: string }>): Task[] {
  decomposeTaskViaWorker(db, parent, { reason: "split it", children: children.map((c) => ({ ...c, purpose: "p", completion_criteria: "c" })) }, "deckhand", NOW);
  return children.map(({ title }) => listChildren(db, parent.id).find((c) => c.type === "work" && c.title === title)!);
}

const done = (task: Task, worker = "deckhand") => completeTask(db, getTask(db, task.id)!, FULL_HANDOFF, worker, NOW, "worker");

it("直接 cancel の範囲の done の work のうち agent が実行したものを、盤面の順で id と題で返す —— 人間が実行したものは入らない", () => {
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [agentDone, humanDone, open] = split(root, [{ title: "a" }, { title: "b", assignee: HUMAN_WORKER_ID }, { title: "c" }]);
  const [deep] = split(open!, [{ title: "c1" }]);
  done(agentDone!);
  done(humanDone!, HUMAN_WORKER_ID);
  done(deep!);
  moveTask(db, getTask(db, deep!.id)!, null, NOW, ...HUMAN_WEBUI);

  expect(directCancelDiscards(db, getTask(db, root.id)!, undefined)).toEqual([
    { id: deep!.id, title: "c1" },
    { id: agentDone!.id, title: "a" },
  ]);
});

it("failure question の abandon は失敗 task の abandon の範囲で読む —— 範囲外の done の兄弟は入らず、cancel option の無い question は空", () => {
  db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [doneSibling, failed, openSibling] = split(parent, [{ title: "s1" }, { title: "f" }, { title: "s2" }]);
  done(doneSibling!);
  const [underFailed] = split(failed!, [{ title: "f1" }]);
  const [underSibling] = split(openSibling!, [{ title: "s2a" }]);
  done(underFailed!);
  done(underSibling!);
  const question = failureQuestion(db, failed!.id, NOW);
  const plain = registerTask(
    db,
    { type: "question", title: "q", purpose: "p", completion_criteria: "answered", parent_id: failed!.id, question: [{ title: "pick", options: ["x", "y"], recommendation: "x" }] },
    NOW,
    ...HUMAN_WEBUI,
  );

  expect(questionCancelDiscards(db, question)).toEqual([
    { id: underFailed!.id, title: "f1" },
    { id: underSibling!.id, title: "s2a" },
  ]);
  expect(questionCancelDiscards(db, plain)).toEqual([]);
});

it("Interview の root の直接 cancel は、done の受験者を捨てるものに数えない", () => {
  db = openDb(":memory:");
  const examinee = interviewPinChild(db, NOW);
  done(examinee);
  const root = getTask(db, presentTask(db, examinee).interview_root_id!)!;

  expect(getTask(db, examinee.id)!.status).toBe("done");
  expect(directCancelDiscards(db, root, undefined)).toEqual([]);
});

it("直接 cancel できない task(agent が分解で登録した子・done の task)は空", () => {
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [child] = split(root, [{ title: "a" }]);
  const [grandchild] = split(child!, [{ title: "a1" }]);
  done(grandchild!);

  expect(directCancelDiscards(db, getTask(db, child!.id)!, undefined)).toEqual([]);
  expect(directCancelDiscards(db, getTask(db, grandchild!.id)!, undefined)).toEqual([]);
});

it.each(["直接 cancel", "failure question の abandon"] as const)("捨てる done の work があっても%sは今どおり通り、done の子は done のまま(gate にしない)", (path) => {
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [doneChild] = split(root, [{ title: "a" }, { title: "b" }]);
  done(doneChild!);
  const question = failureQuestion(db, root.id, NOW);
  expect(questionCancelDiscards(db, question)).toEqual([{ id: doneChild!.id, title: "a" }]);

  if (path === "直接 cancel") {
    answerQuestionViaWebui(db, question, ["retry"], NOW);
    cancelTaskDirectly(db, getTask(db, root.id)!, null, NOW, {}, "webui");
  } else answerQuestionViaWebui(db, question, ["abandon"], NOW);

  expect([root, doneChild].map((task) => getTask(db, task!.id)!.status)).toEqual(["cancelled", "done"]);
});

it("先の abandon で cancelled になった子の下の done の work は、後の直接 cancel の捨てるものに数えない —— 成果はもう捨てられている", () => {
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [doneSibling, failed, openSibling] = split(root, [{ title: "s1" }, { title: "f" }, { title: "s2" }]);
  done(doneSibling!);
  const [underSibling] = split(openSibling!, [{ title: "s2a" }]);
  done(underSibling!);
  answerQuestionViaWebui(db, failureQuestion(db, failed!.id, NOW), ["abandon"], NOW);

  expect(getTask(db, openSibling!.id)!.status).toBe("cancelled");
  expect(directCancelDiscards(db, getTask(db, root.id)!, undefined)).toEqual([{ id: doneSibling!.id, title: "s1" }]);
});

it("答えの済んだ failure question は捨てるものを見せない —— cancel option はもう選べない", () => {
  db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [doneChild] = split(root, [{ title: "a" }, { title: "b" }]);
  done(doneChild!);
  const question = failureQuestion(db, root.id, NOW);
  answerQuestionViaWebui(db, question, ["retry"], NOW);

  expect(questionCancelDiscards(db, getTask(db, question.id)!)).toEqual([]);
});
