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
      -- question-only fields: 2-4 choices (JSON array), the registrant's
      -- recommendation, and the human's answer once given
      question_options        TEXT,
      question_recommendation TEXT,
      question_answer         TEXT,
      -- system-internal only (ADR 0006): one of question_options that, if
      -- answered, cancels the plan instead of the ordinary unblock-to-head
      -- path. Never set via MCP or the JSON API — only the watchdog's
      -- failure-question registration sets it.
      question_cancel_option  TEXT,
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

    -- the human's read position in the decision log (the log itself is the
    -- events table, never its own entity): one row, the last-read event id
    CREATE TABLE IF NOT EXISTS log_cursor (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      last_read INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO log_cursor (id, last_read) VALUES (1, 0);

    -- the morning triage session (issue #6): while one is open (committed_at
    -- IS NULL) pickup pauses and queue application is staged until commit
    CREATE TABLE IF NOT EXISTS triage_sessions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at       TEXT NOT NULL,
      -- refreshed on every answer/objection/scratchpad touch; the watchdog
      -- auto-commits a session left alone past the timeout
      last_activity_at TEXT NOT NULL,
      committed_at     TEXT
    );

    -- queue applications staged by an open triage session: tasks this session
    -- will move to the queue head when it commits (e.g. parents unblocked by
    -- an answer). id preserves answer order for the commit-time application.
    CREATE TABLE IF NOT EXISTS triage_front_inserts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES triage_sessions(id),
      task_id    TEXT NOT NULL REFERENCES tasks(id)
    );

    -- the triage scratchpad: irritation lines jotted anywhere in the flow,
    -- durable at once, dispositioned (meta-review / task / discard) at commit
    CREATE TABLE IF NOT EXISTS triage_scratchpad (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES triage_sessions(id),
      line       TEXT NOT NULL
    );

    -- a workspace the slot-release tree rule failed on (conflict, broken
    -- checkout): marked needs-human, its tasks stay out of the slot until a
    -- human repairs it (issue #8)
    CREATE TABLE IF NOT EXISTS workspace_state (
      name        TEXT PRIMARY KEY,
      needs_human INTEGER NOT NULL DEFAULT 0
    );

    -- append-only is enforced by structure, not convention
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `);
  // boards created before the question fields existed get them added in place
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  for (const col of [
    "question_options",
    "question_recommendation",
    "question_answer",
    "question_cancel_option",
  ]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
  }
  return db;
}
