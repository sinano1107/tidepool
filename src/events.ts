import type { Db } from "./db.js";
import type { TaskType } from "./tasks.js";

/** Payloads are typed per-kind; adding a kind forces the writer through this
 *  union, which is what kills the "wrote to log but forgot stats" bug class. */
export type EventPayload =
  // based_on_decision points at the decision-log entry (event id) a decomposed
  // child rests on — stamped at registration so provenance never needs a join
  | { kind: "task_registered"; type: TaskType; title: string; based_on_decision?: number }
  | { kind: "decision_logged"; line: string }
  | { kind: "task_picked_up" }
  | { kind: "task_moved"; after: string | null }
  // result carries the one-line outcome against the completion criteria so the
  // log view never joins back to the task row; the handoff doc stays reachable
  // through task_id
  | { kind: "task_completed"; handoff_present: boolean; result: string | null }
  | { kind: "task_escalated"; question_id: string }
  // recommendation_accepted and recommended_by are first-class: per-agent
  // acceptance rates are a primary statistic, recorded at answer time so they
  // never need a join back through task_registered
  | {
      kind: "question_answered";
      answer: string;
      recommendation_accepted: boolean;
      recommended_by: string;
    };

export type EventKind = EventPayload["kind"];

export interface EventRow {
  id: number;
  task_id: string;
  worker_id: string;
  kind: EventKind;
  payload: EventPayload;
  created_at: string;
}

/** The single typed write function: every state change is appended through
 *  here. Returns the event id so entries can be referenced (e.g. a decomposed
 *  child pointing at the decision it rests on). */
export function appendEvent(
  db: Db,
  event: { taskId: string; workerId: string; payload: EventPayload; at: Date },
): number {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO events (task_id, worker_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      event.taskId,
      event.workerId,
      event.payload.kind,
      JSON.stringify(event.payload),
      event.at.toISOString(),
    );
  return Number(lastInsertRowid);
}

/** The decision log is not its own entity: it is the events table narrowed to
 *  the kinds a human skims (issue #5). Kinds join this list; no table is added. */
export const HUMAN_FACING_KINDS = ["decision_logged", "task_completed"] as const;

export function listLog(db: Db): EventRow[] {
  const placeholders = HUMAN_FACING_KINDS.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM events WHERE kind IN (${placeholders}) ORDER BY id`)
    .all(...HUMAN_FACING_KINDS) as Array<Omit<EventRow, "payload"> & { payload: string }>;
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as EventPayload }));
}

export function getLogCursor(db: Db): number {
  const { last_read } = db.prepare("SELECT last_read FROM log_cursor WHERE id = 1").get() as {
    last_read: number;
  };
  return last_read;
}

/** The cursor only ever advances: a stale writer (an old tab) cannot flip
 *  already-read entries back to unread. */
export function advanceLogCursor(db: Db, lastRead: number): number {
  db.prepare("UPDATE log_cursor SET last_read = MAX(last_read, ?) WHERE id = 1").run(lastRead);
  return getLogCursor(db);
}

export function listEvents(db: Db, taskId: string): EventRow[] {
  const rows = db
    .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id")
    .all(taskId) as Array<Omit<EventRow, "payload"> & { payload: string }>;
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as EventPayload }));
}
