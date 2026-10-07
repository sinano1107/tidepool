import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { editTask, listBoard, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

const BASE = { purpose: "p", completion_criteria: "c" } as const;

it("work でない task への review_by は登録時に DomainError で拒否され、task は作られない(#1490)", () => {
  const db = openDb(":memory:");
  expect(() =>
    registerTask(db, { type: "review", title: "r", ...BASE, review_by: ["fugu"] }, new Date(0), ...HUMAN_WEBUI),
  ).toThrow(DomainError);
  expect(listBoard(db)).toHaveLength(0);
  db.close();
});

it("work でない task の review_by を空でない list へ Edit すると DomainError で拒否される(#1498)", () => {
  const db = openDb(":memory:");
  const review = registerTask(db, { type: "review", title: "r", ...BASE }, new Date(0), ...HUMAN_WEBUI);
  expect(() => editTask(db, review, { review_by: ["fugu"] }, new Date(1), HUMAN_WEBUI[1])).toThrow(DomainError);
  expect(listBoard(db)[0]?.review_by).toBe(null);
  db.close();
});

it("review type は review_by 無し・空配列なら今までどおり登録できる", () => {
  const db = openDb(":memory:");
  registerTask(db, { type: "review", title: "none", ...BASE }, new Date(0), ...HUMAN_WEBUI);
  registerTask(db, { type: "review", title: "empty", ...BASE, review_by: [] }, new Date(1), ...HUMAN_WEBUI);
  expect(listBoard(db)).toHaveLength(2);
  db.close();
});

it("work type を review_by: [] で登録すると、返り値も盤面の読みも null になる(#1511)", () => {
  const db = openDb(":memory:");
  const empty = registerTask(db, { type: "work", title: "empty", ...BASE, review_by: [] }, new Date(0), ...HUMAN_WEBUI);
  const omitted = registerTask(db, { type: "work", title: "omitted", ...BASE }, new Date(1), ...HUMAN_WEBUI);
  expect(empty.review_by).toBe(null);
  expect(omitted.review_by).toBe(null);
  const board = listBoard(db);
  expect(board.find((t) => t.id === empty.id)?.review_by).toBe(null);
  expect(board.find((t) => t.id === omitted.id)?.review_by).toBe(null);
  db.close();
});

it("work type の review_by はルートでも子でも受け取られ、保存される", () => {
  const db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "root", ...BASE, review_by: ["fugu"] }, new Date(0), ...HUMAN_WEBUI);
  const child = registerTask(
    db,
    { type: "work", title: "child", ...BASE, parent_id: root.id, review_by: ["fugu"] },
    new Date(1),
    ...HUMAN_WEBUI,
  );
  const board = listBoard(db);
  expect(board.find((t) => t.id === root.id)?.review_by).toEqual(["fugu"]);
  expect(board.find((t) => t.id === child.id)?.review_by).toEqual(["fugu"]);
  db.close();
});
