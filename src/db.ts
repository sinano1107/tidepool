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
      -- Immutable provenance: the decision-log event this decomposed child
      -- rests on. Null for tasks outside a decomposition decision.
      based_on_decision   INTEGER,
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
      -- system-internal only (ADR 0006 / 0048): the sole item's option that
      -- triggers decision-scoped abandon instead of ordinary unblock-to-head.
      -- Never set via MCP or JSON API; only failure-question registration does.
      question_cancel_option  TEXT,
      -- system-internal only (issue #11): a pending-child approval question's
      -- would-be child, JSON-encoded, materialized only if the human answers
      -- "approve". Never set via MCP or the JSON API — only decomposeTask sets this.
      question_pending_child  TEXT,
      -- system-internal only (issue #11): the PR number a merge-decision
      -- question stands in for. Never set via MCP or the JSON API — only
      -- recordPrOpened's escalate branch sets this.
      question_pending_merge_pr INTEGER,
      -- system-internal only (issue #66): the completed work task whose PR
      -- promotion failed. submitAnswer retries it synchronously on
      -- "retry"; never set through MCP or the JSON API.
      question_pending_pr_promotion_task_id TEXT,
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
      -- system-internal only (issue #60 / ADR 0033): 1 on the single
      -- Confirmation question that stands in for the host's worker sandbox
      -- being unusable. Unlike the workspace/agent quarantines above there is
      -- no resource *name* to key on — the sandbox is a property of the host
      -- the board runs on, so the marker is a flag. Set only by
      -- quarantineSandbox; never via MCP or the JSON API.
      question_quarantine_sandbox INTEGER,
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

// Shared between the fresh-board CREATE and the pre-ADR-0008 rebuild
// migration below, same pattern as TASKS_TABLE_DDL — the two can never drift.
const THROTTLE_STATE_TABLE_DDL = `
    CREATE TABLE throttle_state (
      id                 INTEGER PRIMARY KEY CHECK (id = 1),
      throttled          INTEGER NOT NULL,
      resets_at          TEXT,
      session_throttled  INTEGER,
      session_resume_at  TEXT,
      week_throttled     INTEGER,
      week_resume_at     TEXT,
      fable_throttled    INTEGER,
      fable_resume_at    TEXT
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

    -- pending dumps (issue #61): scratchpad lines dispositioned \`register\`
    -- land here — the Register screen's pending dump (仕上げ待ち) queue, 1
    -- line = 1 row, no auto-merge. Consumed by either a successful
    -- registration built from the line or an explicit discard; until then
    -- the line is never lost. Durable across restart, same as
    -- triage_scratchpad — no session linkage, just a plain table.
    CREATE TABLE IF NOT EXISTS pending_dumps (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      line       TEXT NOT NULL,
      created_at TEXT NOT NULL
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
    -- time. No row means normal (unthrottled). ADR 0030 extends it with the
    -- per-window pace verdicts (which line is hit, and its catch-up instant);
    -- a NULL *_throttled means that window went unobserved (fail-closed).
    ${THROTTLE_STATE_TABLE_DDL.replace("CREATE TABLE throttle_state", "CREATE TABLE IF NOT EXISTS throttle_state")};

    -- Pace offsets (ADR 0030): the human's reserved share (pt) per usage
    -- window — the board runs this far behind the elapsed-time pace line.
    -- One row; no row means the code defaults (session 20 / week 10 /
    -- fable 10). Values are validated at the API entry; the reader guards
    -- out-of-range values back to defaults as well.
    CREATE TABLE IF NOT EXISTS pace_offsets (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      session INTEGER NOT NULL,
      week    INTEGER NOT NULL,
      fable   INTEGER NOT NULL
    );

    -- Pause (issue #34): a single, board-wide, human-only toggle for new-task
    -- pickup — same one-row shape as throttle_state, but with no auto-resume
    -- (CONTEXT.md's Pause: clearing it is purely manual). No row means never
    -- paused.
    CREATE TABLE IF NOT EXISTS pause_state (
      id     INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL
    );

    -- Spend-down (ADR 0030 / issue #128): the human-only end-of-window
    -- burn-down state — drops the target window's pace line, leaving only the
    -- 100% hard cap. One row; no row means inactive. Unlike pause_state it
    -- auto-expires: activated_at predating the target window's observed start
    -- means the window has reset, and the scheduler clears the row.
    CREATE TABLE IF NOT EXISTS spend_down_state (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      window       TEXT NOT NULL CHECK (window IN ('session', 'week')),
      activated_at TEXT NOT NULL
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

    -- which agent-registered human-assignee tasks have already reached the
    -- human via push (issue #116) — the exact twin of question_notifications
    -- above: a human child registered by an agent's decompose blocks its
    -- parent the same way a question does, so it is a notification target of
    -- equal urgency (CONTEXT.md's Quiet hours / Digest). A row here means "no
    -- longer pending notification", however delivered (individual or digest).
    -- Kept a separate table from question_notifications, not a shared one,
    -- because the two notification streams are counted separately in the
    -- morning digest ("N questions · K your tasks · M new log").
    CREATE TABLE IF NOT EXISTS human_task_notifications (
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

    -- quiet hours config (issue #14): one row, "HH:MM" bounds read against
    -- tz's wall clock (issue #63 / ADR 0022) — tz is the one board timezone
    -- (CONTEXT.md's Timezone), not a quiet-hours-specific setting; it lives
    -- here because quiet hours is the one feature that reads it today.
    -- No row means never configured — callers fall back to the 23:00–07:00
    -- Asia/Tokyo default rather than reading this table directly.
    CREATE TABLE IF NOT EXISTS quiet_hours (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      start TEXT NOT NULL,
      end   TEXT NOT NULL,
      tz    TEXT NOT NULL DEFAULT 'Asia/Tokyo'
    );

    -- the one board display language (issue #46): read by two consumers —
    -- the draft prompt's language instruction (this issue) and, later, a
    -- separate display-time-translation feature (not implemented here).
    -- Named after that shared role, not after either consumer, so neither
    -- reads a name that implies it belongs to the other.
    -- No row means never configured — callers fall back to the Japanese
    -- default rather than reading this table directly.
    CREATE TABLE IF NOT EXISTS display_language (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      language TEXT NOT NULL DEFAULT 'Japanese'
    );

    -- display-time translation cache (issue #47 / ADR 0015): keyed by a hash
    -- of the source fragment (not an event id) so every translation target —
    -- decision-log line, completion report, question purpose/item, handoff
    -- doc section — shares one lookup shape regardless of whether its source
    -- lives on an events row or a tasks row. Log entries are immutable
    -- (CONTEXT.md: 記録は不滅・不変) so a cache hit never needs invalidating.
    CREATE TABLE IF NOT EXISTS translation_cache (
      source_hash           TEXT NOT NULL,
      language              TEXT NOT NULL,
      translated            TEXT NOT NULL,
      input_tokens          INTEGER NOT NULL,
      output_tokens         INTEGER NOT NULL,
      cache_read_tokens     INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL,
      estimated_cost_usd    REAL NOT NULL,
      created_at            TEXT NOT NULL,
      PRIMARY KEY (source_hash, language)
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
    "question_pending_pr_promotion_task_id",
    "question_quarantine_workspace",
    "question_quarantine_agent",
    "workspace",
  ]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
  }
  for (const col of [
    "pr_number",
    "question_pending_merge_pr",
    "github_issue_number",
    "question_quarantine_sandbox",
  ]) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} INTEGER`);
  }
  if (!cols.includes("based_on_decision")) {
    db.exec(`ALTER TABLE tasks ADD COLUMN based_on_decision INTEGER`);
    db.exec(`
      UPDATE tasks
      SET based_on_decision = (
        SELECT json_extract(e.payload, '$.based_on_decision')
        FROM events e
        WHERE e.task_id = tasks.id AND e.kind = 'task_registered'
        ORDER BY e.id ASC
        LIMIT 1
      )
      WHERE EXISTS (
        SELECT 1
        FROM events e
        WHERE e.task_id = tasks.id
          AND e.kind = 'task_registered'
          AND json_extract(e.payload, '$.based_on_decision') IS NOT NULL
      )
    `);
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
    const allCols = taskColInfo.map((c) => c.name);
    // a prior crashed run of this same rebuild (e.g. mid-INSERT) can leave a
    // stray, incomplete tasks_post_issue_49 behind since the statements
    // below used to run outside a transaction — drop it before rebuilding.
    // Idempotent regardless of how far a prior crashed attempt got, so it
    // doesn't need to share a transaction with what follows.
    db.exec(`DROP TABLE IF EXISTS tasks_post_issue_49;`);
    // Renaming `tasks` itself (rather than building the replacement under a
    // fresh name first) would make SQLite rewrite every other table's own
    // `REFERENCES tasks(id)` to follow it to the renamed-away table — left
    // dangling once that table is dropped. Building under a throwaway name
    // and renaming *that* into place at the end never triggers the rewrite,
    // since nothing references the throwaway name.
    //
    // foreign_keys stays ON (better-sqlite3's default) through this first
    // transaction, so a dangling parent_id already sitting in old data fails
    // loudly here instead of migrating across silently — parent_id's own
    // `REFERENCES tasks(id)` on the new table still resolves to the old
    // `tasks`, which hasn't been dropped yet, so the check is meaningful.
    db.transaction(() => {
      db.exec(TASKS_TABLE_DDL.replace("CREATE TABLE tasks", "CREATE TABLE tasks_post_issue_49"));
      // old boards may still carry issue #30's superseded question_options /
      // question_recommendation columns (dropped from the schema when
      // question_items replaced them, but never physically dropped from
      // already-created tables — ADD COLUMN above is additive-only). Carry
      // across only columns the new schema still knows about; this rebuild
      // is the natural place to actually drop the dead ones.
      const newCols = (
        db.prepare("PRAGMA table_info(tasks_post_issue_49)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      const carriedCols = allCols.filter((name) => newCols.includes(name)).join(", ");
      db.exec(`INSERT INTO tasks_post_issue_49 (${carriedCols}) SELECT ${carriedCols} FROM tasks;`);
    })();
    // events/triage_front_inserts/etc. hold FK references to tasks(id) with
    // no ON DELETE CASCADE; DROP TABLE tasks below issues an implicit DELETE
    // FROM tasks that FK enforcement would reject outright. The pragma can
    // only be flipped outside a transaction (SQLite no-ops it mid-BEGIN), so
    // it's off for this second transaction alone — narrower than the first,
    // which needed it ON for the parent_id check above. If the process dies
    // between the two transactions, `tasks` is left with title NOT NULL
    // still set, so the next openDb re-enters this whole block and the
    // DROP-IF-EXISTS above clears the completed-but-now-stale copy before
    // redoing both steps — no data loss, just repeated work.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`DROP TABLE tasks;`);
        db.exec(`ALTER TABLE tasks_post_issue_49 RENAME TO tasks;`);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
  // boards created before issue #63 / ADR 0022's board timezone get tz added
  // in place, defaulting to Asia/Tokyo — existing start/end rows keep their
  // HH:MM values (they were entered assuming JST, so a default of Asia/Tokyo
  // makes them mean what they always meant).
  const quietHoursCols = (
    db.prepare("PRAGMA table_info(quiet_hours)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!quietHoursCols.includes("tz")) {
    db.exec(`ALTER TABLE quiet_hours ADD COLUMN tz TEXT NOT NULL DEFAULT 'Asia/Tokyo'`);
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
      ${THROTTLE_STATE_TABLE_DDL};
    `);
  } else if (!throttleCols.includes("session_throttled")) {
    // ADR 0030: additive per-window verdict columns. NULL (the ALTER default)
    // reads as "window unobserved", which is exactly right for a pre-0030
    // last-observed row — the next JIT poll fills them in.
    db.exec(`
      ALTER TABLE throttle_state ADD COLUMN session_throttled INTEGER;
      ALTER TABLE throttle_state ADD COLUMN session_resume_at TEXT;
      ALTER TABLE throttle_state ADD COLUMN week_throttled INTEGER;
      ALTER TABLE throttle_state ADD COLUMN week_resume_at TEXT;
      ALTER TABLE throttle_state ADD COLUMN fable_throttled INTEGER;
      ALTER TABLE throttle_state ADD COLUMN fable_resume_at TEXT;
    `);
  }
  return db;
}
