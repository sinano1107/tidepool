import type { Db } from "./db.js";
import type { TaskType } from "./tasks.js";

/** Payloads are typed per-kind; adding a kind forces the writer through this
 *  union, which is what kills the "wrote to log but forgot stats" bug class. */
export type EventPayload =
  | { kind: "task_registered"; type: TaskType; title: string }
  | { kind: "task_picked_up" }
  | { kind: "task_moved"; after: string | null }
  | { kind: "task_completed"; handoff_present: boolean };

export type EventKind = EventPayload["kind"];

export interface EventRow {
  id: number;
  task_id: string;
  worker_id: string;
  kind: EventKind;
  payload: EventPayload;
  created_at: string;
}

/** The single typed write function: every state change is appended through here. */
export function appendEvent(
  db: Db,
  event: { taskId: string; workerId: string; payload: EventPayload; at: Date },
): void {
  db.prepare(
    "INSERT INTO events (task_id, worker_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    event.taskId,
    event.workerId,
    event.payload.kind,
    JSON.stringify(event.payload),
    event.at.toISOString(),
  );
}

export function listEvents(db: Db, taskId: string): EventRow[] {
  const rows = db
    .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id")
    .all(taskId) as Array<Omit<EventRow, "payload"> & { payload: string }>;
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as EventPayload }));
}
