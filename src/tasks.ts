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
  question_options: string | null;
  question_recommendation: string | null;
  question_answer: string | null;
  created_at: string;
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
}

/** New tasks always join the queue tail: sort_key = max + 1. */
export function registerTask(
  db: Db,
  input: RegisterTaskInput,
  now: Date,
  workerId: string = HUMAN_WORKER_ID,
): Task {
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
    question_options: input.question ? JSON.stringify(input.question.options) : null,
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
    ).run(task);
    appendEvent(db, {
      taskId: task.id,
      workerId,
      payload: { kind: "task_registered", type: task.type, title: task.title },
      at: now,
    });
  })();
  return task;
}

export function listTasks(db: Db): Task[] {
  return db.prepare("SELECT * FROM tasks ORDER BY sort_key").all() as Task[];
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
      payload: { kind: "task_completed", handoff_present: handoffDoc !== null },
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

export interface EscalateInput {
  title: string;
  context: string;
  options: string[];
  recommendation: string;
}

/** Escalation: a question child carrying 2-4 choices and the registrant's
 *  recommendation. The parent returns to `todo` (blocked is derived from the
 *  unfinished child, never stored) and the slot is freed by the caller. */
export function escalateTask(
  db: Db,
  parent: Task,
  input: EscalateInput,
  workerId: string,
  now: Date,
): Task {
  if (input.options.length < 2 || input.options.length > 4) {
    throw new DomainError("an escalation carries 2 to 4 options");
  }
  if (!input.options.includes(input.recommendation) || !input.recommendation.trim()) {
    throw new DomainError("an escalation carries the registrant's recommendation, one of its options");
  }
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
 *  completes, and an escalated parent returns to the queue head (the caller
 *  fires the immediate poll). */
export function answerQuestion(db: Db, question: Task, answer: string, now: Date): Task {
  if (question.type !== "question") {
    throw new DomainError("only a question task can be answered");
  }
  if (question.status !== "todo") {
    throw new DomainError(`a ${question.status} question cannot be answered`);
  }
  db.transaction(() => {
    db.prepare("UPDATE tasks SET status = 'done', question_answer = ? WHERE id = ?").run(
      answer,
      question.id,
    );
    appendEvent(db, {
      taskId: question.id,
      workerId: HUMAN_WORKER_ID,
      payload: {
        kind: "question_answered",
        answer,
        recommendation_accepted: answer === question.question_recommendation,
      },
      at: now,
    });
    const parent = question.parent_id ? getTask(db, question.parent_id) : undefined;
    if (parent) moveTask(db, parent, null, now);
  })();
  return getTask(db, question.id)!;
}

/** How a task appears on the board: `blocked` derived from unfinished
 *  children, question options parsed back into an array. Presentation only —
 *  the stored status stays one of the four persisted values. */
export type BoardTask = Omit<Task, "status" | "question_options"> & {
  status: TaskStatus | "blocked";
  question_options: string[] | null;
};

export function presentTask(db: Db, task: Task): BoardTask {
  const { blocked } = db
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM tasks c
         WHERE c.parent_id = ? AND c.status NOT IN ('done', 'cancelled')
       ) AS blocked`,
    )
    .get(task.id) as { blocked: number };
  return {
    ...task,
    status: task.status === "todo" && blocked ? "blocked" : task.status,
    question_options: task.question_options === null ? null : JSON.parse(task.question_options),
  };
}

export function getTask(db: Db, id: string): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}
