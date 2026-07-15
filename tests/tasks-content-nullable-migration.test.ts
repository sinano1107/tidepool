import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getTask, registerTask } from "../src/tasks.js";

it("title/purpose/completion_criteria が NOT NULL だった旧スキーマの既存 board は、再オープン時に issue参照タスク(内容が null)を登録できる新スキーマへ移行される(issue #49, ADR 0016)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-db-migrate-"));
  const dbPath = join(dir, "board.sqlite");

  // a board created before issue #49, with title/purpose/completion_criteria NOT NULL
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
       VALUES ('old-task', 'work', 'todo', 'existing title', 'existing purpose', 'existing criteria', 1, '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  legacy.close();

  const db = openDb(dbPath);

  // the pre-existing row survives the migration untouched
  const oldTask = getTask(db, "old-task");
  expect(oldTask?.title).toBe("existing title");

  // an issue-backed task (no stored content) can now register without
  // tripping the old NOT NULL constraint
  const issueBacked = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    new Date(1),
  );

  // nothing is snapshotted (ADR 0016): the stored row itself has no content
  const rawRow = db
    .prepare("SELECT title, purpose, completion_criteria FROM tasks WHERE id = ?")
    .get(issueBacked.id) as { title: string | null; purpose: string | null; completion_criteria: string | null };
  expect(rawRow).toEqual({ title: null, purpose: null, completion_criteria: null });

  // domain code still sees a non-null placeholder (rowToTask/registerTask
  // never hand back a raw null — real content is TaskContentSource's job)
  expect(issueBacked.title).toBe("#49");
  db.close();
});
