import { type AssigneeDeps, assertAssigneeCanTake } from "./assignee.js";
import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import {
  appendEvent,
  currentAttributions,
  type DecisionLogEntry,
  type EventOrigin,
  getEvent,
  HUMAN_FACING_KINDS,
  isDecisionLogEntry,
  latestEventOfTask,
  listEventsOfKinds,
  parseEventRow,
  SKIM_TASK_SQL,
  sessionSpawnOf,
  taskDecisionLog,
} from "./events.js";
import type { MetaReviewSubject } from "./meta-review.js";
import { normalizeText, whyBlank } from "./required-text.js";
import type { GatedJudgment, InitialJudgment } from "./retrospective.js";
import {
  auditedPosedEventId,
  type BoardTask,
  derivedWorkspaceSql,
  getTask,
  isArtifactDiscarded,
  isAuditSql,
  latestPosedProbe,
  lineageSubjectOf,
  listBoard,
  moveTask,
  type RegisterTaskInput,
  type RepairType,
  registerTask,
} from "./tasks.js";
import {
  BOARD_WORKER_ID,
  HUMAN_WORKER_ID,
} from "./worker-id.js";

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
  /** 振り分け(`task`)が作ったタスク数。セッションの有無に依らず、1件でも
   *  作れば候補が増えているので pickup の契機になる(ADR 0119 決定2)。 */
  created_tasks: number;
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
export function closeStaleTriage(db: Db, now: Date, assigneeDeps: AssigneeDeps = {}): boolean {
  const open = activeTriageSession(db);
  if (!open) return false;
  if (now.getTime() - Date.parse(open.last_activity_at) < TRIAGE_TIMEOUT) return false;
  closeTriageSessionOnly(db, now, "timeout", assigneeDeps);
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
  if (whyBlank(comment)) throw new TriageError("an objection carries a direction comment");
  const entry = requireLogEntry(db, entryId);
  // ADR 0268 決定1: 受験者の答案は root の採点1本で観測する —— 採点への不服は root の行へ
  if (getTask(db, entry.task_id)?.interview_target_id != null) {
    throw new DomainError("this entry belongs to an Interview's answer task, which is judged only by the Interview's scoring — object to the Interview root's entries instead");
  }
  const open = triageActivity(db, now, true)!;
  return appendEvent(db, {
    taskId: entry.task_id,
    workerId: HUMAN_WORKER_ID,
    origin: "webui",
    payload: { kind: "objection_raised", entry_id: entryId, comment: normalizeText(comment), session_id: open.id },
    at: now,
  });
}

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

/** One objection (`objection_raised`) against a log entry — a steering comment. */
interface Objection {
  id: number;
  entry_id: number;
  comment: string;
  session_id: number;
}

/** The one read of objection comments: every read of an entry's steering goes
 *  through `entryObjections` / `objectionsById`, both in objection event order
 *  (counts and id watermarks elsewhere read no comment). */
function selectObjections(db: Db, where: string, params: unknown[]): Objection[] {
  return db
    .prepare(
      `SELECT id, json_extract(payload, '$.entry_id') AS entry_id,
              json_extract(payload, '$.comment') AS comment,
              json_extract(payload, '$.session_id') AS session_id
         FROM events WHERE kind = 'objection_raised' ${where} ORDER BY id`,
    )
    .all(...params) as Objection[];
}

/** Every objection ever raised against these entries (every entry when omitted),
 *  across sessions — one query however many entries. */
export function entryObjections(db: Db, entryIds?: number[]): Objection[] {
  const where = entryIds ? `AND json_extract(payload, '$.entry_id') IN (${entryIds.map(() => "?").join(", ")})` : "";
  return selectObjections(db, where, entryIds ?? []);
}

/** Exactly these objection events against `entryId` — an attribution's
 *  `objection_event_ids`. An id that is not an objection, or is one against
 *  another entry, throws rather than dropping out of the steering. */
export function objectionsById(db: Db, entryId: number, ids: number[]): Objection[] {
  const found = new Map(selectObjections(db, `AND id IN (${ids.map(() => "?").join(", ")})`, ids).map((o) => [o.id, o]));
  return ids.map((id) => {
    const o = found.get(id);
    if (!o) throw new TriageError(`event ${id} is not an objection`);
    if (o.entry_id !== entryId) throw new TriageError(`objection ${id} is against entry ${o.entry_id}, not ${entryId}`);
    return o;
  });
}

/** Render the entry/comment pairs shared by repair and RCA tasks. Entries are
 * ordered by their own event id; comments retain objection event order.
 * `judgments` is the repair's alone (ADR 0213 決定3): each judged pair gets a
 * `board judged:` line, except `uncertain` which tells the worker nothing. RCA
 * purposes never pass it — their findings are the second round's evidence.
 * `entryIds: true` is the RCA's alone: each quote names its entry, the ids
 * `complete_rca`'s findings must cover (ADR 0278 決定3 の項目の注入). */
function renderObjectionPairs(
  purposeIntro: string,
  pairs: ObjectionPair[],
  { judgments, entryIds }: { judgments?: Map<number, GatedJudgment>; entryIds?: boolean },
): string {
  return (
    `${purposeIntro}:\n\n` +
    pairs
      .slice()
      .sort((a: ObjectionPair, b: ObjectionPair) => a.entry.id - b.entry.id)
      .map((pair) => {
        const judgment = judgments?.get(pair.entry.id);
        const judged =
          judgment && judgment.cause !== "uncertain" ? `\nboard judged: ${judgment.cause} — ${judgment.evidence}` : "";
        const quoted = entryIds ? `entry ${pair.entry.id}: ${objectedEntryText(pair.entry)}` : objectedEntryText(pair.entry);
        return `> ${quoted}\n${pair.comments.map((comment) => `- ${comment}`).join("\n")}${judged}`;
      })
      .join("\n\n")
  );
}

/** Every entry objected to in one session, grouped per entry in objection
 *  order — the one collection both the Board call (before the transaction)
 *  and the bundling (inside it) read. */
export function listObjectedEntries(db: Db, sessionId: number): ObjectionPair[] {
  const pairs = new Map<number, ObjectionPair>();
  for (const { id, comment, entry_id } of selectObjections(db, "AND json_extract(payload, '$.session_id') = ?", [sessionId])) {
    const pair = pairs.get(entry_id) ?? {
      entry: requireLogEntry(db, entry_id),
      comments: [],
      objection_event_ids: [],
    };
    pair.comments.push(comment);
    pair.objection_event_ids.push(id);
    pairs.set(entry_id, pair);
  }
  return [...pairs.values()];
}

/** RCA を要する cause(ADR 0115 決定3): worker か文面の書き手に落ち度がありうる側と、まだ
 *  判定できていない側。`preference` / `requirement_change` / `environment` / `memory`(ADR 0166 決定4)では
 *  self RCA の問い「なぜ自分はそう判断したか」が空である。判断の無い entry も
 *  `uncertain` と同じくこちら側(ADR 0168 決定3)。 */
const RCA_CAUSES: readonly Cause[] = ["capability", "task_ambiguity", "missing_information", "uncertain"];

/** One RCA review, always a child of the objected task `taskId`, following its nearest fixed
 *  ancestor's workspace (ADR 0290), with the shared RCA discipline
 *  baked into `completion_criteria` (issue #15 layer 2 grilling notes: output
 *  is a diff, prose reflection is forbidden). The entry/comment pairs land
 *  verbatim in `purpose` — the RCA's only supplied context beyond what
 *  get_current_task (issue #29) already carries. */
function registerRcaReview(
  db: Db,
  taskId: string,
  spec: { title: string; purposeIntro: string; pairs: ObjectionPair[]; assignee?: string },
  now: Date,
): void {
  registerTask(
    db,
    {
      type: "review",
      title: spec.title,
      purpose: renderObjectionPairs(spec.purposeIntro, spec.pairs, { entryIds: true }),
      completion_criteria:
        "root cause lands as a concrete diff (instruction/authority/template change) — no prose reflection",
      parent_id: taskId,
      assignee: spec.assignee,
      objection_event_ids: spec.pairs.flatMap((p) => p.objection_event_ids),
    },
    now,
    // 盤面の規則が立てる(ADR 0194 決定3)—— どの閉じ方でも盤面名義
    BOARD_WORKER_ID,
    "board",
  );
}

/** Repair tasks per objected task, split by row kind (ADR 0272 決定1・2, reading
 *  ADR 0268 決定3 as 「行の成果の帰り先」). Every direction comment raised against
 *  the task's decision rows this session lands in one work repair's purpose, and
 *  every one against its memory-write rows — and, on a memory meta-review, its typed
 *  judgment rows, which name their object (ADR 0279 決定3) — in one `memory_repair`'s purpose, and every
 *  one against a routing meta-review's typed judgment rows in one `routing_repair`'s (ADR 0279 決定4): a task
 *  objected on both kinds gets two children, each carrying only its own group's
 *  objections. An Interview root (its probe is fixed by retry, not repair) and a
 *  task whose artifact is discarded — the task itself is cancelled, or a cancelled
 *  work ancestor sits between it and its root (ADR 0271 決定1・2) — get no work
 *  repair: it is skipped, never left to the registration floor's refusal. A
 *  subject task's (memory / routing meta-review) decision rows have no work
 *  repair either: the work type lacks the subject's verbs (ADR 0279 決定3・4), and a
 *  row naming no object (the completion row, a free-text log_decision row) gets no repair at all. The
 *  subject repairs stand whatever the parent's state. Attribution and the RCAs
 *  below stand by cause either way, never split by group.
 *
 *  Before anything is registered, every objected entry the Board call judged
 *  gets that judgment written as an `objection_attributed` event (ADR 0115
 *  決定1〜2). An entry without one — close-only / timeout closes never ask, and
 *  the commit path's call can be unavailable or fail — gets no event at all:
 *  the record holds judgments only (ADR 0168 決定2). The set of causes then
 *  decides what stands beside the repair (0115 決定3): only the entries whose
 *  cause needs an RCA (`RCA_CAUSES`) or that carry no judgment (read as
 *  `uncertain`, ADR 0168 決定3) feed the two RCA reviews below, and a task
 *  with none of them gets only the repairs that stand above. The second attribution round picks
 *  the unjudged ones up once those RCAs settle.
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
 *    reference to the board's Auditor pointer resolved fresh at pickup, not
 *    a value baked here at commit time — and, unlike an unset work
 *    assignee, pickup leaves it unset too (ADR 0233 決定3). This relies on the
 *    agent-quarantine gate (`typeAwareDefaultAgentSql`, `nextSlotTask`/
 *    `listQueue`), claude-worker.ts's spawn resolution, and mcp.ts's
 *    attribution all being type-aware — a `review` task's unset `assignee`
 *    falls back to the Auditor pointer, never `defaultAgentName` (issue #42).
 */
function bundleObjections(
  db: Db,
  sessionId: number,
  now: Date,
  judgments: Map<number, InitialJudgment>,
  origin: EventOrigin,
  assigneeDeps: AssigneeDeps,
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
      const judgment = judgments.get(pair.entry.id);
      if (!judgment || RCA_CAUSES.includes(judgment.cause)) rcaPairs.push(pair);
      if (!judgment) continue;
      // 判定の後に log が伸びていなければ、この event の id で切っても判定が読んだ範囲と同じ —— 欄を持たない(#1572)
      const { decision_log_through, ...judged } = judgment;
      const grown = decision_log_through !== undefined && taskDecisionLog(db, taskId).at(-1)!.id !== decision_log_through;
      appendEvent(db, {
        taskId,
        workerId: BOARD_WORKER_ID,
        origin: "board",
        payload: {
          kind: "objection_attributed",
          entry_id: pair.entry.id,
          objection_event_ids: pair.objection_event_ids,
          ...judged,
          round: "initial",
          ...(grown ? { decision_log_through } : {}),
        },
        at: now,
      });
    }
    const registerRepair = (type: "work" | RepairType, titlePrefix: string, rows: string, group: ObjectionPair[]): void => {
      // 列が名前なら列、空の参照(review / interview)なら走らせた agent(ADR 0275 決定2)。question の空は参照でなく人間 ——
      // listBoard の SQL が question の assignee を human と読むのと同じ値にする(#2377)
      let assignee = objected.type === "question" ? HUMAN_WORKER_ID : (objected.assignee ?? latestEventOfTask(db, taskId, "worker_spawned")?.worker_id);
      let assigneeNotCopied: RegisterTaskInput["assignee_not_copied"];
      try {
        assertAssigneeCanTake(assigneeDeps, assignee, type);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        assigneeNotCopied = { name: assignee!, reason: err.message };
        assignee = undefined;
      }
      registerTask(
        db,
        {
          type,
          title: `${titlePrefix}: ${objected.title}`,
          purpose: renderObjectionPairs(
            `objections raised against ${rows} of "${objected.title}"`,
            group,
            { judgments },
          ),
          completion_criteria: "every objection direction above is addressed",
          parent_id: taskId,
          assignee,
          assignee_not_copied: assigneeNotCopied,
          workspace: objected.workspace ?? undefined,
          objection_event_ids: group.flatMap((p) => p.objection_event_ids),
        },
        now,
        HUMAN_WORKER_ID,
        origin,
      );
    };
    // 判断の行の成果はブランチに帰り、記憶の書き込みの行の成果は記憶の店に残る(ADR 0272 決定1・2)。meta-review の型つきの判断の行は
    // 対象を名指すので主題の修理子に束ねる —— memory は書き込みの行と同じ memory_repair 1本、routing は routing_repair(ADR 0279 決定3・4)
    const judges = (pair: ObjectionPair, kind: MetaReviewSubject) => pair.entry.payload.kind === "decision_logged" && pair.entry.payload.judgment?.kind === kind;
    const judgesMemory = (pair: ObjectionPair) => judges(pair, "memory");
    const memoryRows = pairs.filter((pair) => pair.entry.kind === "memory_written" || judgesMemory(pair));
    const routingRows = pairs.filter((pair) => judges(pair, "routing"));
    const decisionRows = pairs.filter((pair) => !memoryRows.includes(pair) && !routingRows.includes(pair));
    // Interview の監査の判断の行も修理子を持たない —— 出題を直すのは root の出題し直しで、監査の成果は残らない(ADR 0273 決定3)
    // 行の主題を持つ task(meta-review、その下の主題の修理子・RCA とその子孫)の判断の行も work の修理子を持たない —— 主題 verb は work に
    // 登録されず、直すブランチも無い(ADR 0279 決定3・4 / ADR 0283 決定2)
    if (decisionRows.length > 0 && objected.type !== "interview" && lineageSubjectOf(db, taskId) === null && auditedPosedEventId(db, taskId) === undefined && objected.status !== "cancelled" && !isArtifactDiscarded(db, taskId)) {
      registerRepair("work", "repair", "decisions", decisionRows);
    }
    if (memoryRows.length > 0) {
      const kinds = [...(memoryRows.some((pair) => !judgesMemory(pair)) ? ["memory writes"] : []), ...(memoryRows.some(judgesMemory) ? ["memory judgments"] : [])];
      registerRepair("memory_repair", "memory repair", kinds.join(" and "), memoryRows);
    }
    if (routingRows.length > 0) registerRepair("routing_repair", "routing repair", "routing judgments", routingRows);
    if (rcaPairs.length === 0) continue;
    const byWorker = new Map<string, ObjectionPair[]>();
    for (const pair of rcaPairs) {
      if (pair.entry.worker_id === HUMAN_WORKER_ID) continue;
      byWorker.set(pair.entry.worker_id, [...(byWorker.get(pair.entry.worker_id) ?? []), pair]);
    }
    for (const [workerId, workerPairs] of byWorker) {
      registerRcaReview(
        db,
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

export type ScratchpadDisposition = "task" | "register" | "discard";

/** The commit screen's verdict per line: an ordinary work task, a pending
 *  dump bound for Register (issue #61 — the line needs writing up, not
 *  something a worker can act on as-is), or nothing at all. */
function applyScratchpad(
  db: Db,
  dispositions: Array<{ id: number; disposition: ScratchpadDisposition }>,
  now: Date,
): number {
  const lines = new Map(listScratchpad(db).map((l) => [l.id, l]));
  let created = 0;
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
    created++;
    registerTask(
      db,
      { type: "work", title: line.line, purpose: "raised on the triage scratchpad", completion_criteria: "the line above is resolved" },
      now,
      HUMAN_WORKER_ID,
      "webui",
    );
  }
  return created;
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
export function requireLogEntry(db: Db, entryId: number): DecisionLogEntry {
  const entry = getEvent(db, entryId);
  if (!isDecisionLogEntry(entry)) throw new TriageError(`event ${entryId} is not a decision-log entry`);
  return entry;
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
  interviewerName?: string,
): PreviewTask[] {
  const staged = sessionId === undefined ? [] : stagedFrontInserts(db, sessionId);
  const queue = listBoard(db, defaultAgentName, auditorName, interviewerName).filter(
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
 *  before this transaction); an entry without one is bundled unattributed. */
function closeTriageSession(
  db: Db,
  open: TriageSession,
  now: Date,
  closedBy: "commit" | "timeout",
  judgments: Map<number, InitialJudgment>,
  assigneeDeps: AssigneeDeps,
): void {
  // タイムアウトは盤面の watchdog が起こす(ADR 0194 決定4)
  const origin = closedBy === "timeout" ? "board" : "webui";
  bundleObjections(db, open.id, now, judgments, origin, assigneeDeps);
  // apply in reverse staging order so the first-staged task ends up on top
  for (const taskId of stagedFrontInserts(db, open.id).reverse()) {
    const task = getTask(db, taskId);
    if (task && task.status === "todo") moveTask(db, task, null, now, HUMAN_WORKER_ID, origin);
  }
  db.prepare("UPDATE triage_sessions SET committed_at = ?, closed_by = ? WHERE id = ?").run(
    now.toISOString(),
    closedBy,
    open.id,
  );
}

/** Close a live session without performing the rest of the Triage terminal —
 *  the close-only door and the timeout watchdog. Neither asks the Board call
 *  (spec #563): their objections are bundled unattributed — no attribution
 *  event — and the RCAs stand as before (ADR 0168 決定2). */
export function closeTriageSessionOnly(
  db: Db,
  now: Date,
  closedBy: "commit" | "timeout",
  assigneeDeps: AssigneeDeps = {},
): TriageCommitResult {
  const open = activeTriageSession(db);
  if (!open) return { outcome: "no_open_session", closed_at: null, created_tasks: 0 };
  db.transaction(() => closeTriageSession(db, open, now, closedBy, new Map(), assigneeDeps))();
  return { outcome: "closed_now", closed_at: now.toISOString(), created_tasks: 0 };
}

/** End the Triage: apply scratchpad dispositions and close a live session.
 *  `judgments` is what the Board call answered per objected entry (gathered by
 *  the caller before this transaction, `attributeObjections`); absent when no
 *  session was open to ask about. */
export function commitTriage(
  db: Db,
  now: Date,
  scratchpad: Array<{ id: number; disposition: ScratchpadDisposition }> = [],
  judgments: Map<number, InitialJudgment> = new Map(),
  assigneeDeps: AssigneeDeps = {},
): TriageCommitResult {
  const open = activeTriageSession(db);
  if (!open) {
    let timedOut: Pick<TriageSession, "id" | "committed_at"> | undefined;
    let created = 0;
    db.transaction(() => {
      created = applyScratchpad(db, scratchpad, now);
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
      ? { outcome: "already_closed_by_timeout", closed_at: timedOut.committed_at, created_tasks: created }
      : { outcome: "no_open_session", closed_at: null, created_tasks: created };
  }
  let created = 0;
  db.transaction(() => {
    created = applyScratchpad(db, scratchpad, now);
    closeTriageSession(db, open, now, "commit", judgments, assigneeDeps);
  })();
  return { outcome: "closed_now", closed_at: now.toISOString(), created_tasks: created };
}

/** A log entry annotated with its resolved workspace name (issue #44): the
 *  event's own task's `workspace` (written at pickup, ADR 0233), or the
 *  board's default when the task carries none — a task never picked up,
 *  resolved at read time and never stamped onto the event itself. Also carries every objection
 *  ever raised against the entry (ADR 0085) — the annotation is a fact of
 *  the entry, not a session's state, so bundled and still commit-pending
 *  objections both ride along. `session_id` is the sole fact the read model
 *  hands the caller for telling the two apart (against the current open
 *  session, if any); `at` and who raised it are deliberately left out
 *  (issue #371). The entry's current attribution `cause` (and its `entries`, ADR 0166) — the last
 *  objection bundle's judgment (ADR 0170) — is joined at read time from append-only
 *  `objection_attributed` events (ADR 0115). */
export interface LogEntry extends DecisionLogEntry {
  workspace: string | null;
  objections: { comment: string; session_id: number }[];
  cause: Cause | null;
  /** 今の判定(`currentAttributions`)が `memory` のとき名指された entry の id 列(ADR 0166 決定6)。他の cause・未帰責のエントリは null。 */
  entries: number[] | null;
  /** 今の判定の evidence —— 人間の面の異議注釈に出す(ADR 0213 決定4)。未帰責のエントリは null。 */
  evidence: string | null;
  /** エントリを含む worker session の `worker_spawned` の id(case 描画と同じ窓、`sessionSpawnOf`)。窓の外なら null。 */
  session_event_id: number | null;
  /** Interview のグループ(ADR 0273 決定10、ADR 0268 決定6 の印の昇格): root と監査 review の行だけが運ぶ —— 鍵は root の id、見出しは
   *  最新の出題の題(出題前は root の題)と実環境の名前。受験者の行は一覧に出ない(ADR 0268 決定1)。 */
  interview: { root_id: string; title: string; workspace: string | null } | null;
}

export function listLog(db: Db, defaultWorkspaceName?: string): LogEntry[] {
  const placeholders = HUMAN_FACING_KINDS.map(() => "?").join(", ");
  // an inner join is safe here only because every HUMAN_FACING_KIND is
  // task-scoped (asserted against BOARD_SCOPED_KINDS next to HUMAN_FACING_KINDS) and tasks are never deleted
  // (append-only) — no log entry can end up orphaned, so this can never
  // silently drop one. 受験者の行は流し読みに出さない —— root の history と task の面では読める(ADR 0268 決定1)
  const rows = db
    .prepare(
      `SELECT events.*, COALESCE(${derivedWorkspaceSql("tasks")}, ?) AS workspace,
              CASE WHEN tasks.type = 'interview' THEN tasks.id
                   WHEN ${isAuditSql("tasks.id")} THEN tasks.parent_id END AS interview_root_id
         FROM events JOIN tasks ON tasks.id = events.task_id
        WHERE events.kind IN (${placeholders}) AND ${SKIM_TASK_SQL} ORDER BY events.id`,
    )
    .all(defaultWorkspaceName ?? null, ...HUMAN_FACING_KINDS)
    .map((r) => parseEventRow<{ workspace: string | null; interview_root_id: string | null }>(r));
  // a second, flat query rather than N+1 per entry — grouped in JS below
  const objectionsByEntry = new Map<number, { comment: string; session_id: number }[]>();
  for (const o of entryObjections(db)) {
    const list = objectionsByEntry.get(o.entry_id) ?? [];
    list.push({ comment: o.comment, session_id: o.session_id });
    objectionsByEntry.set(o.entry_id, list);
  }
  const attributions = currentAttributions(db);
  // session の窓を切るのに要るのは spawn と exit だけ。窓の規則は task で絞るので盤面全体を1回で引いて渡す
  // ponytail: エントリ数 × session 数の走査。盤面が育って一覧が重くなったら task ごとに束ねる
  const sessionEvents = listEventsOfKinds(db, ["worker_spawned", "worker_exited"]);
  // Interview ごとに1回だけ引く —— 同じ root の行は同じグループ
  const groups = new Map<string, NonNullable<LogEntry["interview"]>>();
  const interviewGroup = (rootId: string) => {
    let group = groups.get(rootId);
    if (!group) {
      const root = getTask(db, rootId)!;
      group = { root_id: rootId, title: latestPosedProbe(db, rootId)?.probe.title ?? root.title, workspace: root.workspace ?? defaultWorkspaceName ?? null };
      groups.set(rootId, group);
    }
    return group;
  };
  return rows.flatMap(({ interview_root_id, ...entry }) => {
    if (!isDecisionLogEntry(entry)) return []; // SQL で kind を絞り済み —— 型の絞り込みのためだけ
    const attribution = attributions.get(entry.id);
    return {
      ...entry,
      interview: interview_root_id ? interviewGroup(interview_root_id) : null,
      objections: objectionsByEntry.get(entry.id) ?? [],
      cause: attribution?.cause ?? null,
      entries: attribution?.entries ?? null,
      evidence: attribution?.evidence ?? null,
      session_event_id: sessionSpawnOf(sessionEvents, entry)?.id ?? null,
    };
  });
}
