import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";

/** Worker id attributed to bare (non ?task=) sessions, e.g. the JSON API. */
export const HUMAN_WORKER_ID = "human";

/** Worker id the board acts under when it enforces its own rules (issue #8):
 *  the tree rule's failures are the board's to report, never pinned on the
 *  agent. Also the sole registrant allowed a 1-choice confirmation question
 *  (issue #21) — a plain agent question always carries 2-4 choices. */
export const BOARD_WORKER_ID = "tidepool";

export type TaskType = "work" | "question" | "review";
/** `blocked` is deliberately absent: it is derived from unfinished children
 *  (CONTEXT.md), never stored. */
export type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  assignee: string | null;
  /** Where this task runs (issue #11): a registry workspace name, or null to
   *  inherit the parent's (CONTEXT.md: workspace is first-class, children
   *  inherit by default). */
  workspace: string | null;
  title: string;
  purpose: string;
  completion_criteria: string;
  risk_flag: number;
  review_flag: number;
  parent_id: string | null;
  sort_key: number;
  handoff_doc: string | null;
  /** The PR opened for this task's completed work (issue #11), or null if
   *  none opened yet (no workspace/github configured, or the task carries no
   *  handoff-worthy change). Set once by recordPrOpened, never by the MCP
   *  layer directly. */
  pr_number: number | null;
  question_options: string[] | null;
  question_recommendation: string | null;
  question_answer: string | null;
  /** System-internal only (ADR 0006) — never set via MCP or the JSON API. */
  question_cancel_option: string | null;
  /** System-internal only (issue #11): a pending-child approval question's
   *  would-be child, materialized by answerQuestion only on an "approve"
   *  answer. */
  question_pending_child: PendingChildSpec | null;
  /** System-internal only (issue #11): the PR number a merge-decision
   *  question is standing in for — set only by recordPrOpened under the
   *  `escalate` merge dial, read only by the answer route to gate the actual
   *  merge on a live CI check. Never set via MCP or the JSON API. */
  question_pending_merge_pr: number | null;
  /** System-internal only (issue #21): the workspace name a quarantine
   *  Confirmation question stands in for, set only by quarantineWorkspace —
   *  never set via MCP or the JSON API. */
  question_quarantine_workspace: string | null;
  /** System-internal only (ADR 0012 / issue #36): the agent name a quarantine
   *  Confirmation question stands in for, set only by quarantineAgent — the
   *  agent-name generalization of the workspace field above. Never set via
   *  MCP or the JSON API. */
  question_quarantine_agent: string | null;
  created_at: string;
}

/** The content shared by every task-registration shape (ChildSpec,
 *  PendingChildSpec, RegisterTaskInput) — kept as one type so a field added to
 *  all three in lockstep (as risk_flag/assignee/workspace each were, issue
 *  #11) only needs declaring once. */
export interface TaskContent {
  title: string;
  purpose: string;
  completion_criteria: string;
}

export interface PendingChildSpec extends TaskContent {
  /** The decision-log entry this child would have rested on had it registered
   *  normally — carried through so an approved child keeps the same
   *  provenance as an ordinary decomposed sibling. */
  based_on_decision?: number;
  /** Whether the child itself carries risk — checked against the parent's
   *  *current* risk flag at approval time (not a decompose-time snapshot) to
   *  decide whether this approval propagates risk upward at all. */
  risk_flag?: boolean;
  /** The assignee originally requested at decompose time, honored as-is on
   *  materialization regardless of which reason(s) triggered this question. */
  assignee?: string;
  /** The workspace originally requested at decompose time, honored as-is on
   *  materialization regardless of which reason(s) triggered this question. */
  workspace?: string;
}

/** The SQLite shape of a task: options/pending-child are JSON TEXT columns.
 *  The JSON stays at this boundary — domain code sees the parsed shape. */
export type TaskRow = Omit<Task, "question_options" | "question_pending_child"> & {
  question_options: string | null;
  question_pending_child: string | null;
};

function parseOptions(json: string | null): string[] | null {
  return json === null ? null : JSON.parse(json);
}

function parsePendingChild(json: string | null): PendingChildSpec | null {
  return json === null ? null : JSON.parse(json);
}

export function rowToTask(row: TaskRow): Task {
  return {
    ...row,
    question_options: parseOptions(row.question_options),
    question_pending_child: parsePendingChild(row.question_pending_child),
  };
}

export interface QuestionSpec {
  options: string[];
  recommendation: string;
}

export interface RegisterTaskInput extends TaskContent {
  type: TaskType;
  parent_id?: string;
  /** CONTEXT.md's risk flag — declares external effect at registration. */
  risk_flag?: boolean;
  /** CONTEXT.md's review flag — opts this task into on-completion review
   *  (layer 1) at registration time (issue #12). */
  review_flag?: boolean;
  /** Pre-assigns the task to a specific worker at registration (issue #11). */
  assignee?: string;
  /** Registers the task against a specific workspace (issue #11). Absent →
   *  inherits the parent's (or null at the root). */
  workspace?: string;
  question?: QuestionSpec;
  /** System-internal only (ADR 0006): declares that answering the question
   *  with this exact option cancels the plan (see `cancelTask`) instead of
   *  taking the ordinary unblock-to-head path. Must be one of the question's
   *  options. Never set via MCP or the JSON API — only the watchdog's
   *  failure-question registration sets it. */
  cancel_option?: string;
  /** System-internal only (issue #11): the would-be child of a pending-child
   *  approval question, materialized by answerQuestion on an "approve"
   *  answer. Never set via MCP or the JSON API — only decomposeTask sets
   *  this. */
  pending_child?: PendingChildSpec;
  /** System-internal only (issue #11): the PR number a merge-decision
   *  question stands in for. Never set via MCP or the JSON API — only
   *  recordPrOpened's `escalate` branch sets this. */
  pending_merge_pr?: number;
  /** System-internal only (issue #21): the workspace name a quarantine
   *  Confirmation question stands in for. Never set via MCP or the JSON
   *  API — only quarantineWorkspace sets this. */
  quarantine_workspace?: string;
  /** System-internal only (ADR 0012 / issue #36): the agent name a
   *  quarantine Confirmation question stands in for. Never set via MCP or
   *  the JSON API — only quarantineAgent sets this. */
  quarantine_agent?: string;
  /** Decision-log entry (event id) this task rests on — set by decompose. */
  based_on_decision?: number;
}

/** Every question carries 2-4 options plus a recommendation among them,
 *  whichever door it enters by (escalate or the JSON API) — the answer view
 *  is one-tap first, free text only as an override. The degraded free-text-only
 *  question is reserved for the watchdog's auto-escalation safety valve (#17).
 *
 *  The lower bound relaxes to 1 only for an actual quarantine Confirmation
 *  question (issue #21, CONTEXT.md) — `quarantine_workspace` or (ADR 0012 /
 *  issue #36) `quarantine_agent` set, which only quarantineWorkspace /
 *  quarantineAgent themselves ever do: it asks for a completion confirmation,
 *  not a choice, and a fake second option would be filler with no effect of
 *  its own. This is deliberately keyed on those fields rather than the
 *  registering `workerId` (e.g. `=== BOARD_WORKER_ID`): a worker's id is
 *  operator-configured and could collide with BOARD_WORKER_ID by accident,
 *  which would otherwise let an ordinary agent question sneak past the 2-4
 *  floor. `quarantine_workspace`/`quarantine_agent` are never reachable from
 *  MCP or the JSON API (unlike an assignee/worker id), so this floor can't be
 *  gamed the same way — an agent's question is always a real 2-4-way choice. */
function assertQuestionSpec(input: RegisterTaskInput): void {
  if (input.type !== "question") {
    if (input.question) throw new DomainError("only a question task carries options");
    if (input.cancel_option) throw new DomainError("only a question task carries a cancel option");
    return;
  }
  const q = input.question;
  const minOptions =
    input.quarantine_workspace !== undefined || input.quarantine_agent !== undefined ? 1 : 2;
  if (!q || q.options.length < minOptions || q.options.length > 4) {
    throw new DomainError(`a question carries ${minOptions} to 4 options`);
  }
  if (!q.recommendation.trim() || !q.options.includes(q.recommendation)) {
    throw new DomainError(
      "a question carries the registrant's recommendation, one of its options",
    );
  }
  if (input.cancel_option !== undefined) {
    if (!q.options.includes(input.cancel_option)) {
      throw new DomainError("a cancel option must be one of the question's options");
    }
    // the abandon cascade (answerQuestion) walks up from the question's own
    // parent, so a cancel option is meaningless without one
    if (!input.parent_id) {
      throw new DomainError("a cancel option requires a parent task");
    }
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
    assignee: input.assignee ?? null,
    workspace: input.workspace ?? null,
    title: input.title,
    purpose: input.purpose,
    completion_criteria: input.completion_criteria,
    risk_flag: input.risk_flag ? 1 : 0,
    review_flag: input.review_flag ? 1 : 0,
    parent_id: input.parent_id ?? null,
    sort_key: maxKey + 1,
    handoff_doc: null,
    pr_number: null,
    question_options: input.question?.options ?? null,
    question_recommendation: input.question?.recommendation ?? null,
    question_answer: null,
    question_cancel_option: input.cancel_option ?? null,
    question_pending_child: input.pending_child ?? null,
    question_pending_merge_pr: input.pending_merge_pr ?? null,
    question_quarantine_workspace: input.quarantine_workspace ?? null,
    question_quarantine_agent: input.quarantine_agent ?? null,
    created_at: now.toISOString(),
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (id, type, status, assignee, workspace, title, purpose, completion_criteria,
         risk_flag, review_flag, parent_id, sort_key, handoff_doc, pr_number,
         question_options, question_recommendation, question_answer, question_cancel_option,
         question_pending_child, question_pending_merge_pr, question_quarantine_workspace,
         question_quarantine_agent, created_at)
       VALUES (@id, @type, @status, @assignee, @workspace, @title, @purpose, @completion_criteria,
         @risk_flag, @review_flag, @parent_id, @sort_key, @handoff_doc, @pr_number,
         @question_options, @question_recommendation, @question_answer, @question_cancel_option,
         @question_pending_child, @question_pending_merge_pr, @question_quarantine_workspace,
         @question_quarantine_agent, @created_at)`,
    ).run({
      ...task,
      question_options: task.question_options && JSON.stringify(task.question_options),
      question_pending_child:
        task.question_pending_child && JSON.stringify(task.question_pending_child),
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

/** Hand the queue head to a worker: in_progress + event, atomically. `assignee`
 *  is never touched here (ADR 0012 / issue #36): slot is capacity, not
 *  identity, so pickup must not overwrite a pre-set delegation, nor bake in
 *  an unspecified assignee's resolution — null stays a live reference to
 *  whichever agent is the board's default at the moment it's next read
 *  (CONTEXT.md's Assignee), same as workspace's own "resolved fresh every
 *  use, never pinned" rule (ADR 0009). `workerId` is only the event's
 *  attribution — the caller resolves it (`task.assignee ?? the default
 *  agent`) before calling. */
export function pickupTask(db: Db, task: Task, workerId: string, now: Date): Task {
  db.transaction(() => {
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
    appendEvent(db, { taskId: task.id, workerId, payload: { kind: "task_picked_up" }, at: now });
  })();
  return getTask(db, task.id)!;
}

/** Work tasks may not complete without a full handoff doc; question/review
 *  tasks need none, but one supplied is stored, not dropped (nothing may
 *  degrade recording). The doc lands as markdown on the task row, written
 *  once. A `human`-assignee task is exempt regardless of type (issue #13):
 *  actionable follow-up belongs to a *new* task, not this doc, so a physical/
 *  approval task carries no agent session to hand off from — the doc stays
 *  fully optional, same as question/review.
 *
 *  Layer 1 review (issue #15): a completing work task auto-generates a
 *  read-only review child when either flag is set — `review_flag` is the
 *  plain per-task opt-in (CONTEXT.md's Review flag); `risk_flag` forces one
 *  regardless of parentage, root tasks included (CONTEXT.md's Risk flag
 *  declares external, irreversible effect — the design vault's overview.md
 *  states layer 1's opt-in as "via risk/review flag", not review_flag alone).
 *  A decomposed child with neither flag defers to its parent's own
 *  completion-time review (CONTEXT.md's Review flag: "子のレビューは既定で
 *  親に委譲される"), same as a flagless root task's default of no review at
 *  all. */
export function completeTask(
  db: Db,
  task: Task,
  handoff: Partial<HandoffDoc> | undefined,
  workerId: string,
  now: Date,
): Task {
  if (task.type === "work" && task.assignee !== HUMAN_WORKER_ID) {
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
    if (task.type === "work" && (task.review_flag || task.risk_flag)) {
      registerTask(
        db,
        {
          type: "review",
          title: `review: ${task.title}`,
          purpose: `read-only review of "${task.title}"'s deliverable against its completion criteria`,
          completion_criteria:
            "findings are read-only — issues land as repair tasks for the original assignee",
          parent_id: task.id,
          // inherits the reviewed task's execution workspace, same as any
          // other child (CONTEXT.md's Workspace) — a review must run where
          // the deliverable actually lives, not wherever the board's default
          // happens to point
          workspace: task.workspace ?? undefined,
        },
        now,
        workerId,
      );
    }
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
  /** System-internal only (ADR 0006) — absent from the MCP tool schema and
   *  the JSON API; only the watchdog's failure-question path sets this. */
  cancel_option?: string;
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
        cancel_option: input.cancel_option,
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

/** Cancel a task and every one of its unfinished descendants in one sweep
 *  (ADR 0006): the human's abandon answer discards a plan wholesale rather
 *  than picking through which branches survive — no dependency edges exist
 *  between siblings to reason about, so a partial cancel can't be more
 *  correct than a full one. `done` descendants are left untouched (nothing
 *  degrades a completed record); `cancelled` counts as finished for the
 *  blocked derivation, which is what lets the cancelled tree's own parent
 *  return to `todo` and pick up work again. Internal only — answerQuestion's
 *  abandon branch is the sole caller; no MCP or JSON API surface. */
export function cancelTask(
  db: Db,
  task: Task,
  originQuestionId: string,
  workerId: string,
  now: Date,
): void {
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ?
         UNION
         SELECT c.id FROM tasks c JOIN subtree s ON c.parent_id = s.id
       )
       SELECT subtree.id FROM subtree JOIN tasks ON tasks.id = subtree.id
       WHERE tasks.status NOT IN ('done', 'cancelled')`,
    )
    .all(task.id) as Array<{ id: string }>;
  db.transaction(() => {
    for (const { id } of rows) {
      db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(id);
      appendEvent(db, {
        taskId: id,
        workerId,
        payload: { kind: "task_cancelled", origin_question_id: originQuestionId },
        at: now,
      });
    }
  })();
}

/** The human steering channel: answer a question from the WebUI. One tap on an
 *  option or a free-text override — either way a plain string. The question
 *  completes; only a parent this answer actually unblocks returns to the queue
 *  head (the caller fires the immediate poll on `parentUnblocked`).
 *
 *  `stageUnblock` defers the head move: when given (an open triage session),
 *  the answer is just as durable but the unblocked parent is handed to the
 *  callback instead of moving — the queue only changes at triage commit.
 *
 *  Abandon (ADR 0006): when `answer` matches the question's declared
 *  `question_cancel_option` (system-internal, set only on the watchdog's
 *  failure questions), the failed task's plan is discarded instead of
 *  unblocked — every unfinished descendant of its parent (siblings included,
 *  the failed task's own subtree among them) is cancelled, and the parent
 *  itself returns to the queue head to replan. With no parent, the failed
 *  task's own subtree is cancelled and nothing returns to the head.
 *
 *  Quarantine resolution (issue #21): a Confirmation question (declared by
 *  `question_quarantine_workspace`, system-internal) takes any answer at all
 *  as a repair confirmation — the caller has already verified the workspace's
 *  tree is clean before this runs (see api.ts). needs_human clears at once,
 *  reported back as `pickupResumed` so the caller fires the immediate poll,
 *  same as `parentUnblocked`. */
export function answerQuestion(
  db: Db,
  question: Task,
  answer: string,
  now: Date,
  stageUnblock?: (taskId: string) => void,
): { question: Task; parentUnblocked: boolean; pickupResumed: boolean } {
  if (question.type !== "question") {
    throw new DomainError("only a question task can be answered");
  }
  if (question.status !== "todo") {
    throw new DomainError(`a ${question.status} question cannot be answered`);
  }
  let parentUnblocked = false;
  let pickupResumed = false;
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

    if (question.question_quarantine_workspace !== null) {
      const wsName = question.question_quarantine_workspace;
      db.prepare("UPDATE workspace_state SET needs_human = 0 WHERE name = ?").run(wsName);
      appendEvent(db, {
        taskId: question.id,
        workerId: HUMAN_WORKER_ID,
        payload: { kind: "workspace_reinstated", workspace: wsName },
        at: now,
      });
      pickupResumed = true;
      return;
    }

    // the agent-name generalization of the workspace branch above (ADR 0012 /
    // issue #36)
    if (question.question_quarantine_agent !== null) {
      const agentName = question.question_quarantine_agent;
      db.prepare("UPDATE agent_state SET needs_human = 0 WHERE name = ?").run(agentName);
      appendEvent(db, {
        taskId: question.id,
        workerId: HUMAN_WORKER_ID,
        payload: { kind: "agent_reinstated", agent: agentName },
        at: now,
      });
      pickupResumed = true;
      return;
    }

    let unblockTarget: Task | undefined;
    if (answer === question.question_cancel_option) {
      const failed = getTask(db, question.parent_id!)!;
      const plan = failed.parent_id ? getTask(db, failed.parent_id) : undefined;
      if (plan) {
        const siblingIds = db
          .prepare(
            `SELECT id FROM tasks WHERE parent_id = ? AND status NOT IN ('done', 'cancelled')`,
          )
          .all(plan.id) as Array<{ id: string }>;
        for (const { id } of siblingIds) {
          cancelTask(db, getTask(db, id)!, question.id, HUMAN_WORKER_ID, now);
        }
        unblockTarget = plan;
      } else {
        cancelTask(db, failed, question.id, HUMAN_WORKER_ID, now);
      }
    } else {
      // pending-child approval question (issue #11): the child (out-of-
      // authority on risk and/or assignee) was never registered at decompose
      // time. "approve" materializes it now, for real, and — only if it
      // actually carries risk beyond its parent — raises the parent's own
      // risk flag to match (upward propagation). A "reject" answer leaves it
      // unregistered.
      const pending = question.question_pending_child;
      if (pending && answer === "approve") {
        registerTask(
          db,
          { type: "work", ...pending, parent_id: question.parent_id! },
          now,
          HUMAN_WORKER_ID,
        );
        // "beyond its parent" is evaluated against the parent's current risk
        // flag, not a decompose-time snapshot: a second, unrelated (e.g.
        // assignee-only) approval on an already-risky parent propagates
        // nothing new and must not re-fire the audit event.
        const currentParent = getTask(db, question.parent_id!)!;
        if (pending.risk_flag && !currentParent.risk_flag) {
          db.prepare("UPDATE tasks SET risk_flag = 1 WHERE id = ?").run(question.parent_id);
          appendEvent(db, {
            taskId: question.parent_id!,
            workerId: HUMAN_WORKER_ID,
            payload: { kind: "risk_flag_raised", origin_question_id: question.id },
            at: now,
          });
        }
      }
      unblockTarget = question.parent_id ? getTask(db, question.parent_id) : undefined;
    }

    if (
      unblockTarget &&
      unblockTarget.status === "todo" &&
      !hasUnfinishedChildren(db, unblockTarget.id)
    ) {
      if (stageUnblock) {
        stageUnblock(unblockTarget.id);
      } else {
        moveTask(db, unblockTarget, null, now);
        parentUnblocked = true;
      }
    }
  })();
  return { question: getTask(db, question.id)!, parentUnblocked, pickupResumed };
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

export interface ChildSpec extends TaskContent {
  /** Declares this child has external effect (CONTEXT.md's risk flag). A
   *  child riskier than its parent is out of the registering worker's
   *  authority: decomposeTask converts it into an approval question rather
   *  than registering it (ADR 0002 / issue #11). */
  risk_flag?: boolean;
  /** Pre-assigns the child to a specific worker. Outside the registering
   *  worker's authority profile's `assignable_to` (confused-deputy
   *  prevention), this too converts to an approval question (issue #11). */
  assignee?: string;
  /** Targets the child at a specific workspace. Outside the registering
   *  worker's authority profile's `allowed_workspaces`, this too converts to
   *  an approval question (issue #11). Absent → inherits the parent's. */
  workspace?: string;
}

/** The registering worker's authority, resolved by the caller (the MCP layer)
 *  against the board's one configured profile (issue #11) — decomposeTask
 *  itself stays free of any registry/file-loading dependency. */
export interface AuthorityContext {
  assignable_to?: string[];
  allowed_workspaces?: string[];
  /** The merge dial (issue #11): `escalate` makes recordPrOpened register a
   *  merge-decision question for every PR; anything else takes no action
   *  here (`auto_if_ci_green`'s auto-merge poll is a separate mechanism). */
  merge?: "escalate" | "auto_if_ci_green";
}

/** Options fixed by the server for a merge-decision question (issue #11) —
 *  answerQuestion recognizes this exact pair via question_pending_merge_pr,
 *  same shape as the pending-child mechanism's fixed options. */
export const MERGE_QUESTION_OPTIONS = ["merge", "hold"] as const;

/** Registers the merge-decision question every merge escalation shares
 *  (the `escalate` dial, and `auto_if_ci_green`'s risky-task and CI-failure
 *  fallbacks) — only the title/purpose/recommendation differ per caller.
 *  Exported so merge.ts's CI-failure fallback shares this exact shape too,
 *  rather than redeclaring it (they must never drift apart). */
export function registerMergeQuestion(
  db: Db,
  task: Task,
  prNumber: number,
  purpose: string,
  recommendation: (typeof MERGE_QUESTION_OPTIONS)[number],
  workerId: string,
  now: Date,
): void {
  registerTask(
    db,
    {
      type: "question",
      title: `merge PR #${prNumber}: ${task.title}`,
      purpose,
      completion_criteria: "a human decides whether to merge",
      question: { options: [...MERGE_QUESTION_OPTIONS], recommendation },
      pending_merge_pr: prNumber,
      // carries the originating work task's execution workspace (issue #26 /
      // ADR 0009), so the answer route's live CI check and the auto-merge
      // poll both resolve the right registry entry, not just the board's
      // default — a plain top-level question with no parent would otherwise
      // never inherit it
      workspace: task.workspace ?? undefined,
    },
    now,
    workerId,
  );
}

/** Queues a completed low-risk task's PR for the auto_if_ci_green poll (issue
 *  #11) — recordPrOpened's low-risk branch is the only writer; the poll
 *  itself (merge.ts) is the only reader/deleter. */
function queuePendingAutoMerge(db: Db, taskId: string, prNumber: number): void {
  db.prepare("INSERT INTO pending_auto_merges (task_id, pr_number) VALUES (?, ?)").run(
    taskId,
    prNumber,
  );
}

export interface PendingAutoMerge {
  task_id: string;
  pr_number: number;
}

export function listPendingAutoMerges(db: Db): PendingAutoMerge[] {
  return db
    .prepare("SELECT task_id, pr_number FROM pending_auto_merges")
    .all() as PendingAutoMerge[];
}

export function clearPendingAutoMerge(db: Db, taskId: string): void {
  db.prepare("DELETE FROM pending_auto_merges WHERE task_id = ?").run(taskId);
}

/** Records that a completed task's work opened a PR (issue #11): pr_number is
 *  set once, paired with a pr_opened event — the invariant lives here, not in
 *  the MCP layer's PR side effect, per ADR 0002. The merge dial then decides
 *  what happens next: `escalate` always asks a human before merging, via a
 *  merge-decision question whose "merge" answer the answer route gates on a
 *  live CI check (never performed here — this module stays free of any
 *  GitHubClient dependency). `auto_if_ci_green` asks the same way for a task
 *  that carries risk (never silently auto-merges a risky change, regardless
 *  of the dial); a low-risk task instead queues for the unattended CI poll
 *  (merge.ts). Anything else (no dial configured) takes no further action —
 *  today's pre-#11 baseline. */
export function recordPrOpened(
  db: Db,
  task: Task,
  prNumber: number,
  workerId: string,
  now: Date,
  authority?: AuthorityContext,
): void {
  db.transaction(() => {
    db.prepare("UPDATE tasks SET pr_number = ? WHERE id = ?").run(prNumber, task.id);
    appendEvent(db, {
      taskId: task.id,
      workerId,
      payload: { kind: "pr_opened", pr_number: prNumber },
      at: now,
    });
    if (authority?.merge === "escalate") {
      registerMergeQuestion(
        db,
        task,
        prNumber,
        `"${task.title}" completed and opened PR #${prNumber}. Merge it now?`,
        "merge",
        workerId,
        now,
      );
    } else if (authority?.merge === "auto_if_ci_green") {
      if (task.risk_flag) {
        registerMergeQuestion(
          db,
          task,
          prNumber,
          `"${task.title}" completed and opened PR #${prNumber}, but carries risk — ` +
            `auto_if_ci_green never auto-merges a risky task. Merge it now?`,
          "merge",
          workerId,
          now,
        );
      } else {
        queuePendingAutoMerge(db, task.id, prNumber);
      }
    }
  })();
}

/** A requested value is out of authority only when it's explicitly stated
 *  (an unstated value never itself needs approval) and the profile actually
 *  restricts it (no allowlist configured means unrestricted). Shared by the
 *  assignable_to and allowed_workspaces checks in decomposeTask — risk_flag's
 *  check is its own shape (compared against the parent's flag, not a list). */
function outsideAuthority(value: string | undefined, allowlist: string[] | undefined): boolean {
  return value !== undefined && allowlist !== undefined && !allowlist.includes(value);
}

/** Options fixed by the server for a pending-child approval question (issue
 *  #11) — not a caller-supplied QuestionSpec, so answerQuestion recognizes
 *  this exact pair rather than a free-form escalation. */
const PENDING_CHILD_OPTIONS = ["approve", "reject"] as const;

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
  authority?: AuthorityContext,
): Task[] {
  if (input.children.length === 0) {
    throw new DomainError("a decomposition carries at least one child task");
  }
  const children: Task[] = [];
  db.transaction(() => {
    const decisionId = logDecision(db, parent, input.reason, workerId, now);
    for (const child of input.children) {
      const reasons: string[] = [];
      if (child.risk_flag && !parent.risk_flag) {
        reasons.push("carries risk beyond the parent's declared risk");
      }
      if (outsideAuthority(child.assignee, authority?.assignable_to)) {
        reasons.push(`assigns to "${child.assignee}", outside ${workerId}'s assignable_to`);
      }
      if (outsideAuthority(child.workspace, authority?.allowed_workspaces)) {
        reasons.push(
          `targets workspace "${child.workspace}", outside ${workerId}'s allowed_workspaces`,
        );
      }
      // an unstated workspace inherits the parent's (CONTEXT.md): it was
      // already authorized when the parent landed there, so this is a
      // default fill-in, never itself a reason for a question
      const workspace = child.workspace ?? parent.workspace ?? undefined;
      if (reasons.length > 0) {
        registerTask(
          db,
          {
            type: "question",
            title: `authorize child registration: ${child.title}`,
            purpose:
              `"${child.title}" ${reasons.join("; ")} — outside ${workerId}'s authority to ` +
              `register unapproved. ${child.purpose}`,
            completion_criteria: "a human approves or rejects the child registration",
            parent_id: parent.id,
            question: { options: [...PENDING_CHILD_OPTIONS], recommendation: "approve" },
            pending_child: {
              title: child.title,
              purpose: child.purpose,
              completion_criteria: child.completion_criteria,
              risk_flag: child.risk_flag,
              assignee: child.assignee,
              workspace,
              based_on_decision: decisionId,
            },
            based_on_decision: decisionId,
          },
          now,
          workerId,
        );
        continue;
      }
      children.push(
        registerTask(
          db,
          { type: "work", ...child, workspace, parent_id: parent.id, based_on_decision: decisionId },
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

/** The one SQL shape of "this task's execution workspace is quarantined"
 *  (issue #26 / ADR 0009), shared by `nextSlotTask`'s pickup gate and
 *  `listQueue`'s skipped display — both gate on the same
 *  `task.workspace ?? the board's default` fallback and must never drift
 *  apart. `taskWorkspaceRef` is the SQL expression holding the candidate
 *  task's `workspace` column; `defaultRef` is the SQL expression (a bound
 *  param, named or positional) holding the board's default workspace name. */
export function workspaceQuarantinedSql(taskWorkspaceRef: string, defaultRef: string): string {
  return `EXISTS (SELECT 1 FROM workspace_state w
            WHERE w.name = COALESCE(${taskWorkspaceRef}, ${defaultRef}) AND w.needs_human = 1)`;
}

/** The agent-name generalization of `workspaceQuarantinedSql` (ADR 0012 /
 *  issue #36): "this task's assignee is quarantined", shared the same way by
 *  `nextSlotTask`'s pickup gate and `listQueue`'s skipped display, gating on
 *  the same `task.assignee ?? the board's default agent` fallback
 *  (CONTEXT.md's Assignee). `taskAssigneeRef` is the SQL expression holding
 *  the candidate task's `assignee` column; `defaultRef` is the SQL expression
 *  holding the board's default agent name. A task's assignee is never
 *  literally `human` when this runs (the caller excludes it beforehand), so
 *  no separate carve-out is needed here. */
export function agentQuarantinedSql(taskAssigneeRef: string, defaultRef: string): string {
  return `EXISTS (SELECT 1 FROM agent_state a
            WHERE a.name = COALESCE(${taskAssigneeRef}, ${defaultRef}) AND a.needs_human = 1)`;
}

/** Held (CONTEXT.md, ADR 0006): while an ancestor carries an unanswered
 *  question, its subtree stays out of the slot — a freeze from above, unlike
 *  `blocked`'s freeze from below (an unfinished child). Two tiers of root:
 *  a general question holds its own parent's subtree; a question that can
 *  cancel the plan (question_cancel_option set — the watchdog's failure
 *  question) holds its parent's *parent*'s subtree instead, siblings
 *  included, because an abandon answer may cancel the whole plan out from
 *  under them (falls back to its own parent's subtree if that parent has no
 *  parent). A question itself is never held (it stays answerable outside the
 *  slot regardless of what it's holding). Descendants are found by a
 *  recursive walk down `parent_id` from each question's held root, derived
 *  only — nothing is stored. */
const HELD_IDS_CTE = `
  held_roots(root_id) AS (
    SELECT CASE WHEN q.question_cancel_option IS NULL THEN q.parent_id
                ELSE COALESCE(f.parent_id, f.id) END AS root_id
    FROM tasks q JOIN tasks f ON f.id = q.parent_id
    WHERE q.type = 'question' AND q.status = 'todo'
  ),
  held_ids(id) AS (
    SELECT c.id FROM tasks c JOIN held_roots r ON c.parent_id = r.root_id
    UNION
    SELECT c.id FROM tasks c JOIN held_ids h ON c.parent_id = h.id
  )
`;

/** `idRef` is the SQL expression holding the candidate task's id. */
export function heldSql(idRef: string): string {
  return `${idRef} IN (SELECT id FROM held_ids WHERE id NOT IN
            (SELECT id FROM tasks WHERE type = 'question'))`;
}

export function hasUnfinishedChildren(db: Db, taskId: string): boolean {
  const { blocked } = db
    .prepare(`SELECT ${unfinishedChildSql("?")} AS blocked`)
    .get(taskId) as { blocked: number };
  return blocked === 1;
}

/** How a task appears on the board: `blocked` derived from unfinished
 *  children, `held` from an ancestor's unanswered question. Presentation
 *  only — the stored status stays one of the four persisted values. `blocked`
 *  takes precedence when both apply: it names the more local reason. */
export type BoardTask = Omit<Task, "status"> & {
  status: TaskStatus | "blocked" | "held" | "skipped";
};

function isHeld(db: Db, taskId: string): boolean {
  const { held } = db
    .prepare(`WITH RECURSIVE ${HELD_IDS_CTE} SELECT (${heldSql("?")}) AS held`)
    .get(taskId) as { held: number };
  return held === 1;
}

export function presentTask(db: Db, task: Task): BoardTask {
  if (task.status !== "todo") return { ...task, status: task.status };
  if (hasUnfinishedChildren(db, task.id)) return { ...task, status: "blocked" };
  if (isHeld(db, task.id)) return { ...task, status: "held" };
  return { ...task, status: task.status };
}

/** The shared shape behind `listBoard`/`listQueue`: the same CTE and the same
 *  blocked/held derivation, with room for one extra `CASE` branch injected
 *  before the fallback so a view can layer on one more display-only state. */
function boardRows(
  db: Db,
  extraCase: string,
  params: unknown[] = [],
): Array<Omit<TaskRow, "status"> & { status: TaskStatus | "blocked" | "held" | "skipped" }> {
  return db
    .prepare(
      `WITH RECURSIVE ${HELD_IDS_CTE}
       SELECT *,
         CASE WHEN status = 'todo' AND ${unfinishedChildSql("tasks.id")} THEN 'blocked'
              WHEN status = 'todo' AND ${heldSql("tasks.id")} THEN 'held'
              ${extraCase}
              ELSE status END AS status
       FROM tasks ORDER BY sort_key`,
    )
    .all(...params) as Array<
    Omit<TaskRow, "status"> & { status: TaskStatus | "blocked" | "held" | "skipped" }
  >;
}

/** The whole board in one query — the list view derives blocked/held in SQL
 *  rather than issuing one probe per row. */
export function listBoard(db: Db): BoardTask[] {
  const rows = boardRows(db, "");
  return rows.map((row) => ({
    ...row,
    question_options: parseOptions(row.question_options),
    question_pending_child: parsePendingChild(row.question_pending_child),
  }));
}

/** The queue view (issue #10): the board plus `skipped`, a todo-pickable task
 *  frozen by an environmental event — the Swell throttle, or (issue #26) its
 *  own execution workspace under quarantine. `skipped` is display-only and
 *  queue-view-only (CONTEXT.md's Usage limit / Quarantine) — it never reaches
 *  `listBoard`/`presentTask`, so the board keeps showing plain `todo` while
 *  either condition holds. `throttled` is computed by the caller
 *  (`isPickupBlocked`) — this module stays free of a dependency on
 *  throttle.ts. `defaultWorkspaceName` mirrors `nextSlotTask`'s own pickup
 *  gate (issue #26 / ADR 0009: `task.workspace ?? the board's default`) —
 *  absent, no workspace tracking exists and the gate is skipped entirely.
 *  `defaultAgentName` is the same gate over the agent-name generalization of
 *  quarantine (ADR 0012 / issue #36: `task.assignee ?? the board's default
 *  agent`) — absent, no agent tracking exists and this gate is skipped too.
 *  A `human`-assignee task never appears here at all (issue #13): it lives
 *  outside the execution queue entirely, in the your-tasks list
 *  (`listYourTasks`), not merely marked skipped within it. */
export function listQueue(
  db: Db,
  throttled: boolean,
  defaultWorkspaceName?: string,
  defaultAgentName?: string,
): BoardTask[] {
  const rows = boardRows(
    db,
    `WHEN status = 'todo' AND type <> 'question' AND (
       ? = 1 OR (? IS NOT NULL AND ${workspaceQuarantinedSql("tasks.workspace", "?")})
         OR (? IS NOT NULL AND ${agentQuarantinedSql("tasks.assignee", "?")})
     ) THEN 'skipped'`,
    [
      throttled ? 1 : 0,
      defaultWorkspaceName ?? null,
      defaultWorkspaceName ?? null,
      defaultAgentName ?? null,
      defaultAgentName ?? null,
    ],
  );
  return rows
    .filter((row) => row.assignee !== HUMAN_WORKER_ID)
    .map((row) => ({
      ...row,
      question_options: parseOptions(row.question_options),
      question_pending_child: parsePendingChild(row.question_pending_child),
    }));
}

/** The your-tasks list (issue #13): every unsettled `human`-assignee task,
 *  the persistent home the Assignee/Slot glossary entries promise them — they
 *  never enter the execution queue (`listQueue`) or the slot (`nextSlotTask`)
 *  at all. Ordered by `sort_key` like every other board view. */
export function listYourTasks(db: Db): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE assignee = @humanWorkerId
         AND status NOT IN ('done', 'cancelled') ORDER BY sort_key`,
    )
    .all({ humanWorkerId: HUMAN_WORKER_ID }) as TaskRow[];
  return rows.map(rowToTask);
}

export function getTask(db: Db, id: string): Task | undefined {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row && rowToTask(row);
}

/** The queue head the slot may take: lowest-sort_key todo that is
 *  agent-executable. Blocked is derived from parent/child alone — a task with
 *  an unfinished child never enters the slot — and questions never enter it
 *  either: they are human tasks, answered outside the slot (WebUI). Slot is
 *  capacity, not identity (ADR 0012 / issue #36): every assignee but `human`
 *  takes the same slot — `human` is the one assignee that always sits outside
 *  it (issue #13's your tasks), never resolved against the registry at all.
 *
 *  `defaultWorkspaceName` gates on quarantine per the task's own execution
 *  workspace (issue #26 / ADR 0009: `task.workspace ?? the board's default`)
 *  — a needs-human todo is skipped in favor of the next runnable one, so
 *  quarantine halts only the workspace it's on, never the whole board.
 *  Absent (a workspaceless board with no registered workspace at all) skips
 *  the gate entirely, same as no workspace tracking existing.
 *
 *  `defaultAgentName` is the same gate over the agent-name generalization of
 *  quarantine (ADR 0012 / issue #36: `task.assignee ?? the board's default
 *  agent`) — a resource-scoped halt, never the whole board. Absent (no agent
 *  registry tracking configured) skips this gate entirely too. */
export function nextSlotTask(
  db: Db,
  defaultWorkspaceName?: string,
  defaultAgentName?: string,
): Task | undefined {
  const row = db
    .prepare(
      `WITH RECURSIVE ${HELD_IDS_CTE}
       SELECT * FROM tasks t
       WHERE t.status = 'todo'
         AND t.type <> 'question'
         AND t.assignee IS NOT @humanWorkerId
         AND NOT ${unfinishedChildSql("t.id")}
         AND NOT ${heldSql("t.id")}
         AND (@defaultWorkspaceName IS NULL OR NOT ${workspaceQuarantinedSql(
           "t.workspace",
           "@defaultWorkspaceName",
         )})
         AND (@defaultAgentName IS NULL OR NOT ${agentQuarantinedSql(
           "t.assignee",
           "@defaultAgentName",
         )})
       ORDER BY t.sort_key LIMIT 1`,
    )
    .get({
      defaultWorkspaceName: defaultWorkspaceName ?? null,
      defaultAgentName: defaultAgentName ?? null,
      humanWorkerId: HUMAN_WORKER_ID,
    }) as TaskRow | undefined;
  return row && rowToTask(row);
}
