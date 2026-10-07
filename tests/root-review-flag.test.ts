import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { editTask, listBoard, type RegisterTaskInput, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

/** ルートは flag によらず完了時にレビューされるので、ルートへの review_flag: true は不発の値として拒否する
 *  (issue #1467 / ADR 0111 決定1 と同じ理由)。 */
const NOW = new Date("2026-10-06T00:00:00.000Z");
const ROOT = { type: "work", title: "root", purpose: "p", completion_criteria: "c" } as const;

let db: Db;
afterEach(() => db?.close());

it("ルートの work に review_flag: true を付けた登録は拒否され、何も登録されない", () => {
  db = openDb(":memory:");

  expect(() => registerTask(db, { ...ROOT, review_flag: true }, NOW, ...HUMAN_WEBUI)).toThrow(DomainError);
  expect(listBoard(db)).toEqual([]);
});

it.each([false, undefined])("ルートの work は review_flag: %s なら今のまま登録される", (review_flag) => {
  db = openDb(":memory:");

  const root = registerTask(db, { ...ROOT, review_flag }, NOW, ...HUMAN_WEBUI);
  expect(listBoard(db).map((task) => task.id)).toEqual([root.id]);
});

it("ルートへの Edit で review_flag: true は拒否され、task_edited は残らない", () => {
  db = openDb(":memory:");
  const root = registerTask(db, ROOT, NOW, ...HUMAN_WEBUI);

  expect(() => editTask(db, root, { review_flag: true }, NOW, "webui")).toThrow(DomainError);
  expect(listEvents(db, root.id).filter((e) => e.kind === "task_edited")).toEqual([]);
});

it("ルートへの Edit で review_flag: false(今の値と同じ)は今のまま no-op", () => {
  db = openDb(":memory:");
  const root = registerTask(db, ROOT, NOW, ...HUMAN_WEBUI);

  expect(editTask(db, root, { review_flag: false }, NOW, "webui").review_flag).toBe(0);
  expect(listEvents(db, root.id).filter((e) => e.kind === "task_edited")).toEqual([]);
});

/** 完了時レビューは work の完了だけが立てる。work でない type(review / question)への review_flag: true は
 *  ルートと同じく不発の値として拒否する(issue #1501 / ADR 0111 決定1、review_by と同じ線)。
 *  question は人間の Edit 対象外(assertHumanEditableScope)なので Edit の経路は無く、登録だけを釘打ちする。 */
const QUESTION: RegisterTaskInput = {
  type: "question",
  title: "q",
  purpose: "p",
  completion_criteria: "c",
  question: [{ title: "which", options: ["a", "b"], recommendation: "a" }],
};

it("親を持つ question に review_flag: true を付けた登録は拒否され、question は作られない", () => {
  db = openDb(":memory:");
  const root = registerTask(db, ROOT, NOW, ...HUMAN_WEBUI);

  expect(() =>
    registerTask(db, { ...QUESTION, parent_id: root.id, review_flag: true }, NOW, ...HUMAN_WEBUI),
  ).toThrow(/review_flag would have no effect — completion review fires for work tasks only/);
  expect(listBoard(db).map((task) => task.id)).toEqual([root.id]);
});

it("親を持つ review type に review_flag: true を付けた登録は拒否される", () => {
  db = openDb(":memory:");
  const root = registerTask(db, ROOT, NOW, ...HUMAN_WEBUI);

  expect(() =>
    registerTask(db, { ...ROOT, type: "review", parent_id: root.id, review_flag: true }, NOW, ...HUMAN_WEBUI),
  ).toThrow(/review_flag would have no effect — completion review fires for work tasks only/);
  expect(listBoard(db).map((task) => task.id)).toEqual([root.id]);
});

it("非ルートの work の子への review_flag: true は、assignee が既定の agent なら受け取られる", () => {
  db = openDb(":memory:");
  const root = registerTask(db, ROOT, NOW, ...HUMAN_WEBUI);

  const child = registerTask(db, { ...ROOT, parent_id: root.id, review_flag: true }, NOW, ...HUMAN_WEBUI);
  expect(child.review_flag).toBe(1);
});

it.each([false, undefined])("work でない type も review_flag: %s なら今のまま登録される", (review_flag) => {
  db = openDb(":memory:");
  const root = registerTask(db, ROOT, NOW, ...HUMAN_WEBUI);

  const question = registerTask(db, { ...QUESTION, parent_id: root.id, review_flag }, NOW, ...HUMAN_WEBUI);
  const review = registerTask(db, { ...ROOT, type: "review", parent_id: root.id, review_flag }, NOW, ...HUMAN_WEBUI);
  expect(listBoard(db).map((task) => task.id)).toEqual(expect.arrayContaining([question.id, review.id]));
});
