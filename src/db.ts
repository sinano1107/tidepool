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
      -- where this task runs (issue #11): a registry workspace name, or null
      -- to inherit the board's default. First-class per CONTEXT.md; resolved
      -- against the registry fresh at every use — pickup, release, watchdog,
      -- restart (issue #26 / ADR 0009) — never pinned to a path.
      workspace           TEXT,
      title               TEXT NOT NULL,
      purpose             TEXT NOT NULL,
      completion_criteria TEXT NOT NULL,
      risk_flag           INTEGER NOT NULL DEFAULT 0,
      review_flag         INTEGER NOT NULL DEFAULT 0,
      parent_id           TEXT REFERENCES tasks(id),
      sort_key            REAL NOT NULL,
      handoff_doc         TEXT,
      -- the PR opened for this task's completed work (issue #11), or null —
      -- no workspace/github configured, or nothing to hand off. Set once by
      -- recordPrOpened, never by the MCP layer directly.
      pr_number           INTEGER,
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
      -- system-internal only (issue #11): a pending-child approval question's
      -- would-be child, JSON-encoded, materialized only if the human answers
      -- "approve". Never set via MCP or the JSON API — only decomposeTask sets this.
      question_pending_child  TEXT,
      -- system-internal only (issue #11): the PR number a merge-decision
      -- question stands in for. Never set via MCP or the JSON API — only
      -- recordPrOpened's escalate branch sets this.
      question_pending_merge_pr INTEGER,
      -- system-internal only (issue #21): the workspace name a quarantine
      -- Confirmation question stands in for — set only by quarantineWorkspace,
      -- read only to dedup a re-fire onto the same open question. Never set
      -- via MCP or the JSON API.
      question_quarantine_workspace TEXT,
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

    -- Swell throttle (ADR 0008): one row, account-scoped (not per-task/
    -- workspace) usage state from the last just-in-time /usage poll at pickup
    -- time. No row means normal (unthrottled).
    CREATE TABLE IF NOT EXISTS throttle_state (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      throttled  INTEGER NOT NULL,
      resets_at  TEXT
    );

    -- the merge dial's auto_if_ci_green queue (issue #11): a completed
    -- low-risk task's just-opened PR, awaiting the CI poll to merge it
    -- unattended. Removed once resolved (merged, or converted to an
    -- escalation question on CI failure) — a risky task never lands here at
    -- all (it asks immediately instead, same as the escalate dial).
    CREATE TABLE IF NOT EXISTS pending_auto_merges (
      task_id   TEXT PRIMARY KEY REFERENCES tasks(id),
      pr_number INTEGER NOT NULL
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
    "question_pending_child",
    "question_quarantine_workspace",
    "workspace",
  ]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
  }
  for (const col of ["pr_number", "question_pending_merge_pr"]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} INTEGER`);
  }
  // ADR 0008 superseded #10's throttle_state shape (state/utilization ->
  // throttled). Unlike the tasks columns above, this isn't an additive
  // change — the old `state` CHECK/NOT NULL can't be relaxed via ALTER, and
  // the row is a last-observed reading, not board history, so a board still
  // on the old shape gets the table rebuilt; the next JIT poll repopulates it.
  const throttleCols = (
    db.prepare("PRAGMA table_info(throttle_state)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (throttleCols.includes("state")) {
    db.exec(`
      DROP TABLE throttle_state;
      CREATE TABLE throttle_state (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        throttled  INTEGER NOT NULL,
        resets_at  TEXT
      );
    `);
  }
  return db;
}
