import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";

/** Worker id attributed to bare (non ?task=) sessions, e.g. the JSON API. */
export const HUMAN_WORKER_ID = "human";

export type TaskType = "work" | "question" | "review";
/** `blocked` is deliberately absent: it is derived from unfinished children
 *  (CONTEXT.md), never stored. */
export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  assignee: string | null;
  title: string;
  purpose: string;
  completion_criteria: string;
  risk_flag: number;
  review_flag: number;
  parent_id: string | null;
  sort_key: number;
  handoff_doc: string | null;
  question_options: string[] | null;
  question_recommendation: string | null;
  question_answer: string | null;
  created_at: string;
}

/** The SQLite shape of a task: options are a JSON TEXT column. The JSON stays
 *  at this boundary — domain code sees `string[]`. */
type TaskRow = Omit<Task, "question_options"> & { question_options: string | null };

function parseOptions(json: string | null): string[] | null {
  return json === null ? null : JSON.parse(json);
}

export function rowToTask(row: TaskRow): Task {
  return { ...row, question_options: parseOptions(row.question_options) };
}

export interface QuestionSpec {
  options: string[];
  recommendation: string;
}

export interface RegisterTaskInput {
  type: TaskType;
  title: string;
  purpose: string;
  completion_criteria: string;
  parent_id?: string;
  question?: QuestionSpec;
  /** Decision-log entry (event id) this task rests on — set by decompose. */
  based_on_decision?: number;
}

/** Every question carries 2-4 options plus a recommendation among them,
 *  whichever door it enters by (escalate or the JSON API) — the answer view
 *  is one-tap first, free text only as an override. The degraded free-text-only
 *  question is reserved for the watchdog's auto-escalation safety valve (#17). */
function assertQuestionSpec(input: RegisterTaskInput): void {
  if (input.type !== "question") {
    if (input.question) throw new DomainError("only a question task carries options");
    return;
  }
  const q = input.question;
  if (!q || q.options.length < 2 || q.options.length > 4) {
    throw new DomainError("a question carries 2 to 4 options");
  }
  if (!q.recommendation.trim() || !q.options.includes(q.recommendation)) {
    throw new DomainError(
      "a question carries the registrant's recommendation, one of its options",
    );
  }
}

/** New tasks always join the queue tail: sort_key = max + 1. */
export function registerTask(
  db: Db,
  input: RegisterTaskInput,
  now: Date,
  workerId: string = HUMAN_WORKER_ID,
): Task {
  assertQuestionSpec(input);
  const { maxKey } = db
    .prepare("SELECT COALESCE(MAX(sort_key), 0) AS maxKey FROM tasks")
    .get() as { maxKey: number };
  const task: Task = {
    id: randomUUID(),
    type: input.type,
    status: "todo",
    assignee: null,
    title: input.title,
    purpose: input.purpose,
    completion_criteria: input.completion_criteria,
    risk_flag: 0,
    review_flag: 0,
    parent_id: input.parent_id ?? null,
    sort_key: maxKey + 1,
    handoff_doc: null,
    question_options: input.question?.options ?? null,
    question_recommendation: input.question?.recommendation ?? null,
    question_answer: null,
    created_at: now.toISOString(),
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (id, type, status, assignee, title, purpose, completion_criteria,
         risk_flag, review_flag, parent_id, sort_key, handoff_doc,
         question_options, question_recommendation, question_answer, created_at)
       VALUES (@id, @type, @status, @assignee, @title, @purpose, @completion_criteria,
         @risk_flag, @review_flag, @parent_id, @sort_key, @handoff_doc,
         @question_options, @question_recommendation, @question_answer, @created_at)`,
    ).run({
      ...task,
      question_options: task.question_options && JSON.stringify(task.question_options),
    });
    appendEvent(db, {
      taskId: task.id,
      workerId,
      payload: {
        kind: "task_registered",
        type: task.type,
        title: task.title,
        ...(input.based_on_decision !== undefined && {
          based_on_decision: input.based_on_decision,
        }),
      },
      at: now,
    });
  })();
  return task;
}


export const HANDOFF_FIELDS = [
  "outcome",
  "deliverables",
  "decision_refs",
  "dead_ends",
  "resume_context",
  "known_issues",
] as const;
export type HandoffField = (typeof HANDOFF_FIELDS)[number];
export type HandoffDoc = Record<HandoffField, string>;

const HANDOFF_HEADINGS: Record<HandoffField, string> = {
  outcome: "Outcome vs completion criteria",
  deliverables: "Deliverable locations",
  decision_refs: "Key decision-log references",
  dead_ends: "Dead ends tried",
  resume_context: "Context needed to resume",
  known_issues: "Known issues not worth a task",
};

export function renderHandoffMarkdown(handoff: Partial<HandoffDoc>): string {
  return HANDOFF_FIELDS.filter((f) => handoff[f]?.trim())
    .map((f) => `## ${HANDOFF_HEADINGS[f]}\n\n${handoff[f]}`)
    .join("\n\n");
}

export class DomainError extends Error {}

/** Hand the queue head to a worker: in_progress + assignee + event, atomically. */
export function pickupTask(db: Db, task: Task, workerId: string, now: Date): Task {
  db.transaction(() => {
    db.prepare("UPDATE tasks SET status = 'in_progress', assignee = ? WHERE id = ?").run(
      workerId,
      task.id,
    );
    appendEvent(db, { taskId: task.id, workerId, payload: { kind: "task_picked_up" }, at: now });
  })();
  return getTask(db, task.id)!;
}

/** Work tasks may not complete without a full handoff doc; question/review
 *  tasks need none, but one supplied is stored, not dropped (nothing may
 *  degrade recording). The doc lands as markdown on the task row, written once. */
export function completeTask(
  db: Db,
  task: Task,
  handoff: Partial<HandoffDoc> | undefined,
  workerId: string,
  now: Date,
): Task {
  if (task.type === "work") {
    const missing = HANDOFF_FIELDS.filter((f) => !handoff?.[f]?.trim());
    if (missing.length > 0) {
      throw new DomainError(
        `a work task cannot complete without a full handoff doc; missing: ${missing.join(", ")}`,
      );
    }
  }
  // completion criteria cover the whole tree: a parent completes only after
  // every child settles (復帰型 — the resumed session integrates, then completes)
  if (hasUnfinishedChildren(db, task.id)) {
    throw new DomainError("a task with unfinished children cannot complete");
  }
  const rendered = handoff ? renderHandoffMarkdown(handoff) : "";
  const handoffDoc = rendered === "" ? null : rendered;
  db.transaction(() => {
    db.prepare("UPDATE tasks SET status = 'done', handoff_doc = ? WHERE id = ?").run(
      handoffDoc,
      task.id,
    );
    appendEvent(db, {
      taskId: task.id,
      workerId,
      payload: {
        kind: "task_completed",
        handoff_present: handoffDoc !== null,
        result: handoff?.outcome?.trim() || null,
      },
      at: now,
    });
  })();
  return getTask(db, task.id)!;
}

/** Place a task right after `after`, or at the top of the board when `after`
 *  is null. sort_key orders the whole board, so any task may move — for a todo
 *  task a move to the top is "run now", never a separate execution path.
 *  Human steering channel: reachable from the WebUI JSON API only, never MCP. */
export function moveTask(
  db: Db,
  task: Task,
  after: Task | null,
  now: Date,
  workerId: string = HUMAN_WORKER_ID,
): Task {
  const sortKey = fractionalKeyAfter(db, task, after);
  db.transaction(() => {
    db.prepare("UPDATE tasks SET sort_key = ? WHERE id = ?").run(sortKey, task.id);
    appendEvent(db, {
      taskId: task.id,
      workerId,
      payload: { kind: "task_moved", after: after?.id ?? null },
      at: now,
    });
  })();
  return getTask(db, task.id)!;
}

function fractionalKeyAfter(db: Db, task: Task, after: Task | null): number {
  if (after === null) {
    const { minKey } = db
      .prepare("SELECT COALESCE(MIN(sort_key), 0) AS minKey FROM tasks")
      .get() as { minKey: number };
    return minKey - 1;
  }
  const next = db
    .prepare("SELECT sort_key FROM tasks WHERE sort_key > ? AND id <> ? ORDER BY sort_key LIMIT 1")
    .get(after.sort_key, task.id) as { sort_key: number } | undefined;
  return next === undefined ? after.sort_key + 1 : (after.sort_key + next.sort_key) / 2;
}

export interface EscalateInput extends QuestionSpec {
  title: string;
  context: string;
}

/** Escalation: a question child carrying 2-4 choices and the registrant's
 *  recommendation (enforced at registration, like every question). The parent
 *  returns to `todo` (blocked is derived from the unfinished child, never
 *  stored) and the slot is freed by the caller. */
export function escalateTask(
  db: Db,
  parent: Task,
  input: EscalateInput,
  workerId: string,
  now: Date,
): Task {
  let question: Task;
  db.transaction(() => {
    question = registerTask(
      db,
      {
        type: "question",
        title: input.title,
        purpose: input.context,
        completion_criteria: "a human answer is recorded",
        parent_id: parent.id,
        question: { options: input.options, recommendation: input.recommendation },
      },
      now,
      workerId,
    );
    db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(parent.id);
    appendEvent(db, {
      taskId: parent.id,
      workerId,
      payload: { kind: "task_escalated", question_id: question.id },
      at: now,
    });
  })();
  return question!;
}

/** The human steering channel: answer a question from the WebUI. One tap on an
 *  option or a free-text override — either way a plain string. The question
 *  completes; only a parent this answer actually unblocks returns to the queue
 *  head (the caller fires the immediate poll on `parentUnblocked`).
 *
 *  `stageUnblock` defers the head move: when given (an open triage session),
 *  the answer is just as durable but the unblocked parent is handed to the
 *  callback instead of moving — the queue only changes at triage commit. */
export function answerQuestion(
  db: Db,
  question: Task,
  answer: string,
  now: Date,
  stageUnblock?: (taskId: string) => void,
): { question: Task; parentUnblocked: boolean } {
  if (question.type !== "question") {
    throw new DomainError("only a question task can be answered");
  }
  if (question.status !== "todo") {
    throw new DomainError(`a ${question.status} question cannot be answered`);
  }
  let parentUnblocked = false;
  db.transaction(() => {
    db.prepare("UPDATE tasks SET status = 'done', question_answer = ? WHERE id = ?").run(
      answer,
      question.id,
    );
    // the recommender is whoever registered the question — carried on the
    // answer event so per-agent acceptance rates need no join
    const registered = db
      .prepare("SELECT worker_id FROM events WHERE task_id = ? AND kind = 'task_registered'")
      .get(question.id) as { worker_id: string } | undefined;
    appendEvent(db, {
      taskId: question.id,
      workerId: HUMAN_WORKER_ID,
      payload: {
        kind: "question_answered",
        answer,
        recommendation_accepted: answer === question.question_recommendation,
        recommended_by: registered?.worker_id ?? HUMAN_WORKER_ID,
      },
      at: now,
    });
    const parent = question.parent_id ? getTask(db, question.parent_id) : undefined;
    if (parent && parent.status === "todo" && !hasUnfinishedChildren(db, parent.id)) {
      if (stageUnblock) {
        stageUnblock(parent.id);
      } else {
        moveTask(db, parent, null, now);
        parentUnblocked = true;
      }
    }
  })();
  return { question: getTask(db, question.id)!, parentUnblocked };
}

/** Record an in-authority decision as one log line and move on. The log is the
 *  events table itself (human-facing kinds), never a separate entity. */
export function logDecision(
  db: Db,
  task: Task,
  line: string,
  workerId: string,
  now: Date,
): number {
  return appendEvent(db, {
    taskId: task.id,
    workerId,
    payload: { kind: "decision_logged", line },
    at: now,
  });
}

export interface ChildSpec {
  title: string;
  purpose: string;
  completion_criteria: string;
}

export interface DecomposeInput {
  reason: string;
  children: ChildSpec[];
}

/** Decomposition: one decision splits the remaining work into child tasks.
 *  One atomic call — the reason lands as a decision-log entry, the children
 *  join the queue tail in order, and the parent returns to `todo` (derived
 *  blocked) until every child is done. It then becomes pickable again in
 *  plain queue order — no head jump (ADR 0003) — to integrate and complete
 *  for real: completion is recorded only once the whole criteria are met. */
export function decomposeTask(
  db: Db,
  parent: Task,
  input: DecomposeInput,
  workerId: string,
  now: Date,
): Task[] {
  if (input.children.length === 0) {
    throw new DomainError("a decomposition carries at least one child task");
  }
  const children: Task[] = [];
  db.transaction(() => {
    const decisionId = logDecision(db, parent, input.reason, workerId, now);
    for (const child of input.children) {
      children.push(
        registerTask(
          db,
          { type: "work", ...child, parent_id: parent.id, based_on_decision: decisionId },
          now,
          workerId,
        ),
      );
    }
    db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(parent.id);
  })();
  return children;
}

/** The one SQL shape of the derived-blocked rule (CONTEXT.md): a child not
 *  done/cancelled. `parentRef` is the SQL expression holding the parent's id. */
export function unfinishedChildSql(parentRef: string): string {
  return `EXISTS (SELECT 1 FROM tasks c
            WHERE c.parent_id = ${parentRef} AND c.status NOT IN ('done', 'cancelled'))`;
}

export function hasUnfinishedChildren(db: Db, taskId: string): boolean {
  const { blocked } = db
    .prepare(`SELECT ${unfinishedChildSql("?")} AS blocked`)
    .get(taskId) as { blocked: number };
  return blocked === 1;
}

/** How a task appears on the board: `blocked` derived from unfinished
 *  children. Presentation only — the stored status stays one of the four
 *  persisted values. */
export type BoardTask = Omit<Task, "status"> & { status: TaskStatus | "blocked" };

export function presentTask(db: Db, task: Task): BoardTask {
  const blocked = task.status === "todo" && hasUnfinishedChildren(db, task.id);
  return { ...task, status: blocked ? "blocked" : task.status };
}

/** The whole board in one query — the list view derives blocked in SQL rather
 *  than issuing one probe per row. */
export function listBoard(db: Db): BoardTask[] {
  const rows = db
    .prepare(
      `SELECT *,
         CASE WHEN status = 'todo' AND ${unfinishedChildSql("tasks.id")}
              THEN 'blocked' ELSE status END AS status
       FROM tasks ORDER BY sort_key`,
    )
    .all() as Array<Omit<TaskRow, "status"> & { status: TaskStatus | "blocked" }>;
  return rows.map((row) => ({ ...row, question_options: parseOptions(row.question_options) }));
}

export function getTask(db: Db, id: string): Task | undefined {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row && rowToTask(row);
}

/** The queue head the slot may take: lowest-sort_key todo that is
 *  agent-executable. Blocked is derived from parent/child alone — a task with
 *  an unfinished child never enters the slot — and questions never enter it
 *  either: they are human tasks, answered outside the slot (WebUI). */
export function nextSlotTask(db: Db): Task | undefined {
  const row = db
    .prepare(
      `SELECT * FROM tasks t
       WHERE t.status = 'todo'
         AND t.type <> 'question'
         AND NOT ${unfinishedChildSql("t.id")}
       ORDER BY t.sort_key LIMIT 1`,
    )
    .get() as TaskRow | undefined;
  return row && rowToTask(row);
}
