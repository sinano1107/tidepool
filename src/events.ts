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
  // issue #11: a completed work task's handoff opened this PR — pr_number is
  // the durable link the merge dial (escalate/auto_if_ci_green) reads back
  | { kind: "pr_opened"; pr_number: number }
  // issue #11: the merge dial's escalate answer actually merged this PR,
  // right after a live CI check confirmed success immediately beforehand
  | { kind: "pr_merged"; pr_number: number }
  // issue #11: a risk-approval question's "approve" answer raised the
  // parent's risk_flag (upward propagation) — origin_question_id is that
  // question, so the audit trail for the flag flip never needs a join
  | { kind: "risk_flag_raised"; origin_question_id: string }
  // ADR 0006: a task cancelled by an abandon answer's plan-scoped cascade —
  // origin_question_id is the failure question the abandon answer came from,
  // shared by every task the cascade touches (its own subtree included)
  | { kind: "task_cancelled"; origin_question_id: string }
  // recommendation_accepted and recommended_by are first-class: per-agent
  // acceptance rates are a primary statistic, recorded at answer time so they
  // never need a join back through task_registered. One entry per question
  // item, in item order (issue #30) — acceptance is counted per item, not per
  // submission, so "N of M answered per recommendation" stays expressible.
  | {
      kind: "question_answered";
      answers: Array<{ answer: string; recommendation_accepted: boolean }>;
      recommended_by: string;
      // the reject-reason steering channel (issue #40) — one per submission,
      // not per item; absent entirely (not null) when the answer carried none
      comment?: string;
    }
  // a triage objection annotates one log entry (entry_id = event id); the
  // direction comment is mandatory — silence is approval, so the only explicit
  // action carries where to go instead. session_id scopes commit-time bundling
  // to the session the objection was raised in.
  | { kind: "objection_raised"; entry_id: number; comment: string; session_id: number }
  // "this entry was put in front of the human" — the denominator of the
  // objection rate; an entry never displayed is unobserved, not approved
  | { kind: "log_entry_displayed"; entry_id: number; session_id: number }
  // full provenance of an agent run. registry_commit is THE strict agent
  // version (ADR 0001: commit hash = agent version); definition_version is
  // only the human-readable stamp from the definition's frontmatter. The
  // vocabulary is registry-shaped, not vendor-shaped — no CLI names leak in.
  | { kind: "worker_spawned"; registry_commit: string; definition_version: string }
  // issue #21: a workspace already needs-human failed the tree rule again
  // before its open Confirmation question was answered — recorded on that
  // same question rather than opening a second one (CONTEXT.md's Quarantine:
  // "1 workspace につき確認は最大1枚")
  | { kind: "quarantine_refired"; cause: string }
  // issue #21: a quarantine Confirmation question's answer was accepted as a
  // repair confirmation (the board verified the tree clean first) — needs_human
  // cleared, resuming pickup for this workspace
  | { kind: "workspace_reinstated"; workspace: string }
  // ADR 0012 / issue #36: the agent-name generalization of workspace_reinstated
  // above — needs_human cleared for this agent name, resuming pickup for tasks
  // assigned to it
  | { kind: "agent_reinstated"; agent: string }
  // issue #32: pairs with worker_spawned to close out a worker session
  // (spawn~exit) — usage is null when the session ended without a final
  // stream-json `result` event (e.g. watchdog kill); the event itself is
  // always written, so a missing report never erases the session's cost.
  // estimated_cost_usd mirrors the CLI's total_cost_usd verbatim, but named
  // for the board's own vocabulary: under a subscription there is no real
  // invoice, only this run-time API-equivalent estimate.
  | {
      kind: "worker_exited";
      exit_code: number | null;
      signal: string | null;
      // issue #125: the tail (last ~20 lines) of the session's stderr — the
      // only channel CLI-level failures (spawn death, forced termination,
      // auth errors) print to. null means the session wrote no stderr at
      // all, keeping "quiet exit" distinguishable from a broken capture.
      // The verbatim full text lives in <taskId>.stderr.log next to the
      // stream-json transcript; this field is the event-side pointer into it.
      stderr_tail: string | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        estimated_cost_usd: number;
      } | null;
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

/** A log entry annotated with its resolved workspace name (issue #44): the
 *  event's own task's `workspace`, or the board's default when the task
 *  carries none — resolved fresh at read time, never stamped onto the event
 *  itself (same "resolved fresh every use, not pinned" reference semantics
 *  as `resolveExecutionWorkspace`, ADR 0009). */
export interface LogEntry extends EventRow {
  workspace: string | null;
}

export function listLog(db: Db, defaultWorkspaceName?: string): LogEntry[] {
  const placeholders = HUMAN_FACING_KINDS.map(() => "?").join(", ");
  // an inner join is safe here only because task_id is NOT NULL REFERENCES
  // tasks(id) and tasks are never deleted (append-only) — no event can end
  // up orphaned, so this can never silently drop a log entry
  const rows = db
    .prepare(
      `SELECT events.*, COALESCE(tasks.workspace, ?) AS workspace
         FROM events JOIN tasks ON tasks.id = events.task_id
        WHERE events.kind IN (${placeholders}) ORDER BY events.id`,
    )
    .all(defaultWorkspaceName ?? null, ...HUMAN_FACING_KINDS) as Array<
    Omit<EventRow, "payload"> & { payload: string; workspace: string | null }
  >;
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

/** One task's own decision log (issue #29's review-context addendum): the
 *  events table narrowed the same way `listLog` narrows the whole board, but
 *  scoped to a single task_id — the primary resource a review's RCA reads
 *  ("自分は何をどの順で判断したか"). No summarizing middle layer: every
 *  human-facing entry, verbatim. */
export function taskDecisionLog(db: Db, taskId: string): EventRow[] {
  const placeholders = HUMAN_FACING_KINDS.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM events WHERE task_id = ? AND kind IN (${placeholders}) ORDER BY id`,
    )
    .all(taskId, ...HUMAN_FACING_KINDS) as Array<Omit<EventRow, "payload"> & { payload: string }>;
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as EventPayload }));
}

export function getEvent(db: Db, id: number): EventRow | undefined {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
    | (Omit<EventRow, "payload"> & { payload: string })
    | undefined;
  return row && { ...row, payload: JSON.parse(row.payload) as EventPayload };
}

export function listEvents(db: Db, taskId: string): EventRow[] {
  const rows = db
    .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id")
    .all(taskId) as Array<Omit<EventRow, "payload"> & { payload: string }>;
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as EventPayload }));
}
