import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";

/** ADR 0107 決定1 の schema 層 —— 列そのものを SQL で言う。ドメイン層は値の
 *  解決順と拒否を言い、この層は「新規盤面と既存盤面が同じ列を持つ」を言う。 */
function taskColumns(db: Db): string[] {
  return (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
}

it("新規盤面の tasks は要求2列(tier / priority)を持つ(ADR 0110 決定2)", () => {
  expect(taskColumns(openDb(":memory:"))).toEqual(expect.arrayContaining(["tier", "priority"]));
});

it("新規盤面の tasks は独立した review_by / review_tier を持つ(ADR 0111)", () => {
  const db = openDb(":memory:");
  expect(taskColumns(db)).toEqual(expect.arrayContaining(["review_by", "review_tier"]));
  db.close();
});

it("review 設定列を知らない直前の盤面も移行され、既存行は未指定のまま", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-review-migrate-"));
  const path = join(dir, "board.sqlite");
  const legacy = openDb(path);
  legacy.exec(`
    ALTER TABLE tasks DROP COLUMN review_by;
    ALTER TABLE tasks DROP COLUMN review_tier;
    INSERT INTO tasks (id, type, status, title, purpose, completion_criteria, sort_key, created_at)
    VALUES ('old-task', 'work', 'done', 't', 'p', 'c', 1, '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();
  const db = openDb(path);
  expect(db.prepare("SELECT review_by, review_tier FROM tasks WHERE id = 'old-task'").get()).toEqual({
    review_by: null,
    review_tier: null,
  });
  db.close();
});

it("要求2列を知らない既存盤面は、再オープン時に同じ2列へ移行される —— 新規盤面と migrate 盤面は drift しない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-execution-request-migrate-"));
  const dbPath = join(dir, "board.sqlite");

  // a board created before #543: tasks carries no execution request at all
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE tasks (
      id                  TEXT PRIMARY KEY,
      type                TEXT NOT NULL,
      status              TEXT NOT NULL,
      assignee            TEXT,
      workspace           TEXT,
      title               TEXT NOT NULL,
      purpose             TEXT NOT NULL,
      completion_criteria TEXT NOT NULL,
      risk_flag           INTEGER NOT NULL DEFAULT 0,
      review_flag         INTEGER NOT NULL DEFAULT 0,
      parent_id           TEXT,
      sort_key            REAL NOT NULL,
      handoff_doc         TEXT,
      created_at          TEXT NOT NULL
    );
  `);
  legacy
    .prepare(
      `INSERT INTO tasks (id, type, status, title, purpose, completion_criteria, sort_key, created_at)
       VALUES ('old-task', 'work', 'todo', 't', 'p', 'c', 1, '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  legacy.close();

  const db = openDb(dbPath);
  expect(taskColumns(db)).toEqual(expect.arrayContaining(["tier", "priority"]));
  // 既存行は要求を持たない = 未指定。「既定を選んだ」と記録上区別される側の値。
  expect(db.prepare("SELECT tier, priority FROM tasks WHERE id = 'old-task'").get()).toEqual({
    tier: null,
    priority: null,
  });
  expect(db.prepare("SELECT review_by, review_tier FROM tasks WHERE id = 'old-task'").get()).toEqual({
    review_by: null,
    review_tier: null,
  });
});

it("制約(Provider 制限・予算)は task 側の列として存在しない(ADR 0110 決定2: 制約は workspace と盤面設定の側)", () => {
  const columns = taskColumns(openDb(":memory:"));
  expect(columns).not.toContain("provider");
  expect(columns).not.toContain("budget");
});
