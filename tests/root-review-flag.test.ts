import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { editTask, listBoard, registerTask } from "../src/tasks.js";
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
