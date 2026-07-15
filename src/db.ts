import Database from "better-sqlite3";

export type Db = Database.Database;

// Shared between the fresh-board CREATE and the old-schema rebuild migration
// below (title/purpose/completion_criteria's NOT NULL -> CHECK relaxation) so
// the two can never drift apart.
const TASKS_TABLE_DDL = `
    CREATE TABLE tasks (
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
      -- null only for an issue-backed task (issue #49, ADR 0016): its content
      -- is never snapshotted at registration, only resolved live from the
      -- referenced GitHub issue at each use. The CHECK below enforces the
      -- exclusive-or with github_issue_number below.
      title               TEXT,
      purpose             TEXT,
      completion_criteria TEXT,
      risk_flag           INTEGER NOT NULL DEFAULT 0,
      review_flag         INTEGER NOT NULL DEFAULT 0,
      parent_id           TEXT REFERENCES tasks(id),
      sort_key            REAL NOT NULL,
      handoff_doc         TEXT,
      -- the PR opened for this task's completed work (issue #11), or null —
      -- no workspace/github configured, or nothing to hand off. Set once by
      -- recordPrOpened, never by the MCP layer directly.
      pr_number           INTEGER,
      -- question-only fields (issue #30): 1-4 question items (JSON array of
      -- {title, detail?, options, recommendation} — the common context lives
      -- on purpose), and the human's answers once given, one per item, in
      -- item order. A single-item question is the degenerate case of the
      -- same shape, not a second one.
      question_items           TEXT,
      question_answer          TEXT,
      -- the reject-reason steering channel (issue #40): optional, one per
      -- submission (not per item) — recorded alongside question_answer so a
      -- resumed parent's get_current_task can carry both
      question_answer_comment  TEXT,
      -- system-internal only (ADR 0006): one of the (sole) item's options
      -- that, if answered, cancels the plan instead of the ordinary
      -- unblock-to-head path. Never set via MCP or the JSON API — only the
      -- watchdog's failure-question registration sets it.
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
      -- system-internal only (ADR 0012 / issue #36): the agent name a
      -- quarantine Confirmation question stands in for — set only by
      -- quarantineAgent, the agent-name generalization of the workspace
      -- quarantine above. Never set via MCP or the JSON API.
      question_quarantine_agent TEXT,
      -- issue-backed task reference (issue #49, ADR 0016): the GitHub issue
      -- number this task is a live reference to, or null for an ordinary
      -- task. workspace (already above) doubles as the repo half of the
      -- reference for such a task.
      github_issue_number INTEGER,
      created_at          TEXT NOT NULL,
      -- exactly one content source, exclusively (issue #49, ADR 0016): an
      -- ordinary task carries all three content fields and no
      -- github_issue_number; an issue-backed task carries a
      -- github_issue_number and none of the three — content is never
      -- snapshotted alongside a live reference. Domain code
      -- (assertGithubRef) rejects the same cases before they'd ever reach
      -- this CHECK, but it stays as the DB's own backstop.
      CHECK (
        (github_issue_number IS NOT NULL AND title IS NULL AND purpose IS NULL AND completion_criteria IS NULL)
        OR (github_issue_number IS NULL AND title IS NOT NULL AND purpose IS NOT NULL AND completion_criteria IS NOT NULL)
      )
    )`;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    ${TASKS_TABLE_DDL.replace("CREATE TABLE tasks", "CREATE TABLE IF NOT EXISTS tasks")};

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

    -- an agent name pickup could not resolve against the registry (ADR 0012 /
    -- issue #36): marked needs-human, its tasks stay out of the slot until a
    -- human repairs it — the agent-name generalization of workspace_state.
    CREATE TABLE IF NOT EXISTS agent_state (
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

    -- Pause (issue #34): a single, board-wide, human-only toggle for new-task
    -- pickup — same one-row shape as throttle_state, but with no auto-resume
    -- (CONTEXT.md's Pause: clearing it is purely manual). No row means never
    -- paused.
    CREATE TABLE IF NOT EXISTS pause_state (
      id     INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL
    );

    -- Web Push subscriptions (issue #14): one row per installed PWA that
    -- opted into push. endpoint is the browser's own dedup key (a fresh
    -- subscribe from the same install replaces its old keys).
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh   TEXT NOT NULL,
      auth     TEXT NOT NULL
    );

    -- which question tasks have already reached the human via push (issue
    -- #14), individually or folded into a morning digest — a row here means
    -- "no longer pending notification", regardless of how it was delivered.
    CREATE TABLE IF NOT EXISTS question_notifications (
      task_id     TEXT PRIMARY KEY REFERENCES tasks(id),
      notified_at TEXT NOT NULL
    );

    -- the morning digest's read position in the events table (issue #14) —
    -- separate from log_cursor (the human's own read/unread position in the
    -- decision-log UI): this one tracks what the digest has already reported.
    CREATE TABLE IF NOT EXISTS digest_cursor (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      last_reported INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO digest_cursor (id, last_reported) VALUES (1, 0);

    -- quiet hours config (issue #14): one row, UTC wall-clock "HH:MM" bounds.
    -- No row means never configured — callers fall back to the 23:00–07:00
    -- default rather than reading this table directly.
    CREATE TABLE IF NOT EXISTS quiet_hours (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      start TEXT NOT NULL,
      end   TEXT NOT NULL
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
    "question_items",
    "question_answer",
    "question_answer_comment",
    "question_cancel_option",
    "question_pending_child",
    "question_quarantine_workspace",
    "question_quarantine_agent",
    "workspace",
  ]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
  }
  for (const col of ["pr_number", "question_pending_merge_pr", "github_issue_number"]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} INTEGER`);
  }
  // issue #49 / ADR 0016: title/purpose/completion_criteria's NOT NULL needs
  // relaxing (to CHECK-enforced instead) so an issue-backed task can carry
  // none of the three — SQLite can't drop a column's NOT NULL via ALTER.
  // Unlike throttle_state's drop-and-recreate below, this is real task
  // history, so the table is rebuilt with every existing row carried across
  // (the additive-column loop above already guarantees every column this
  // rebuild names exists on the old table, however old it is).
  const taskColInfo = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  if (taskColInfo.find((c) => c.name === "title")?.notnull === 1) {
    const allCols = taskColInfo.map((c) => c.name).join(", ");
    // Renaming `tasks` itself (rather than building the replacement under a
    // fresh name first) would make SQLite rewrite every other table's own
    // `REFERENCES tasks(id)` to follow it to the renamed-away table — left
    // dangling once that table is dropped. Building under a throwaway name
    // and renaming *that* into place at the end never triggers the rewrite,
    // since nothing references the throwaway name.
    db.exec(TASKS_TABLE_DDL.replace("CREATE TABLE tasks", "CREATE TABLE tasks_post_issue_49"));
    db.exec(`INSERT INTO tasks_post_issue_49 (${allCols}) SELECT ${allCols} FROM tasks;`);
    db.exec(`DROP TABLE tasks;`);
    db.exec(`ALTER TABLE tasks_post_issue_49 RENAME TO tasks;`);
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
