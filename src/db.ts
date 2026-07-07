import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                  TEXT PRIMARY KEY,
      type                TEXT NOT NULL CHECK (type IN ('work', 'question', 'review')),
      -- 'blocked' is not a stored status: it is derived from unfinished children
      status              TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled')),
      assignee            TEXT,
      title               TEXT NOT NULL,
      purpose             TEXT NOT NULL,
      completion_criteria TEXT NOT NULL,
      risk_flag           INTEGER NOT NULL DEFAULT 0,
      review_flag         INTEGER NOT NULL DEFAULT 0,
      parent_id           TEXT REFERENCES tasks(id),
      sort_key            REAL NOT NULL,
      handoff_doc         TEXT,
      created_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      worker_id  TEXT NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- append-only is enforced by structure, not convention
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `);
  return db;
}
