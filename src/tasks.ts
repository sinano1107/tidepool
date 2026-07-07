import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";

/** Worker id attributed to bare (non ?task=) sessions, e.g. the JSON API. */
export const HUMAN_WORKER_ID = "human";

export type TaskType = "work" | "question" | "review";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";

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
  created_at: string;
}

export interface RegisterTaskInput {
  type: TaskType;
  title: string;
  purpose: string;
  completion_criteria: string;
  parent_id?: string;
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
    created_at: now.toISOString(),
  };
  db.prepare(
    `INSERT INTO tasks (id, type, status, assignee, title, purpose, completion_criteria,
       risk_flag, review_flag, parent_id, sort_key, handoff_doc, created_at)
     VALUES (@id, @type, @status, @assignee, @title, @purpose, @completion_criteria,
       @risk_flag, @review_flag, @parent_id, @sort_key, @handoff_doc, @created_at)`,
  ).run(task);
  appendEvent(db, {
    taskId: task.id,
    workerId,
    payload: { kind: "task_registered", type: task.type, title: task.title },
    at: now,
  });
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

export function renderHandoffMarkdown(handoff: HandoffDoc): string {
  return HANDOFF_FIELDS.map((f) => `## ${HANDOFF_HEADINGS[f]}\n\n${handoff[f]}`).join("\n\n");
}

export class DomainError extends Error {}

/** Work tasks may not complete without a full handoff doc; question/review
 *  tasks carry none. The doc lands as markdown on the task row, written once. */
export function completeTask(
  db: Db,
  task: Task,
  handoff: Partial<HandoffDoc> | undefined,
  workerId: string,
  now: Date,
): Task {
  let handoffDoc: string | null = null;
  if (task.type === "work") {
    const missing = HANDOFF_FIELDS.filter((f) => !handoff?.[f]?.trim());
    if (missing.length > 0) {
      throw new DomainError(
        `a work task cannot complete without a full handoff doc; missing: ${missing.join(", ")}`,
      );
    }
    handoffDoc = renderHandoffMarkdown(handoff as HandoffDoc);
  }
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
  return getTask(db, task.id)!;
}

export function getTask(db: Db, id: string): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}
