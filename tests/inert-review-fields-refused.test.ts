import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { decomposeTask, editTask, listBoard, type RegisterTaskInput, registerTask, type Task } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

/** 変更後の状態で完了時レビューが立たない review の値は、登録時も Edit も拒否され、何も残らない(ADR 0111 追記8 / #1553)。
 *  判定は完了時の起票と同じ規則を通る —— 規則そのものは完了時レビューの起票のテストが見ている。 */
const NOW = new Date("2026-10-07T00:00:00.000Z");
const WORK = { type: "work", title: "w", purpose: "p", completion_criteria: "c" } as const;

let db: Db;
let root: Task;
afterEach(() => db?.close());

function setup(): void {
  db = openDb(":memory:");
  root = registerTask(db, WORK, NOW, ...HUMAN_WEBUI);
}

const child = (extra: Partial<RegisterTaskInput>): RegisterTaskInput => ({ ...WORK, parent_id: root.id, ...extra });
const boardIds = () => listBoard(db).map((t) => t.id);
const edits = (task: Task) => listEvents(db, task.id).filter((e) => e.kind === "task_edited");

it.each<[string, Partial<RegisterTaskInput>]>([
  ["human が担当する子への review flag", { assignee: "human", review_flag: true }],
  ["flag の無い子への reviewer の指名", { review_by: ["fugu"] }],
  ["human が担当する task への reviewer の指名", { assignee: "human", risk_flag: true, review_by: ["fugu"] }],
  ["human が担当する子への review_tier", { assignee: "human", risk_flag: true, review_tier: "standard" }],
  ["flag の無い子への review_tier", { review_tier: "standard" }],
  ["human が担当するルートへの reviewer の指名", { parent_id: undefined, assignee: "human", review_by: ["fugu"] }],
])("完了時レビューが立たない登録は拒否され、task は作られない: %s", (_, extra) => {
  setup();
  expect(() => registerTask(db, child(extra), NOW, ...HUMAN_WEBUI)).toThrow(DomainError);
  expect(boardIds()).toEqual([root.id]);
});

it.each<[string, Partial<RegisterTaskInput>, Parameters<typeof editTask>[2]]>([
  ["human に渡すと、保存済みの review flag が意味を失う", { review_flag: true }, { assignee: "human" }],
  ["指名を残したまま review flag を外す", { review_flag: true, review_by: ["fugu"] }, { review_flag: false }],
  ["指名を残したまま risk flag を下ろす", { risk_flag: true, review_by: ["fugu"] }, { risk_flag: false }],
  ["指名を残したまま human に渡す", { risk_flag: true, review_by: ["fugu"] }, { assignee: "human" }],
  ["flag の無い子へ指名する", {}, { review_by: ["fugu"] }],
])("変更後に完了時レビューが立たない Edit は拒否され、task_edited は残らない: %s", (_, registered, edit) => {
  setup();
  const task = registerTask(db, child(registered), NOW, ...HUMAN_WEBUI);
  expect(() => editTask(db, task, edit, NOW, "webui")).toThrow(DomainError);
  expect(edits(task)).toEqual([]);
});

it("review flag と指名を同じ Edit で外せば通る", () => {
  setup();
  const task = registerTask(db, child({ review_flag: true, review_by: ["fugu"] }), NOW, ...HUMAN_WEBUI);
  const edited = editTask(db, task, { review_flag: false, review_by: [] }, NOW, "webui");
  expect([edited.review_flag, edited.review_by]).toEqual([0, null]);
});

it("human から agent に渡すのと同じ Edit で reviewer を指名すれば通る", () => {
  setup();
  const task = registerTask(db, { ...WORK, assignee: "human" }, NOW, ...HUMAN_WEBUI);
  const edited = editTask(db, task, { assignee: "", review_by: ["fugu"] }, NOW, "webui");
  expect(edited.review_by).toEqual(["fugu"]);
});

it.each([
  ["権限内で直接登録される子", undefined],
  ["権限外の assignee で承認 question に変わる子", { assignable_to: [] }],
])("分解の flag の無い子への reviewer の指名は、子も承認 question も作られずに拒否される: %s", (_, authority) => {
  setup();
  const spec = { title: "c", purpose: "p", completion_criteria: "c", assignee: "fugu", review_by: ["fugu"] };
  expect(() =>
    decomposeTask(db, root, { reason: "split", children: [spec] }, "agent-a", NOW, authority, undefined, "worker"),
  ).toThrow(DomainError);
  expect(boardIds()).toEqual([root.id]);
});

it("分解で risk を上げて承認 question に変わる、human が担当する子への review flag も先に拒否される", () => {
  setup();
  const spec = { title: "c", purpose: "p", completion_criteria: "c", assignee: "human", risk_flag: true, review_flag: true };
  expect(() =>
    decomposeTask(db, root, { reason: "split", children: [spec] }, "agent-a", NOW, undefined, undefined, "worker"),
  ).toThrow(DomainError);
  expect(boardIds()).toEqual([root.id]);
});
