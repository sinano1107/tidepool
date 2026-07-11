import type { Db } from "./db.js";
import { appendEvent, HUMAN_FACING_KINDS, type EventRow } from "./events.js";
import {
  DEFAULT_AUDITOR_NAME,
  getTask,
  HUMAN_WORKER_ID,
  listBoard,
  moveTask,
  registerTask,
  type BoardTask,
  type Task,
} from "./tasks.js";

export class TriageError extends Error {}

export interface TriageSession {
  id: number;
  started_at: string;
  last_activity_at: string;
  committed_at: string | null;
}

/** Leave a session alone this long and the watchdog commits it for you. */
export const TRIAGE_TIMEOUT = 30 * 60 * 1000;

/** The one open session, if any — the system is single-human, so at most one
 *  triage session is ever open. */
export function activeTriageSession(db: Db): TriageSession | undefined {
  return db
    .prepare("SELECT * FROM triage_sessions WHERE committed_at IS NULL")
    .get() as TriageSession | undefined;
}

/** Open the morning triage session. While it is open, task pickup pauses and
 *  queue application is staged until commit. Idempotent-ish: starting while a
 *  session is already open returns the open one. */
export function startTriage(db: Db, now: Date): TriageSession {
  const open = activeTriageSession(db);
  if (open) return open;
  let session: TriageSession;
  db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO triage_sessions (started_at, last_activity_at) VALUES (?, ?)")
      .run(now.toISOString(), now.toISOString());
    // scratchpad lines a previous session never dispositioned (e.g. a timeout
    // auto-commit) are not lost: the new session adopts them for triage
    db.prepare("UPDATE triage_scratchpad SET session_id = ?").run(Number(lastInsertRowid));
    session = db
      .prepare("SELECT * FROM triage_sessions WHERE id = ?")
      .get(Number(lastInsertRowid)) as TriageSession;
  })();
  return session!;
}

/** Every human touch (answer, objection, scratchpad) defers the auto-commit. */
export function touchTriage(db: Db, now: Date): void {
  db.prepare(
    "UPDATE triage_sessions SET last_activity_at = ? WHERE committed_at IS NULL",
  ).run(now.toISOString());
}

/** A human triage action happened: touch the open session (deferring the
 *  auto-commit) and return it, or undefined when no session is open. The one
 *  entry point for routes that behave differently mid-triage. */
export function triageActivity(db: Db, now: Date): TriageSession | undefined {
  const open = activeTriageSession(db);
  if (open) touchTriage(db, now);
  return open;
}

/** Stage a task for the queue head: applied, in order, at commit. */
export function stageFrontInsert(db: Db, sessionId: number, taskId: string): void {
  db.prepare("INSERT INTO triage_front_inserts (session_id, task_id) VALUES (?, ?)").run(
    sessionId,
    taskId,
  );
}

/** The watchdog tick: commit a session left alone past TRIAGE_TIMEOUT.
 *  Returns true when it committed, so the caller can fire the immediate poll. */
export function autoCommitStaleTriage(db: Db, now: Date): boolean {
  const open = activeTriageSession(db);
  if (!open) return false;
  if (now.getTime() - Date.parse(open.last_activity_at) < TRIAGE_TIMEOUT) return false;
  commitTriage(db, now);
  return true;
}

/** Object to one log entry: the annotation is appended to the entry's task at
 *  once (abandon-safe); bundling into repair tasks happens at commit. The
 *  direction comment is mandatory — validated by the caller's schema, asserted
 *  here so the invariant cannot be bypassed. */
export function raiseObjection(
  db: Db,
  entryId: number,
  comment: string,
  now: Date,
): number {
  const open = activeTriageSession(db);
  if (!open) {
    throw new TriageError("objections are raised inside an open triage session");
  }
  if (!comment.trim()) throw new TriageError("an objection carries a direction comment");
  const entry = requireLogEntry(db, entryId);
  touchTriage(db, now);
  return appendEvent(db, {
    taskId: entry.task_id,
    workerId: HUMAN_WORKER_ID,
    payload: { kind: "objection_raised", entry_id: entryId, comment, session_id: open.id },
    at: now,
  });
}

/** One RCA review, always a child of `objected` sharing its workspace
 *  (CONTEXT.md: children inherit workspace), with the shared RCA discipline
 *  baked into `completion_criteria` (issue #15 layer 2 grilling notes: output
 *  is a diff, prose reflection is forbidden). `comments` land verbatim in
 *  `purpose` — the RCA's only supplied context beyond what get_current_task
 *  (issue #29) already carries. */
function registerRcaReview(
  db: Db,
  objected: Task,
  taskId: string,
  spec: { title: string; purposeIntro: string; comments: string[]; assignee: string },
  now: Date,
): void {
  registerTask(
    db,
    {
      type: "review",
      title: spec.title,
      purpose: `${spec.purposeIntro}:\n` + spec.comments.map((c) => `- ${c}`).join("\n"),
      completion_criteria:
        "root cause lands as a concrete diff (instruction/authority/template change) — no prose reflection",
      parent_id: taskId,
      assignee: spec.assignee,
      workspace: objected.workspace ?? undefined,
    },
    now,
  );
}

/** One repair task per objected task: every direction comment raised against a
 *  task's log entries this session lands in a single work task's purpose.
 *
 *  Layer 2 RCA (issue #15): in parallel, two kinds of read-only RCA review
 *  are generated as children of the objected task, same shape as layer 1's
 *  completion review (workspace inheritance included):
 *
 *  - **self**, one per distinct worker who wrote an objected entry
 *    (CONTEXT.md's Review — 当事者レビュー: "why did I make that call" only
 *    the worker who actually wrote the entry can answer). `assignee` is
 *    baked to that worker's id as a historical fact, not a live pointer
 *    (CONTEXT.md's Review: "確定値であり、ポインタへの参照ではない") — a
 *    human-written entry never spawns one (the final auditor cannot audit
 *    itself).
 *  - **auditor**, always exactly one per objected task regardless of who
 *    wrote the objected entries — its distance from the original judgment is
 *    the value (CONTEXT.md's Review: 独立レビュー), so it fires even when
 *    every entry was human-written. `assignee` is a snapshot of the board's
 *    Auditor pointer taken *now*, at commit time — not resolved fresh at
 *    pickup the way an unset `assignee` (`defaultAgentName`'s own pattern,
 *    ADR 0012) would be. That's a deliberate, narrower simplification: the
 *    existing agent-quarantine gate (`agentQuarantinedSql`, `nextSlotTask`/
 *    `listQueue`) reads `COALESCE(t.assignee, defaultAgentName)` and has no
 *    concept of "the type of this task changes which pointer its unset
 *    assignee falls back to" — leaving `assignee` unset here would silently
 *    bypass that gate for a quarantined Auditor. Baking keeps quarantine
 *    correct today; making the SQL gate (and claude-worker.ts's spawn
 *    resolution, mcp.ts's attribution) type-aware so Auditor can become a
 *    true live pointer — the way layer 1's completion review's own unset
 *    `assignee` would then also benefit from — is tracked separately
 *    (issue #42). */
function bundleObjections(db: Db, sessionId: number, now: Date, auditorName?: string): void {
  const rows = db
    .prepare(
      `SELECT task_id, payload FROM events
       WHERE kind = 'objection_raised' AND json_extract(payload, '$.session_id') = ?
       ORDER BY id`,
    )
    .all(sessionId) as Array<{ task_id: string; payload: string }>;
  const byTask = new Map<string, string[]>();
  const byTaskWorker = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const { comment, entry_id } = JSON.parse(row.payload) as {
      comment: string;
      entry_id: number;
    };
    byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), comment]);
    const entry = requireLogEntry(db, entry_id);
    if (entry.worker_id === HUMAN_WORKER_ID) continue;
    const byWorker = byTaskWorker.get(row.task_id) ?? new Map<string, string[]>();
    byWorker.set(entry.worker_id, [...(byWorker.get(entry.worker_id) ?? []), comment]);
    byTaskWorker.set(row.task_id, byWorker);
  }
  for (const [taskId, comments] of byTask) {
    const objected = getTask(db, taskId);
    if (!objected) continue;
    registerTask(
      db,
      {
        type: "work",
        title: `repair: ${objected.title}`,
        purpose:
          `objections raised against decisions of "${objected.title}":\n` +
          comments.map((c) => `- ${c}`).join("\n"),
        completion_criteria: "every objection direction above is addressed",
      },
      now,
    );
    for (const [workerId, workerComments] of byTaskWorker.get(taskId) ?? []) {
      registerRcaReview(
        db,
        objected,
        taskId,
        {
          title: `rca (self): ${objected.title}`,
          purposeIntro: `objections raised against decisions ${workerId} made on "${objected.title}"`,
          comments: workerComments,
          assignee: workerId,
        },
        now,
      );
    }
    registerRcaReview(
      db,
      objected,
      taskId,
      {
        title: `rca (auditor): ${objected.title}`,
        purposeIntro: `objections raised against decisions of "${objected.title}"`,
        comments,
        assignee: auditorName ?? DEFAULT_AUDITOR_NAME,
      },
      now,
    );
  }
}

export interface ScratchpadLine {
  id: number;
  session_id: number;
  line: string;
}

/** Jot one line on the shared scratchpad — durable at once, from any screen. */
export function addScratchpadLine(db: Db, line: string, now: Date): ScratchpadLine {
  const open = activeTriageSession(db);
  if (!open) throw new TriageError("the scratchpad lives inside an open triage session");
  touchTriage(db, now);
  const { lastInsertRowid } = db
    .prepare("INSERT INTO triage_scratchpad (session_id, line) VALUES (?, ?)")
    .run(open.id, line);
  return db
    .prepare("SELECT * FROM triage_scratchpad WHERE id = ?")
    .get(Number(lastInsertRowid)) as ScratchpadLine;
}

export function listScratchpad(db: Db, sessionId: number): ScratchpadLine[] {
  return db
    .prepare("SELECT * FROM triage_scratchpad WHERE session_id = ? ORDER BY id")
    .all(sessionId) as ScratchpadLine[];
}

export type ScratchpadDisposition = "meta_review" | "task" | "discard";

/** The commit screen's verdict per line: a meta-review task (the condensation
 *  entry point), an ordinary work task, or nothing at all. */
function applyScratchpad(
  db: Db,
  sessionId: number,
  dispositions: Array<{ id: number; disposition: ScratchpadDisposition }>,
  now: Date,
): void {
  const lines = new Map(listScratchpad(db, sessionId).map((l) => [l.id, l]));
  const consume = db.prepare("DELETE FROM triage_scratchpad WHERE id = ?");
  for (const { id, disposition } of dispositions) {
    const line = lines.get(id);
    if (!line) continue;
    // every disposition consumes the line; undisposed lines stay and are
    // adopted by the next session (startTriage)
    consume.run(id);
    if (disposition === "discard") continue;
    registerTask(
      db,
      {
        type: disposition === "meta_review" ? "review" : "work",
        title: line.line,
        purpose: "raised on the triage scratchpad",
        completion_criteria:
          disposition === "meta_review"
            ? "the irritation is distilled into an instruction/authority diff or dismissed"
            : "the line above is resolved",
      },
      now,
    );
  }
}

/** An event id that must point at a decision-log entry (a human-facing kind). */
function requireLogEntry(db: Db, entryId: number): EventRow {
  const entry = db.prepare("SELECT * FROM events WHERE id = ?").get(entryId) as
    | EventRow
    | undefined;
  if (!entry || !(HUMAN_FACING_KINDS as readonly string[]).includes(entry.kind)) {
    throw new TriageError(`event ${entryId} is not a decision-log entry`);
  }
  return entry;
}

/** Record that these log entries were actually put in front of the human.
 *  An entry never displayed is unobserved — neither approved nor rejected —
 *  so the objection-rate denominator counts only what flows through here. */
export function recordDisplayedEntries(db: Db, entryIds: number[], now: Date): void {
  const open = activeTriageSession(db);
  if (!open) throw new TriageError("displayed entries are recorded inside an open triage session");
  db.transaction(() => {
    for (const entryId of entryIds) {
      const entry = requireLogEntry(db, entryId);
      appendEvent(db, {
        taskId: entry.task_id,
        workerId: HUMAN_WORKER_ID,
        payload: { kind: "log_entry_displayed", entry_id: entryId, session_id: open.id },
        at: now,
      });
    }
  })();
}

/** Tasks an open session has staged for the queue head, in staging order. */
export function stagedFrontInserts(db: Db, sessionId: number): string[] {
  const rows = db
    .prepare("SELECT task_id FROM triage_front_inserts WHERE session_id = ? ORDER BY id")
    .all(sessionId) as Array<{ task_id: string }>;
  return rows.map((r) => r.task_id);
}

export type PreviewTask = BoardTask & { front_inserted: boolean };

/** The S3 staged-queue preview: the queue as commit will leave it — this
 *  session's front-inserts on top (highlighted), the rest in live order. The
 *  live queue itself stays untouched until commit. */
export function triagePreview(db: Db, sessionId: number): PreviewTask[] {
  const staged = stagedFrontInserts(db, sessionId);
  const queue = listBoard(db).filter(
    (task) => task.status === "todo" || task.status === "blocked",
  );
  const fronts = staged
    .map((id) => queue.find((task) => task.id === id))
    .filter((task): task is BoardTask => task !== undefined)
    .map((task) => ({ ...task, front_inserted: true }));
  const rest = queue
    .filter((task) => !staged.includes(task.id))
    .map((task) => ({ ...task, front_inserted: false }));
  return [...fronts, ...rest];
}

/** Close the open session and apply everything it staged in one transaction.
 *  The caller fires the immediate poll — pickup resumes only through it.
 *  `auditorName` is the board's Auditor pointer (CONTEXT.md), threaded to
 *  `bundleObjections`' RCA generation — same shape as `defaultAgentName`
 *  elsewhere. */
export function commitTriage(
  db: Db,
  now: Date,
  scratchpad: Array<{ id: number; disposition: ScratchpadDisposition }> = [],
  auditorName?: string,
): TriageSession {
  const open = activeTriageSession(db);
  if (!open) throw new TriageError("no open triage session to commit");
  db.transaction(() => {
    bundleObjections(db, open.id, now, auditorName);
    applyScratchpad(db, open.id, scratchpad, now);
    // apply in reverse staging order so the first-staged task ends up on top
    for (const taskId of stagedFrontInserts(db, open.id).reverse()) {
      const task = getTask(db, taskId);
      if (task && task.status === "todo") moveTask(db, task, null, now);
    }
    db.prepare("UPDATE triage_sessions SET committed_at = ? WHERE id = ?").run(
      now.toISOString(),
      open.id,
    );
  })();
  return db
    .prepare("SELECT * FROM triage_sessions WHERE id = ?")
    .get(open.id) as TriageSession;
}
