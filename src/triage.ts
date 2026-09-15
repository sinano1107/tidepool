import type { AttributionJudgment } from "./attribution.js";
import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import { appendEvent, type EventRow, getEvent, HUMAN_FACING_KINDS } from "./events.js";
import { registerMetaReview } from "./memory.js";
import {
  BOARD_WORKER_ID,
  type BoardTask,
  getTask,
  HUMAN_WORKER_ID,
  listBoard,
  moveTask,
  registerTask,
  type Task,
} from "./tasks.js";

export class TriageError extends Error {}

export interface TriageSession {
  id: number;
  started_at: string;
  last_activity_at: string;
  committed_at: string | null;
  closed_by: "commit" | "timeout" | null;
  timeout_notified: 0 | 1;
}

export interface TriageCommitResult {
  outcome: "closed_now" | "already_closed_by_timeout" | "no_open_session";
  closed_at: string | null;
}

/** Leave a session alone this long and the watchdog closes it. */
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
    session = db
      .prepare("SELECT * FROM triage_sessions WHERE id = ?")
      .get(Number(lastInsertRowid)) as TriageSession;
  })();
  return session!;
}

/** Every human touch (answer, objection, scratchpad, displayed entry) defers
 *  the timeout close. */
export function touchTriage(db: Db, now: Date): void {
  db.prepare(
    "UPDATE triage_sessions SET last_activity_at = ? WHERE committed_at IS NULL",
  ).run(now.toISOString());
}

/** A human triage action happened: open the session when this action belongs
 *  to the triage flow, otherwise touch and return an already-open session. */
export function triageActivity(
  db: Db,
  now: Date,
  openIfNeeded = false,
): TriageSession | undefined {
  const open = activeTriageSession(db);
  if (!open) return openIfNeeded ? startTriage(db, now) : undefined;
  touchTriage(db, now);
  return open;
}

/** Stage a task for the queue head: applied, in order, at commit. */
export function stageFrontInsert(db: Db, sessionId: number, taskId: string): void {
  db.prepare("INSERT INTO triage_front_inserts (session_id, task_id) VALUES (?, ?)").run(
    sessionId,
    taskId,
  );
}

/** The watchdog tick: close a session left alone past TRIAGE_TIMEOUT.
 *  Returns true when it closed one, so the caller can fire the immediate poll. */
export function closeStaleTriage(db: Db, now: Date): boolean {
  const open = activeTriageSession(db);
  if (!open) return false;
  if (now.getTime() - Date.parse(open.last_activity_at) < TRIAGE_TIMEOUT) return false;
  closeTriageSessionOnly(db, now, "timeout");
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
  if (!comment.trim()) throw new TriageError("an objection carries a direction comment");
  const entry = requireLogEntry(db, entryId);
  const open = triageActivity(db, now, true)!;
  return appendEvent(db, {
    taskId: entry.task_id,
    workerId: HUMAN_WORKER_ID,
    origin: "webui",
    payload: { kind: "objection_raised", entry_id: entryId, comment, session_id: open.id },
    at: now,
  });
}

export type DecisionLogEntry = Omit<EventRow, "payload" | "task_id"> & {
  /** decision-log kinds are always task-scoped (only the board-scoped execution_settings_changed / memory_entry_* / memory_index_rebuilt / memory_settings_changed are not) */
  task_id: string;
  payload: Extract<EventRow["payload"], { kind: (typeof HUMAN_FACING_KINDS)[number] }>;
};

/** One objected log entry with every direction comment raised against it this
 *  session (objection event order) and the ids of those objection events. */
interface ObjectionPair {
  entry: DecisionLogEntry;
  comments: string[];
  objection_event_ids: number[];
}

/** The text of a log entry as the human read it — a decision's line, or the
 *  completion report — shared by the repair / RCA purposes and the Board call. */
export function objectedEntryText(entry: DecisionLogEntry): string {
  return entry.payload.kind === "task_completed"
    ? `completion report: ${entry.payload.result ?? "(no outcome recorded)"}`
    : entry.payload.line;
}

/** Render the entry/comment pairs shared by repair and RCA tasks. Entries are
 * ordered by their own event id; comments retain objection event order. */
function renderObjectionPairs(purposeIntro: string, pairs: ObjectionPair[]): string {
  return (
    `${purposeIntro}:\n\n` +
    pairs
      .slice()
      .sort((a: ObjectionPair, b: ObjectionPair) => a.entry.id - b.entry.id)
      .map(
        (pair) =>
          `> ${objectedEntryText(pair.entry)}\n${pair.comments.map((comment) => `- ${comment}`).join("\n")}`,
      )
      .join("\n\n")
  );
}

/** Every entry objected to in one session, grouped per entry in objection
 *  order — the one collection both the Board call (before the transaction)
 *  and the bundling (inside it) read. */
export function listObjectedEntries(db: Db, sessionId: number): ObjectionPair[] {
  const rows = db
    .prepare(
      `SELECT id, payload FROM events
       WHERE kind = 'objection_raised' AND json_extract(payload, '$.session_id') = ?
       ORDER BY id`,
    )
    .all(sessionId) as Array<{ id: number; payload: string }>;
  const pairs = new Map<number, ObjectionPair>();
  for (const row of rows) {
    const { comment, entry_id } = JSON.parse(row.payload) as { comment: string; entry_id: number };
    const pair = pairs.get(entry_id) ?? {
      entry: requireLogEntry(db, entry_id),
      comments: [],
      objection_event_ids: [],
    };
    pair.comments.push(comment);
    pair.objection_event_ids.push(row.id);
    pairs.set(entry_id, pair);
  }
  return [...pairs.values()];
}

/** RCA を要する cause(ADR 0115 決定3): worker か登録者に落ち度がありうる側と、まだ
 *  判定できていない側。`preference` / `requirement_change` / `environment` では
 *  self RCA の問い「なぜ自分はそう判断したか」が空である。 */
const RCA_CAUSES: readonly Cause[] = ["capability", "task_ambiguity", "missing_information", "uncertain"];

/** One RCA review, always a child of `objected` sharing its workspace
 *  (CONTEXT.md: children inherit workspace), with the shared RCA discipline
 *  baked into `completion_criteria` (issue #15 layer 2 grilling notes: output
 *  is a diff, prose reflection is forbidden). The entry/comment pairs land
 *  verbatim in `purpose` — the RCA's only supplied context beyond what
 *  get_current_task (issue #29) already carries. */
function registerRcaReview(
  db: Db,
  objected: Task,
  taskId: string,
  spec: { title: string; purposeIntro: string; pairs: ObjectionPair[]; assignee?: string },
  now: Date,
): void {
  registerTask(
    db,
    {
      type: "review",
      title: spec.title,
      purpose: renderObjectionPairs(spec.purposeIntro, spec.pairs),
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
 *  Before anything is registered, every objected entry gets its attribution
 *  written as an `objection_attributed` event (ADR 0115 決定1〜2): the Board
 *  call's judgment when the commit path asked for one, otherwise `uncertain`
 *  with the reason (`unattributed`) as evidence — close-only / timeout closes
 *  never ask, and an entry the Board call returned nothing for falls the same
 *  way. The set of causes then decides what stands beside the repair (決定3):
 *  only the entries whose cause needs an RCA (`RCA_CAUSES`) feed the two RCA
 *  reviews below, and a task with none of them gets the repair alone.
 *
 *  Layer 2 RCA (issue #15): in parallel, two kinds of read-only RCA review
 *  are generated as children of the objected task, same shape as layer 1's
 *  completion review (workspace inheritance included):
 *
 *  - **self**, one per distinct worker who wrote an RCA-needing objected entry
 *    (CONTEXT.md's Review — 当事者レビュー: "why did I make that call" only
 *    the worker who actually wrote the entry can answer). `assignee` is
 *    baked to that worker's id as a historical fact, not a live pointer
 *    (CONTEXT.md's Review: "確定値であり、ポインタへの参照ではない") — a
 *    human-written entry never spawns one (the final auditor cannot audit
 *    itself).
 *  - **auditor**, exactly one per objected task with an RCA-needing entry,
 *    regardless of who wrote it — its distance from the original judgment is
 *    the value (CONTEXT.md's Review: 独立レビュー), so it fires even when
 *    every entry was human-written. `assignee` is left unset, a live
 *    reference to the board's Auditor pointer resolved fresh at pickup —
 *    the same "unset = live reference" shape `defaultAgentName` itself uses
 *    (ADR 0011), not a value baked here at commit time. This relies on the
 *    agent-quarantine gate (`agentQuarantinedSql`, `nextSlotTask`/
 *    `listQueue`), claude-worker.ts's spawn resolution, and mcp.ts's
 *    attribution all being type-aware — a `review` task's unset `assignee`
 *    falls back to the Auditor pointer, never `defaultAgentName` (issue #42).
 */
function bundleObjections(
  db: Db,
  sessionId: number,
  now: Date,
  judgments: Map<number, AttributionJudgment>,
  unattributed: string,
): void {
  const byTask = new Map<string, ObjectionPair[]>();
  for (const pair of listObjectedEntries(db, sessionId)) {
    byTask.set(pair.entry.task_id, [...(byTask.get(pair.entry.task_id) ?? []), pair]);
  }
  for (const [taskId, pairs] of byTask) {
    const objected = getTask(db, taskId);
    if (!objected) continue;
    const rcaPairs: ObjectionPair[] = [];
    for (const pair of pairs) {
      const judgment = judgments.get(pair.entry.id) ?? {
        cause: "uncertain",
        evidence: `not attributed: ${unattributed}`,
      };
      appendEvent(db, {
        taskId,
        workerId: BOARD_WORKER_ID,
        origin: "board",
        payload: {
          kind: "objection_attributed",
          entry_id: pair.entry.id,
          objection_event_ids: pair.objection_event_ids,
          ...judgment,
          round: "initial",
        },
        at: now,
      });
      if (RCA_CAUSES.includes(judgment.cause)) rcaPairs.push(pair);
    }
    registerTask(
      db,
      {
        type: "work",
        title: `repair: ${objected.title}`,
        purpose: renderObjectionPairs(
          `objections raised against decisions of "${objected.title}"`,
          pairs,
        ),
        completion_criteria: "every objection direction above is addressed",
        parent_id: taskId,
        workspace: objected.workspace ?? undefined,
      },
      now,
    );
    if (rcaPairs.length === 0) continue;
    const byWorker = new Map<string, ObjectionPair[]>();
    for (const pair of rcaPairs) {
      if (pair.entry.worker_id === HUMAN_WORKER_ID) continue;
      byWorker.set(pair.entry.worker_id, [...(byWorker.get(pair.entry.worker_id) ?? []), pair]);
    }
    for (const [workerId, workerPairs] of byWorker) {
      registerRcaReview(
        db,
        objected,
        taskId,
        {
          title: `rca (self): ${objected.title}`,
          purposeIntro: `objections raised against decisions ${workerId} made on "${objected.title}"`,
          pairs: workerPairs,
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
        pairs: rcaPairs,
      },
      now,
    );
  }
}

export interface ScratchpadLine {
  id: number;
  line: string;
}

/** Jot one line on the shared scratchpad — durable at once, from any screen. */
export function addScratchpadLine(db: Db, line: string, now: Date): ScratchpadLine {
  triageActivity(db, now);
  const { lastInsertRowid } = db
    .prepare("INSERT INTO triage_scratchpad (line) VALUES (?)")
    .run(line);
  return db
    .prepare("SELECT * FROM triage_scratchpad WHERE id = ?")
    .get(Number(lastInsertRowid)) as ScratchpadLine;
}

export function listScratchpad(db: Db): ScratchpadLine[] {
  return db.prepare("SELECT * FROM triage_scratchpad ORDER BY id").all() as ScratchpadLine[];
}

export type ScratchpadDisposition = "meta_review" | "task" | "register" | "discard";

/** The commit screen's verdict per line: a meta-review task (the condensation
 *  entry point), an ordinary work task, a pending dump bound for Register
 *  (issue #61 — the line needs writing up, not something a worker can act on
 *  as-is), or nothing at all. */
function applyScratchpad(
  db: Db,
  dispositions: Array<{ id: number; disposition: ScratchpadDisposition }>,
  now: Date,
): void {
  const lines = new Map(listScratchpad(db).map((l) => [l.id, l]));
  const consume = db.prepare("DELETE FROM triage_scratchpad WHERE id = ?");
  for (const { id, disposition } of dispositions) {
    const line = lines.get(id);
    if (!line) continue;
    // every disposition consumes the line; undisposed lines stay on the
    // board-wide scratchpad for a future triage
    consume.run(id);
    if (disposition === "discard") continue;
    if (disposition === "register") {
      db.prepare("INSERT INTO pending_dumps (line, created_at) VALUES (?, ?)").run(
        line.line,
        now.toISOString(),
      );
      continue;
    }
    if (disposition === "meta_review") {
      // ADR 0120 決定2: 主題 memory の手動登録(周期の due は通らない)
      registerMetaReview(db, "memory", now);
      continue;
    }
    registerTask(
      db,
      { type: "work", title: line.line, purpose: "raised on the triage scratchpad", completion_criteria: "the line above is resolved" },
      now,
    );
  }
}

export interface PendingDump {
  id: number;
  line: string;
  created_at: string;
}

/** Register's pending-dump queue (issue #61): lines dispositioned `register`
 *  at triage commit, waiting to be picked, drafted, confirmed, and either
 *  registered or discarded. Durable across restart — plain table read, no
 *  session involved. */
export function listPendingDumps(db: Db): PendingDump[] {
  return db.prepare("SELECT * FROM pending_dumps ORDER BY id").all() as PendingDump[];
}

/** Consumes one pending dump — called either after a task is registered from
 *  its line or on an explicit discard; both remove the row the same way, so
 *  the line is never double-consumed and never silently reappears. */
export function consumePendingDump(db: Db, id: number): void {
  db.prepare("DELETE FROM pending_dumps WHERE id = ?").run(id);
}

/** An event id that must point at a decision-log entry (a human-facing kind). */
function requireLogEntry(db: Db, entryId: number): DecisionLogEntry {
  const entry = getEvent(db, entryId);
  if (!entry || !(HUMAN_FACING_KINDS as readonly string[]).includes(entry.kind)) {
    throw new TriageError(`event ${entryId} is not a decision-log entry`);
  }
  return entry as DecisionLogEntry;
}

/** Record that these log entries were actually put in front of the human.
 *  An entry never displayed is unobserved — neither approved nor rejected —
 *  so the objection-rate denominator counts only what flows through here. */
export function recordDisplayedEntries(db: Db, entryIds: number[], now: Date): void {
  const open = activeTriageSession(db);
  db.transaction(() => {
    if (open) touchTriage(db, now);
    for (const entryId of entryIds) {
      const entry = requireLogEntry(db, entryId);
      appendEvent(db, {
        taskId: entry.task_id,
        workerId: HUMAN_WORKER_ID,
        origin: "webui",
        payload: {
          kind: "log_entry_displayed",
          entry_id: entryId,
          ...(open && { session_id: open.id }),
        },
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
export function triagePreview(
  db: Db,
  sessionId: number | undefined,
  defaultAgentName?: string,
  auditorName?: string,
): PreviewTask[] {
  const staged = sessionId === undefined ? [] : stagedFrontInserts(db, sessionId);
  const queue = listBoard(db, defaultAgentName, auditorName).filter(
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

/** Apply the steering held by one session and record who closed it.
 *  Callers own the transaction so Commit can include scratchpad dispositions.
 *  `judgments` is what the Board call answered per objected entry (gathered
 *  before this transaction); `unattributed` is the evidence an entry without
 *  one is bundled `uncertain` with. */
function closeTriageSession(
  db: Db,
  open: TriageSession,
  now: Date,
  closedBy: "commit" | "timeout",
  judgments: Map<number, AttributionJudgment>,
  unattributed: string,
): void {
  bundleObjections(db, open.id, now, judgments, unattributed);
  // apply in reverse staging order so the first-staged task ends up on top
  for (const taskId of stagedFrontInserts(db, open.id).reverse()) {
    const task = getTask(db, taskId);
    if (task && task.status === "todo") moveTask(db, task, null, now);
  }
  db.prepare("UPDATE triage_sessions SET committed_at = ?, closed_by = ? WHERE id = ?").run(
    now.toISOString(),
    closedBy,
    open.id,
  );
}

/** Close a live session without performing the rest of the Triage terminal —
 *  the close-only door and the timeout watchdog. Neither asks the Board call
 *  (spec #563): their objections are bundled `uncertain`, evidence naming the
 *  path, and the RCAs stand as before. */
export function closeTriageSessionOnly(
  db: Db,
  now: Date,
  closedBy: "commit" | "timeout" = "commit",
): TriageCommitResult {
  const open = activeTriageSession(db);
  if (!open) return { outcome: "no_open_session", closed_at: null };
  const path = closedBy === "timeout" ? "the timeout watchdog" : "close-only";
  db.transaction(() =>
    closeTriageSession(
      db,
      open,
      now,
      closedBy,
      new Map(),
      `the session was closed by ${path} without a Board call`,
    ),
  )();
  return { outcome: "closed_now", closed_at: now.toISOString() };
}

/** End the Triage: apply scratchpad dispositions and close a live session.
 *  `judgments` is what the Board call answered per objected entry (gathered by
 *  the caller before this transaction, `attributeObjections`); absent when no
 *  session was open to ask about. */
export function commitTriage(
  db: Db,
  now: Date,
  scratchpad: Array<{ id: number; disposition: ScratchpadDisposition }> = [],
  judgments: Map<number, AttributionJudgment> = new Map(),
): TriageCommitResult {
  const open = activeTriageSession(db);
  if (!open) {
    let timedOut: Pick<TriageSession, "id" | "committed_at"> | undefined;
    db.transaction(() => {
      applyScratchpad(db, scratchpad, now);
      timedOut = db
        .prepare(
          `SELECT id, committed_at FROM triage_sessions
           WHERE closed_by = 'timeout' AND timeout_notified = 0
           ORDER BY id DESC LIMIT 1`,
        )
        .get() as Pick<TriageSession, "id" | "committed_at"> | undefined;
      if (timedOut) {
        db.prepare("UPDATE triage_sessions SET timeout_notified = 1 WHERE id = ?").run(timedOut.id);
      }
    })();
    return timedOut
      ? { outcome: "already_closed_by_timeout", closed_at: timedOut.committed_at }
      : { outcome: "no_open_session", closed_at: null };
  }
  db.transaction(() => {
    applyScratchpad(db, scratchpad, now);
    closeTriageSession(
      db,
      open,
      now,
      "commit",
      judgments,
      "the Board call returned no judgment for this entry",
    );
  })();
  return { outcome: "closed_now", closed_at: now.toISOString() };
}
