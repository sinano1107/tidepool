import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import type { GitHubClient, Issue, IssueRef } from "./github.js";
import type { RosterAgent } from "./registry.js";

/** Worker id attributed to bare (non ?task=) sessions, e.g. the JSON API. */
export const HUMAN_WORKER_ID = "human";

/** The one roster entry `human` gets (issue #43 / ADR 0014): human carries
 *  no registry definition, but CONTEXT.md's Roster still surfaces it as a
 *  delegable worker. A single `RosterAgent` value, not a string and a
 *  separately-built object — claude-worker.ts's push roster formats it into
 *  a "name — description" line, mcp.ts's `list_agents` pull returns it
 *  as-is, and both draw from this one source so they can't drift apart.
 *  English, like every other value that reaches an agent's own system
 *  prompt or tool output — Japanese in this file is for humans reading the
 *  source (comments, ADRs), never for text an agent session consumes.
 *  This English rule covers scaffolding (board/agent-authored text) only;
 *  human-authored payload (task titles, answers, objections, scratchpad)
 *  stays in whatever language the human wrote — see ADR 0015. */
export const HUMAN_ROSTER_AGENT: RosterAgent = {
  name: HUMAN_WORKER_ID,
  description: "delegate to a human — runs outside the slot, as a question task",
};

/** Worker id the board acts under when it enforces its own rules (issue #8):
 *  the tree rule's failures are the board's to report, never pinned on the
 *  agent. Also the sole registrant allowed a 1-choice confirmation question
 *  (issue #21) — a plain agent question always carries 2-4 choices. */
export const BOARD_WORKER_ID = "tidepool";

/** Fallback for the board's Auditor pointer (CONTEXT.md) when no
 *  configuration overrides it — the pointer "常に値を持ち「未設定」という状態
 *  はない" (ADR 0013's issue #15 grilling notes), so the literal lives here
 *  rather than requiring every call site to supply one. */
export const DEFAULT_AUDITOR_NAME = "auditor";

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
  /** For an issue-backed task (issue #49, ADR 0016), these are never the
   *  task's real content — real content is never snapshotted, only resolved
   *  live from the referenced GitHub issue (`github_issue_number`) at each
   *  use (spawn, UI display, PR title — see TaskContentSource). Until then,
   *  rowToTask fills these with the same "#N" placeholder issue #49's own
   *  spec calls for the UI to show before a first successful fetch, so every
   *  synchronous reader (decision log, notifications, console messages)
   *  keeps working without itself becoming async. */
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
  question_items: QuestionItem[] | null;
  /** One answer per item, in item order — set only when every item has been
   *  answered (issue #30): the submission is atomic, so a partial-answer
   *  state is never stored. */
  question_answer: string[] | null;
  /** The reject-reason steering channel (issue #40): one per submission (not
   *  per item), optional — set only alongside question_answer, by
   *  answerQuestion. Never set via MCP or the JSON API directly. */
  question_answer_comment: string | null;
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
  /** Issue-backed task reference (issue #49, ADR 0016): the GitHub issue
   *  number this task is a live reference to, or null for an ordinary task.
   *  `workspace` doubles as the repo half of the reference for such a task. */
  github_issue_number: number | null;
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

/** The SQLite shape of a task: items/answer/pending-child are JSON TEXT
 *  columns, and — unlike domain `Task` — the three content columns are
 *  genuinely nullable (issue #49, ADR 0016): an issue-backed task's row
 *  really has no stored content, only rowToTask fills the placeholder in for
 *  domain code. The JSON parsing and the placeholder-fill both stay at this
 *  boundary. */
export type TaskRow = Omit<
  Task,
  "question_items" | "question_answer" | "question_pending_child" | "title" | "purpose" | "completion_criteria"
> & {
  question_items: string | null;
  question_answer: string | null;
  question_pending_child: string | null;
  title: string | null;
  purpose: string | null;
  completion_criteria: string | null;
};

function parseJson<T>(json: string | null): T | null {
  return json === null ? null : JSON.parse(json);
}

/** The "#N" placeholder for an issue-backed task's unresolved content (issue
 *  #49's own spec, §6: the UI shows this before its first successful fetch).
 *  Every synchronous domain reader (decision log, notifications, console
 *  messages) sees this instead of real content — only
 *  TaskContentSource.expand(), called at the actual use-moments (spawn, UI
 *  display, PR title), ever resolves the real title/purpose/completion_criteria. */
function issueRefPlaceholder(githubIssueNumber: number): string {
  return `#${githubIssueNumber}`;
}

/** The one shape every content-nullable row reader shares: fill an
 *  issue-backed row's null title/purpose/completion_criteria with the
 *  placeholder so domain code never sees a null. rowToTask, registerTask,
 *  listBoard, and listQueue all need exactly this. */
function fillContentPlaceholder<
  T extends {
    title: string | null;
    purpose: string | null;
    completion_criteria: string | null;
    github_issue_number: number | null;
  },
>(row: T): T & { title: string; purpose: string; completion_criteria: string } {
  return {
    ...row,
    title: row.title ?? issueRefPlaceholder(row.github_issue_number!),
    purpose: row.purpose ?? issueRefPlaceholder(row.github_issue_number!),
    completion_criteria: row.completion_criteria ?? issueRefPlaceholder(row.github_issue_number!),
  };
}

export function rowToTask(row: TaskRow): Task {
  return {
    ...fillContentPlaceholder(row),
    question_items: parseJson<QuestionItem[]>(row.question_items),
    question_answer: parseJson<string[]>(row.question_answer),
    question_pending_child: parseJson<PendingChildSpec>(row.question_pending_child),
  };
}

/** One question in a bundle (issue #30): a single-item bundle is the
 *  degenerate case of the same shape (CONTEXT.md's Question), not a second
 *  form. `detail` holds implications specific to this item — the shared
 *  situation goes on the question task's `purpose` instead, so a triage
 *  reader isn't re-reading the same context once per item. */
export interface QuestionItem {
  title: string;
  detail?: string;
  options: string[];
  recommendation: string;
}

/** RegisterTaskInput's content is the one place TaskContent's three fields
 *  aren't all required (issue #49, ADR 0016): absent for an issue-backed
 *  task (registerTask persists null; TaskContentSource resolves it live at
 *  use time), required otherwise — enforced by assertGithubRef, not the
 *  type system. */
export interface RegisterTaskInput extends Partial<TaskContent> {
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
  /** 1-4 question items (issue #30) — a single-item array is the degenerate
   *  case, not a distinct shape. */
  question?: QuestionItem[];
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
  /** Issue-backed task reference (issue #49, ADR 0016): the GitHub issue
   *  number this task is a live reference to. Absent for an ordinary task. */
  github_issue_number?: number;
}

/** Every question carries 1-4 items (issue #30), each with 2-4 options plus a
 *  recommendation among them, whichever door it enters by (escalate, or a
 *  tidepool-internal registerTask call — watchdog/quarantine/merge/decompose;
 *  the JSON API refuses `type: "question"` outright, issue #38) — the answer
 *  view is one-tap first, free text only as an override. The degraded
 *  free-text-only question is reserved for the watchdog's auto-escalation
 *  safety valve (#17).
 *
 *  An item's option floor relaxes to 1 only for an actual quarantine
 *  Confirmation question (issue #21, CONTEXT.md) — `quarantine_workspace` or
 *  (ADR 0012 / issue #36) `quarantine_agent` set, which only
 *  quarantineWorkspace / quarantineAgent themselves ever do: it asks for a
 *  completion confirmation, not a choice, and a fake second option would be
 *  filler with no effect of its own. This is deliberately keyed on those
 *  fields rather than the registering `workerId` (e.g. `=== BOARD_WORKER_ID`):
 *  a worker's id is operator-configured and could collide with
 *  BOARD_WORKER_ID by accident, which would otherwise let an ordinary agent
 *  question sneak past the 2-4 floor. `quarantine_workspace`/
 *  `quarantine_agent` are never reachable from MCP or the JSON API (unlike an
 *  assignee/worker id), so this floor can't be gamed the same way — an
 *  agent's question is always a real 2-4-way choice. */
function assertQuestionSpec(input: RegisterTaskInput): void {
  if (input.type !== "question") {
    if (input.question) throw new DomainError("only a question task carries options");
    if (input.cancel_option) throw new DomainError("only a question task carries a cancel option");
    return;
  }
  const items = input.question;
  if (!items || items.length < 1 || items.length > 4) {
    throw new DomainError("a question carries 1 to 4 items");
  }
  const minOptions =
    input.quarantine_workspace !== undefined || input.quarantine_agent !== undefined ? 1 : 2;
  for (const item of items) {
    if (!item.title.trim()) throw new DomainError("a question item carries a title");
    if (item.options.length < minOptions || item.options.length > 4) {
      throw new DomainError(`a question item carries ${minOptions} to 4 options`);
    }
    if (!item.recommendation.trim() || !item.options.includes(item.recommendation)) {
      throw new DomainError(
        "a question item carries the registrant's recommendation, one of its options",
      );
    }
  }
  if (input.cancel_option !== undefined) {
    if (!items[0]!.options.includes(input.cancel_option)) {
      throw new DomainError("a cancel option must be one of the question's options");
    }
    // the abandon cascade (answerQuestion) walks up from the question's own
    // parent, so a cancel option is meaningless without one
    if (!input.parent_id) {
      throw new DomainError("a cancel option requires a parent task");
    }
  }
}

/** ADR 0016: unlike an ordinary task's workspace — a reference resolved
 *  fresh at every use (ADR 0009) — an issue-backed task's workspace is a
 *  confirmed value, required at registration, because it's the repo half of
 *  the identity of the issue it points at (a swapped default must never
 *  silently repoint it at another repo's same-numbered issue). */
function assertGithubRef(input: RegisterTaskInput): void {
  if (input.github_issue_number !== undefined) {
    if (!input.workspace) {
      throw new DomainError("an issue-backed task requires a workspace at registration");
    }
    // exclusivity, not just a workspace requirement (ADR 0016: "盤面には参照
    // だけを保存し、内容は使用の瞬間に展開する" — content is never
    // snapshotted, so an issue-backed task must carry none of the three).
    if (
      input.title !== undefined ||
      input.purpose !== undefined ||
      input.completion_criteria !== undefined
    ) {
      throw new DomainError("an issue-backed task carries no stored content");
    }
  } else if (!input.title || !input.purpose || !input.completion_criteria) {
    throw new DomainError(
      "a task requires title, purpose, and completion_criteria unless it is issue-backed",
    );
  }
}

/** Derives an issue-backed task's three content fields from its live GitHub
 *  issue (issue #49, ADR 0016): title and purpose come straight from the
 *  issue's own title and body, completion_criteria is a fixed template
 *  deferring to the issue body rather than a field the issue doesn't have —
 *  none of the three is ever stored, this runs fresh at every use (spawn and
 *  UI display). */
export function deriveTaskContentFromIssue(issue: Issue): TaskContent {
  return {
    title: issue.title,
    purpose: issue.body,
    completion_criteria: "See the linked GitHub issue's body and comments for completion criteria.",
  };
}

/** A task's content, resolved on demand (issue #49, ADR 0016's live 参照):
 *  an ordinary task's content is already known and resolves at once; an
 *  issue-backed task's expand() awaits a live GitHub fetch instead. Callers
 *  must expand() *before* entering a db.transaction() — better-sqlite3's
 *  transactions run synchronously and cannot await mid-flight.
 *
 *  Design notes for future revisits, not current obligations:
 *  - This class is essentially a named wrapper around
 *    `() => Promise<TaskContent>` — a plain function type plus two factory
 *    functions would work identically. The class form is kept only for the
 *    name's discoverability; if it ever accretes state or a third concern,
 *    prefer flattening it back to functions over growing it.
 *  - If reference kinds ever multiply beyond GitHub issues (a PR-backed or
 *    external-ticket-backed task), reconsider modeling Task's content as a
 *    discriminated union ({kind:"stored",...} | {kind:"issueRef",...})
 *    instead of flat nullable columns + this resolver: the union makes
 *    "reference and snapshotted content coexist" unrepresentable at the type
 *    level (the exclusivity assertGithubRef/the DB CHECK enforce by hand
 *    today), at the cost of forcing every one of the ~40 synchronous readers
 *    to branch — a ripple judged not worth it at the current single-kind
 *    scale (2026-07 review of issue #49). */
export class TaskContentSource {
  private constructor(private readonly resolve: () => Promise<TaskContent>) {}

  static stored(content: TaskContent): TaskContentSource {
    return new TaskContentSource(() => Promise.resolve(content));
  }

  static liveIssue(github: GitHubClient, ref: IssueRef): TaskContentSource {
    return new TaskContentSource(async () => deriveTaskContentFromIssue(await github.getIssue(ref)));
  }

  expand(): Promise<TaskContent> {
    return this.resolve();
  }
}

/** The one branch point between a task's two content sources (issue #49):
 *  every use-moment (spawn, UI display, PR title) goes through here instead
 *  of checking `github_issue_number` itself, so a new use-moment can't
 *  forget the issue-backed case and silently serve the "#N" placeholder.
 *  `workspacePath` is a thunk because resolving a workspace has side effects
 *  (resolveOrQuarantine can quarantine a name) — an ordinary task must never
 *  trigger them, so it's only invoked on the issue-backed branch. Falling
 *  back to the stored placeholder when GitHub or the workspace is
 *  unavailable is interim behavior — ADR 0016's real failure taxonomy
 *  (temporary → pickup skip, permanent → failure question) is later scope. */
export function contentSourceFor(
  task: Task,
  github: GitHubClient | undefined,
  workspacePath: () => string | undefined,
): TaskContentSource {
  const stored = TaskContentSource.stored({
    title: task.title,
    purpose: task.purpose,
    completion_criteria: task.completion_criteria,
  });
  if (task.github_issue_number == null || !github) return stored;
  const path = workspacePath();
  if (path === undefined) return stored;
  return TaskContentSource.liveIssue(github, { path, number: task.github_issue_number });
}

/** New tasks always join the queue tail: sort_key = max + 1. */
export function registerTask(
  db: Db,
  input: RegisterTaskInput,
  now: Date,
  workerId: string = HUMAN_WORKER_ID,
): Task {
  assertQuestionSpec(input);
  assertGithubRef(input);
  const { maxKey } = db
    .prepare("SELECT COALESCE(MAX(sort_key), 0) AS maxKey FROM tasks")
    .get() as { maxKey: number };
  // stored is nullable (issue #49); the in-memory Task returned to the
  // caller never is — an issue-backed task gets the same "#N" placeholder
  // rowToTask fills in on every later read, so registerTask's own return
  // isn't a special case in what it hands back.
  const content = fillContentPlaceholder({
    title: input.title ?? null,
    purpose: input.purpose ?? null,
    completion_criteria: input.completion_criteria ?? null,
    github_issue_number: input.github_issue_number ?? null,
  });
  const task: Task = {
    id: randomUUID(),
    type: input.type,
    status: "todo",
    assignee: input.assignee ?? null,
    workspace: input.workspace ?? null,
    title: content.title,
    purpose: content.purpose,
    completion_criteria: content.completion_criteria,
    risk_flag: input.risk_flag ? 1 : 0,
    review_flag: input.review_flag ? 1 : 0,
    parent_id: input.parent_id ?? null,
    sort_key: maxKey + 1,
    handoff_doc: null,
    pr_number: null,
    question_items: input.question ?? null,
    question_answer: null,
    question_answer_comment: null,
    question_cancel_option: input.cancel_option ?? null,
    question_pending_child: input.pending_child ?? null,
    question_pending_merge_pr: input.pending_merge_pr ?? null,
    question_quarantine_workspace: input.quarantine_workspace ?? null,
    question_quarantine_agent: input.quarantine_agent ?? null,
    github_issue_number: input.github_issue_number ?? null,
    created_at: now.toISOString(),
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (id, type, status, assignee, workspace, title, purpose, completion_criteria,
         risk_flag, review_flag, parent_id, sort_key, handoff_doc, pr_number,
         question_items, question_answer, question_answer_comment, question_cancel_option,
         question_pending_child, question_pending_merge_pr, question_quarantine_workspace,
         question_quarantine_agent, github_issue_number, created_at)
       VALUES (@id, @type, @status, @assignee, @workspace, @title, @purpose, @completion_criteria,
         @risk_flag, @review_flag, @parent_id, @sort_key, @handoff_doc, @pr_number,
         @question_items, @question_answer, @question_answer_comment, @question_cancel_option,
         @question_pending_child, @question_pending_merge_pr, @question_quarantine_workspace,
         @question_quarantine_agent, @github_issue_number, @created_at)`,
    ).run({
      ...task,
      // the stored row keeps title/purpose/completion_criteria genuinely
      // null for an issue-backed task (ADR 0016: never snapshotted) — only
      // `task`, the in-memory value handed back to the caller, carries the
      // "#N" placeholder.
      title: input.title ?? null,
      purpose: input.purpose ?? null,
      completion_criteria: input.completion_criteria ?? null,
      question_items: task.question_items && JSON.stringify(task.question_items),
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

export interface EscalateInput {
  /** The shared situation behind every item in this bundle (issue #30) —
   *  becomes the registered question task's `purpose`. */
  context: string;
  /** 1-4 question items, whichever door escalate enters by. */
  questions: QuestionItem[];
  /** System-internal only (ADR 0006) — absent from the MCP tool schema and
   *  the JSON API; only the watchdog's failure-question path sets this.
   *  Meaningful only for a single-item bundle (the item it targets). */
  cancel_option?: string;
}

/** Escalation: a question child carrying a bundle of 1-4 items, each with
 *  2-4 choices and the registrant's recommendation (enforced at registration,
 *  like every question) — a single-item bundle is the degenerate case of the
 *  same shape (issue #30), not a distinct one. The parent returns to `todo`
 *  (blocked is derived from the unfinished child, never stored) and the slot
 *  is freed by the caller. The registered task's own `title` is the bundle's
 *  first item's — for the common single-item case this is exactly the
 *  question's own title, same as before the bundle existed. */
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
        title: input.questions[0]!.title,
        purpose: input.context,
        completion_criteria: "a human answer is recorded",
        parent_id: parent.id,
        question: input.questions,
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

/** The human steering channel: answer a question from the WebUI. One answer
 *  per item, in item order — the submission is atomic (issue #30): a length
 *  mismatch is refused outright and nothing is persisted, so a partial-answer
 *  state never exists. Each answer is either a one-tap option or a free-text
 *  override, either way a plain string. The question completes only once
 *  every item is answered; only a parent this answer actually unblocks
 *  returns to the queue head (the caller fires the immediate poll on
 *  `parentUnblocked`).
 *
 *  `stageUnblock` defers the head move: when given (an open triage session),
 *  the answer is just as durable but the unblocked parent is handed to the
 *  callback instead of moving — the queue only changes at triage commit.
 *
 *  Every system-internal special case below (abandon, quarantine
 *  confirmation, pending-child approval) is reachable only through a
 *  length-1 question (CONTEXT.md's Confirmation question / ADR 0006), so each
 *  reads `answers[0]` — the degenerate case of the same bundle shape, not a
 *  second code path.
 *
 *  Abandon (ADR 0006): when the sole answer matches the question's declared
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
  answers: string[],
  now: Date,
  stageUnblock?: (taskId: string) => void,
  /** The reject-reason steering channel (issue #40): optional, one per
   *  submission (not per item) — a reject often needs no more than the
   *  option name, so this is never required. Carried verbatim onto the
   *  `question_answered` event; omitted from the event payload entirely
   *  when absent, rather than stored as null, so an unanswered comment
   *  leaves the event shape exactly as it was before this existed. */
  comment?: string,
): { question: Task; parentUnblocked: boolean; pickupResumed: boolean } {
  if (question.type !== "question") {
    throw new DomainError("only a question task can be answered");
  }
  if (question.status !== "todo") {
    throw new DomainError(`a ${question.status} question cannot be answered`);
  }
  const items = question.question_items!;
  if (answers.length !== items.length) {
    throw new DomainError(
      `this question carries ${items.length} item(s), but ${answers.length} answer(s) were submitted`,
    );
  }
  const answer = answers[0]!;
  let parentUnblocked = false;
  let pickupResumed = false;
  db.transaction(() => {
    db.prepare(
      "UPDATE tasks SET status = 'done', question_answer = ?, question_answer_comment = ? WHERE id = ?",
    ).run(JSON.stringify(answers), comment ?? null, question.id);
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
        answers: answers.map((a, i) => ({
          answer: a,
          recommendation_accepted: a === items[i]!.recommendation,
        })),
        recommended_by: registered?.worker_id ?? HUMAN_WORKER_ID,
        ...(comment !== undefined && { comment }),
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
  const title = `merge PR #${prNumber}: ${task.title}`;
  registerTask(
    db,
    {
      type: "question",
      title,
      purpose,
      completion_criteria: "a human decides whether to merge",
      question: [{ title, options: [...MERGE_QUESTION_OPTIONS], recommendation }],
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
 *  today's pre-#11 baseline. A task executing against a protected workspace
 *  (CONTEXT.md / ADR 0013) always asks, same as `escalate`, overriding
 *  whatever dial (including none) the executing worker's profile carries —
 *  "PR to a protected workspace always needs a human merge" is a
 *  resource-side invariant, independent of the dial. */
export function recordPrOpened(
  db: Db,
  task: Task,
  prNumber: number,
  workerId: string,
  now: Date,
  authority?: AuthorityContext,
  isProtected?: boolean,
): void {
  db.transaction(() => {
    db.prepare("UPDATE tasks SET pr_number = ? WHERE id = ?").run(prNumber, task.id);
    appendEvent(db, {
      taskId: task.id,
      workerId,
      payload: { kind: "pr_opened", pr_number: prNumber },
      at: now,
    });
    if (isProtected || authority?.merge === "escalate") {
      registerMergeQuestion(
        db,
        task,
        prNumber,
        isProtected
          ? `"${task.title}" completed and opened PR #${prNumber} against a protected ` +
            `workspace — always needs a human merge, regardless of the merge dial. Merge it now?`
          : `"${task.title}" completed and opened PR #${prNumber}. Merge it now?`,
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

/** The explicit "unrestricted" marker an assignable_to/allowed_workspaces
 *  allowlist can carry (issue #41) — a registry profile must spell this out
 *  rather than get it by omitting the field. */
export const AUTHORITY_WILDCARD = "*";

/** A requested value is out of authority only when it's explicitly stated
 *  (an unstated value never itself needs approval) and the profile actually
 *  restricts it (no allowlist configured means unrestricted, same as an
 *  allowlist carrying the explicit wildcard AUTHORITY_WILDCARD — issue #41: a
 *  registry profile must spell out "unrestricted" rather than get it by
 *  omission, but the meaning is unchanged). Shared by the assignable_to and
 *  allowed_workspaces checks in decomposeTask — risk_flag's check is its own
 *  shape (compared against the parent's flag, not a list). */
function outsideAuthority(value: string | undefined, allowlist: string[] | undefined): boolean {
  return (
    value !== undefined &&
    allowlist !== undefined &&
    !allowlist.includes(AUTHORITY_WILDCARD) &&
    !allowlist.includes(value)
  );
}

/** The one assignee a review task's `assignable_to` can never restrict (ADR
 *  0013): the reviewed task's own executor — a review's repair children may
 *  always target them, since that's part of what a review *is*, not a
 *  delegation the reviewer happens to hold. Exported so callers that need to
 *  predict decomposeTask's own verdict (mcp.ts's `list_agents`, issue #43 /
 *  ADR 0014) share this exact lookup rather than reimplementing it and
 *  risking drift from decomposeTask's actual check below. */
export function reviewedTaskAssignee(db: Db, task: Task): string | undefined {
  return task.type === "review" && task.parent_id
    ? (getTask(db, task.parent_id)?.assignee ?? undefined)
    : undefined;
}

/** Whether assigning `name` from `task` would need a human approval question
 *  rather than registering outright — the single source decomposeTask's own
 *  per-child check below and mcp.ts's `list_agents` roster marking (issue
 *  #43 / ADR 0014) both call, so the two can never diverge: the ADR 0013
 *  reviewed-assignee exemption first, then the plain `assignable_to` check. */
export function assigneeNeedsApproval(
  db: Db,
  task: Task,
  name: string | undefined,
  authority: AuthorityContext | undefined,
): boolean {
  if (name !== undefined && name === reviewedTaskAssignee(db, task)) return false;
  return outsideAuthority(name, authority?.assignable_to);
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
  /** Whether an explicitly named workspace is protected (CONTEXT.md's
   *  protected workspace / ADR 0013), resolved by the caller against the
   *  registry. A protected target converts unconditionally, regardless of
   *  the registering worker's `allowed_workspaces` — "changes to it always
   *  need human approval" is a resource-side invariant independent of any
   *  profile. Absent → no workspace is protected. */
  isProtectedWorkspace?: (name: string) => boolean,
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
      // A review's repair children may target the reviewed task's own
      // executor regardless of the reviewer profile's assignable_to (ADR
      // 0013) — assigneeNeedsApproval carries that exemption, shared with
      // mcp.ts's list_agents so the two can never diverge (issue #43).
      if (assigneeNeedsApproval(db, parent, child.assignee, authority)) {
        reasons.push(`assigns to "${child.assignee}", outside ${workerId}'s assignable_to`);
      }
      if (outsideAuthority(child.workspace, authority?.allowed_workspaces)) {
        reasons.push(
          `targets workspace "${child.workspace}", outside ${workerId}'s allowed_workspaces`,
        );
      }
      if (child.workspace !== undefined && isProtectedWorkspace?.(child.workspace)) {
        reasons.push(`targets protected workspace "${child.workspace}"`);
      }
      // an unstated workspace inherits the parent's (CONTEXT.md): it was
      // already authorized when the parent landed there, so this is a
      // default fill-in, never itself a reason for a question
      const workspace = child.workspace ?? parent.workspace ?? undefined;
      if (reasons.length > 0) {
        const questionTitle = `authorize child registration: ${child.title}`;
        registerTask(
          db,
          {
            type: "question",
            title: questionTitle,
            purpose:
              `"${child.title}" ${reasons.join("; ")} — outside ${workerId}'s authority to ` +
              `register unapproved. ${child.purpose}`,
            completion_criteria: "a human approves or rejects the child registration",
            parent_id: parent.id,
            question: [
              { title: questionTitle, options: [...PENDING_CHILD_OPTIONS], recommendation: "approve" },
            ],
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

/** The type-aware fallback pointer behind `agentQuarantinedSql`'s `defaultRef`
 *  (issue #42 / CONTEXT.md's Auditor): an unset assignee on a `review` task
 *  resolves to the board's Auditor pointer, every other type to the board's
 *  default agent — same COALESCE-based "unset = live reference" shape either
 *  way (ADR 0011), just a different pointer depending on task type. Absent
 *  the relevant pointer for a given row's type, that row's `defaultRef`
 *  evaluates to NULL, which `agentQuarantinedSql`'s COALESCE/`=` already
 *  treats as "no fallback, gate only an explicit assignee" — no separate
 *  null-guard needed here. */
export function typeAwareDefaultAgentSql(
  taskTypeRef: string,
  defaultAgentRef: string,
  auditorRef: string,
): string {
  return `CASE WHEN ${taskTypeRef} = 'review' THEN ${auditorRef} ELSE ${defaultAgentRef} END`;
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

/** Settled tree (CONTEXT.md's Board, issue #35): walks every tree down from
 *  its root, tagging each task with that root's id and whether the task
 *  itself is unsettled (not done/cancelled). A root's tree only fully
 *  retreats from the board once none of its descendants are unsettled — a
 *  root going `done` does not by itself qualify, since layer 1/2 review
 *  children (`completeTask`'s auto-generated review, an objection's RCA
 *  review) start `todo` under an already-`done` root (issue #35 comment). */
const SETTLED_TREE_CTE = `
  tree_status(id, root_id, unsettled) AS (
    SELECT id, id, CASE WHEN status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END
    FROM tasks WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, t.root_id, CASE WHEN c.status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END
    FROM tasks c JOIN tree_status t ON c.parent_id = t.id
  ),
  unsettled_roots(root_id) AS (
    SELECT DISTINCT root_id FROM tree_status WHERE unsettled = 1
  )
`;

/** `idRef` is the SQL expression holding the candidate task's id. */
export function settledTreeSql(idRef: string): string {
  return `${idRef} IN (SELECT id FROM tree_status
            WHERE root_id NOT IN (SELECT root_id FROM unsettled_roots))`;
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
      `WITH RECURSIVE ${HELD_IDS_CTE}, ${SETTLED_TREE_CTE}
       SELECT *,
         CASE WHEN status = 'todo' AND ${unfinishedChildSql("tasks.id")} THEN 'blocked'
              WHEN status = 'todo' AND ${heldSql("tasks.id")} THEN 'held'
              ${extraCase}
              ELSE status END AS status
       FROM tasks
       WHERE status <> 'cancelled' AND NOT ${settledTreeSql("tasks.id")}
       ORDER BY sort_key`,
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
    ...fillContentPlaceholder(row),
    question_items: parseJson<QuestionItem[]>(row.question_items),
    question_answer: parseJson<string[]>(row.question_answer),
    question_pending_child: parseJson<PendingChildSpec>(row.question_pending_child),
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
 *  `defaultAgentName`/`auditorName` are the same gate over the agent-name
 *  generalization of quarantine (ADR 0012 / issue #36: `task.assignee ?? the
 *  board's default agent`), made type-aware (issue #42 / CONTEXT.md's
 *  Auditor): a `review` task's unset assignee falls back to `auditorName`,
 *  every other type to `defaultAgentName` — `nextSlotTask`'s own
 *  `typeAwareDefaultAgentSql`, bound the same way via named `@auditorName`/
 *  `@defaultAgentName` params (better-sqlite3 allows mixing named params into
 *  an otherwise-positional statement) so the fragment can be spliced into the
 *  query twice — the not-configured skip check, then inside
 *  `agentQuarantinedSql` itself — without a second, positionally-paired copy
 *  of the params to keep in sync by hand. Either pointer absent skips this
 *  gate for the rows that would have fallen back to it. A `human`-assignee
 *  task never appears here at all (issue #13): it lives outside the
 *  execution queue entirely, in the your-tasks list (`listYourTasks`), not
 *  merely marked skipped within it. */
export function listQueue(
  db: Db,
  throttled: boolean,
  defaultWorkspaceName?: string,
  defaultAgentName?: string,
  auditorName?: string,
): BoardTask[] {
  const fallback = typeAwareDefaultAgentSql("tasks.type", "@defaultAgentName", "@auditorName");
  const rows = boardRows(
    db,
    `WHEN status = 'todo' AND type <> 'question' AND (
       ? = 1 OR (? IS NOT NULL AND ${workspaceQuarantinedSql("tasks.workspace", "?")})
         OR (${fallback} IS NOT NULL AND ${agentQuarantinedSql("tasks.assignee", fallback)})
     ) THEN 'skipped'`,
    [
      throttled ? 1 : 0,
      defaultWorkspaceName ?? null,
      defaultWorkspaceName ?? null,
      { defaultAgentName: defaultAgentName ?? null, auditorName: auditorName ?? null },
    ],
  );
  return rows
    .filter((row) => row.assignee !== HUMAN_WORKER_ID)
    .map((row) => ({
      ...fillContentPlaceholder(row),
      question_items: parseJson<QuestionItem[]>(row.question_items),
      question_answer: parseJson<string[]>(row.question_answer),
      question_pending_child: parseJson<PendingChildSpec>(row.question_pending_child),
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

/** issue #29's `get_current_task` shape for one settled (done/cancelled)
 *  direct child — a done question's answer, a done work's handoff doc
 *  verbatim (CONTEXT.md's Handoff doc: question/review carry none), or
 *  (any type, cancelled) the abandon question that ended it. No summarizing
 *  middle layer, extended here to every settled-child shape. */
export interface SettledChildContext {
  title: string;
  status: "done" | "cancelled";
  handoff_doc?: string | null;
  /** A done question's bundle (issue #30), one per item, in item order. */
  items?: QuestionItem[];
  answer?: string[] | null;
  /** The reject-reason steering channel (issue #40) — carried alongside
   *  `answer` so a resumed parent reads why, not just what. */
  comment?: string | null;
  origin_question?: { title: string; answer: string[] | null } | null;
}

/** A cancelled task's one `task_cancelled` event names the abandon question
 *  that ended the whole plan (ADR 0006) — a single hop back to it is the
 *  entire "why" a resumed parent needs. */
function cancelOriginQuestion(db: Db, taskId: string): Task | undefined {
  const row = db
    .prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'task_cancelled'")
    .get(taskId) as { payload: string } | undefined;
  if (!row) return undefined;
  const { origin_question_id } = JSON.parse(row.payload) as { origin_question_id: string };
  return getTask(db, origin_question_id);
}

/** Settled direct children only (CONTEXT.md: 供給範囲は直接の子まで) — a
 *  todo/in_progress child is never returned (its parent isn't pickable to
 *  ask in the first place; surfacing it would only invite interference with
 *  a sibling still in flight). Registration order (sort_key), same order the
 *  children joined the queue in. */
export function settledChildren(db: Db, parentId: string): SettledChildContext[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE parent_id = ? AND status IN ('done', 'cancelled')
       ORDER BY sort_key`,
    )
    .all(parentId) as TaskRow[];
  return rows.map(rowToTask).map((child): SettledChildContext => {
    if (child.status === "cancelled") {
      const origin = cancelOriginQuestion(db, child.id);
      return {
        title: child.title,
        status: "cancelled",
        origin_question: origin ? { title: origin.title, answer: origin.question_answer } : null,
      };
    }
    if (child.type === "question") {
      return {
        title: child.title,
        status: "done",
        items: child.question_items ?? [],
        answer: child.question_answer,
        comment: child.question_answer_comment,
      };
    }
    return { title: child.title, status: "done", handoff_doc: child.handoff_doc };
  });
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
 *  registry tracking configured) skips this gate entirely too.
 *
 *  `auditorName` is the same gate, but for the fallback a `review` task's
 *  unset `assignee` actually resolves to (issue #42 / CONTEXT.md's Auditor):
 *  a review task never falls back to `defaultAgentName`, even when that
 *  pointer is healthy — `typeAwareDefaultAgentSql` picks the pointer per row
 *  by `t.type`. Absent, review tasks skip this gate too (same "not
 *  configured" fallback as `defaultAgentName`). */
export function nextSlotTask(
  db: Db,
  defaultWorkspaceName?: string,
  defaultAgentName?: string,
  auditorName?: string,
): Task | undefined {
  const fallback = typeAwareDefaultAgentSql("t.type", "@defaultAgentName", "@auditorName");
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
         AND (${fallback} IS NULL OR NOT ${agentQuarantinedSql("t.assignee", fallback)})
       ORDER BY t.sort_key LIMIT 1`,
    )
    .get({
      defaultWorkspaceName: defaultWorkspaceName ?? null,
      defaultAgentName: defaultAgentName ?? null,
      auditorName: auditorName ?? null,
      humanWorkerId: HUMAN_WORKER_ID,
    }) as TaskRow | undefined;
  return row && rowToTask(row);
}
