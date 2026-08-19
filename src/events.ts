import type { Db } from "./db.js";
import type { TaskType } from "./tasks.js";

/** What the advisor **actually did** in one worker session (issue #33 判断6),
 *  as against `worker_spawned.advisor`'s "what the board asked for". Carried by
 *  `worker_exited.usage.advisor`, where null means no consultation was observed
 *  at all — see that field for what the null deliberately collapses.
 *
 *  Named rather than inlined because the adapter builds it in two pieces and
 *  would otherwise spell `NonNullable<NonNullable<…>["advisor"]>` at each. */
export interface AdvisorRecord {
  /** The resolved model id the advisor actually ran as — `opus` resolves
   *  differently per host CLI version (measured), so the alias in
   *  worker_spawned does not settle it. null when the session consulted but
   *  the CLI reported no resolved id: the result line names it only for the
   *  **final turn**, so a session whose last consultation came earlier leaves
   *  it unrecorded. Deriving it from the per-model cost breakdown is not
   *  available either — that breakdown can hold the CLI's internal helper
   *  model too, so subtracting the main model does not leave one answer. */
  model: string | null;
  /** How many times the parent thread consulted, counted off the stream. Kept
   *  outside `usage` because it survives the cases `usage` does not, and
   *  because cost alone cannot tell "one consultation in a long conversation"
   *  from "three in a short one".
   *
   *  It counts the **parent thread only** — a subagent's consultations never
   *  appear in the parent's stream (measured) while their cost still lands in
   *  the session total, so this and `usage` have different denominators and
   *  **`usage` is not divisible by `consultations`**: any per-consultation
   *  cost derived from the pair is wrong. By the same asymmetry, a session
   *  where only subagents consulted reports the whole record as null while its
   *  advisor cost is still inside `estimated_cost_usd`. */
  consultations: number;
  /** The advisor's own slice of the session's consumption — the same shape the
   *  enclosing `usage` reports for the main model, hence the same name
   *  (CONTEXT.md's Worker session: 「トークン消費の内訳と推定ドル」). It is
   *  deliberately **not** called `spend`: this codebase already spells
   *  Spend-down(使い切り)that way, and one word for two unrelated concepts
   *  is how a glossary starts to rot.
   *
   *  null = "could not be measured", never 0 — the same posture as
   *  `usage: null` ("the session ran but filed no report"). Unmeasurable when
   *  `model` is null, when the advisor resolved to the same model as the main
   *  one (which merges both into a single per-model entry — measured), or when
   *  the main model's own resolved id was never observed, since then
   *  separability itself is unknown. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  } | null;
}

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
  // ADR 0073: a completed root work task had no commits to carry to its
  // protected branch. This is a board-observed fact, not a human decision.
  | { kind: "nothing_to_land"; base: string }
  // issue #11: a completed work task's handoff opened this PR — pr_number is
  // the durable link the merge dial (escalate / auto_if_ci_green; `external`
  // leaves the PR to GitHub's own surface — ADR 0079) reads back
  | { kind: "pr_opened"; pr_number: number }
  // issue #11: the merge dial's escalate answer actually merged this PR,
  // right after a live CI check confirmed success immediately beforehand
  | { kind: "pr_merged"; pr_number: number }
  // ADR 0079 決定4: the board did NOT merge this PR — it found the PR already
  // merged on a surface it holds a decision on (an open merge question, the
  // auto-merge queue) and retired that decision. Spelled apart from pr_merged
  // on purpose: "the board merged it" and "the board observed it merged" are
  // different facts, and the narrowed canon claim (judgement is the board's
  // record only for merges the board decides) is unverifiable without the
  // distinction
  | { kind: "pr_merge_observed"; pr_number: number }
  // issue #11: a risk-approval question's "approve" answer raised the
  // parent's risk_flag (upward propagation) — origin_question_id is that
  // question, so the audit trail for the flag flip never needs a join
  | { kind: "risk_flag_raised"; origin_question_id: string }
  // ADR 0006 / 0048: a task cancelled by abandon's decision-scoped cascade —
  // origin_question_id is the answered failure question, shared by every task
  // touched by the cascade (including the failed task's own subtree)
  | { kind: "task_cancelled"; origin_question_id: string }
  // issue #130: a human's direct cancel — the second cancel path (CONTEXT.md's
  // Cancel), no failure question above it, so reason is the human's own free
  // text (null when they gave none). Shared by every task the cascade touches
  // (the target and its unfinished descendants), same as task_cancelled above.
  | { kind: "task_cancelled_directly"; reason: string | null }
  // issue #130: a human overwrote one editable field of a registered task. The
  // edit is an append event, never a silent overwrite — `from` preserves the
  // pre-edit value in the log forever (write-path statistical purity), one
  // event per changed field. Booleans (risk_flag/review_flag) are stringified.
  | { kind: "task_edited"; field: string; from: string | null; to: string | null }
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
  | { kind: "log_entry_displayed"; entry_id: number; session_id?: number }
  // full provenance of an agent run. registry_commit is THE strict agent
  // version (ADR 0001: commit hash = agent version); definition_version is
  // only the human-readable stamp from the definition's frontmatter. The
  // vocabulary is registry-shaped, not vendor-shaped — no CLI names leak in.
  //
  // `advisor` (issue #33 判断6) is the advisor model the board actually pinned
  // for this session, verbatim as the registry spells it (an alias like
  // `opus`, or a full model id) — registry-shaped text, so it does not breach
  // the line above. null means the session was launched with the advisor tool
  // explicitly disabled, which collapses two causes: the agent has no advisor
  // capability, or the host-side kill switch (判断8) was on. Recording the
  // *pinned* value rather than the frontmatter's is deliberate — the
  // frontmatter is already recoverable from registry_commit, whereas the host
  // mask is not recoverable from anything, and CONTEXT.md's Advisor requires
  // each session's effective configuration to be settleable from the event
  // history alone.
  //
  // This is what the board *asked for*, never what ran: a capability-
  // insufficient advisor is accepted at launch and silently left unattached
  // (measured). Whether it actually ran lives on the other half of the pair,
  // worker_exited.usage.advisor.
  | {
      kind: "worker_spawned";
      registry_commit: string;
      definition_version: string;
      advisor: string | null;
    }
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
  // issue #60 / ADR 0033: the host-wide twin of the two above — the worker
  // sandbox's capability check was re-run at answer time and passed, so pickup
  // resumes board-wide. It names no resource because the sandbox belongs to the
  // host the board runs on, not to a workspace or an agent.
  | { kind: "sandbox_reinstated" }
  // ADR 0052: registry remote reachability was rechecked successfully when
  // its Confirmation question was answered, so board-wide pickup resumes.
  | { kind: "registry_reinstated" }
  | { kind: "cli_auth_reinstated" }
  // issue #32: pairs with worker_spawned to close out a worker session
  // (spawn~exit) — usage is null when the session ended without a final
  // stream-json `result` event (e.g. watchdog kill); the event itself is
  // always written, so a missing report never erases the session's cost.
  // estimated_cost_usd mirrors the CLI's total_cost_usd verbatim, but named
  // for the board's own vocabulary: under a subscription there is no real
  // invoice, only this run-time API-equivalent estimate.
  //
  // **The token fields and the cost field do not count the same thing**
  // (issue #33, measured 2026-08-04 — the CLI's own asymmetry, not the
  // board's choice). The token counts come from the result line's `usage`,
  // which reports the **main model on the parent thread only**; the cost
  // comes from `total_cost_usd`, which is the sum over **every model the
  // session moved** — the CLI's internal helper model, subagents, and the
  // advisor. The gap predates the advisor (the helper model's small calls),
  // but an advisor makes it large: one measured consultation was 67% of the
  // session total. The fields are left as they are so rows stay comparable
  // across the change; `advisor` below is what makes the gap readable
  // instead of silent.
  | {
      kind: "worker_exited";
      exit_code: number | null;
      signal: string | null;
      // issue #125: the tail (last ~20 lines) of the worker session's stderr,
      // where process-level failures leave their evidence. null means the
      // session wrote nothing there, keeping "quiet exit" distinguishable
      // from a broken capture. The verbatim full text is saved by the worker
      // adapter alongside its transcript (adapter-specific layout — ADR
      // 0005); this field is the event-side pointer into it.
      stderr_tail: string | null;
      // issue #379: the id of the `worker_spawned` event that opened this
      // same session — a task can have several worker sessions (retry /
      // decompose 統合復帰 / quarantine 復帰), and the adapter now names each
      // session's transcript/stderr file `<taskId>.<this id>.stream.jsonl` /
      // `.stderr.log`, so this is what lets a reader of worker_exited
      // reconstruct which file belongs to it.
      worker_spawned_event_id: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        estimated_cost_usd: number;
        /** issue #33 判断6: what the advisor **actually did** this session, as
         *  against worker_spawned.advisor's "what the board asked for". null
         *  means no consultation was observed at all — which deliberately
         *  collapses "configured, attached, never consulted" with
         *  "configured, silently never attached". Only a consultation is
         *  positive evidence of attachment, and the sole discriminator the
         *  CLI offers is one English warning line on stderr; matching it
         *  would be a detector that degrades silently when the vendor
         *  rewords it — the exact shape ADR 0041 exists to refuse. The two
         *  differ in cause but not in effect (neither session had an advisor
         *  influence it), so the statistics this field feeds are unharmed;
         *  the warning is still retained verbatim in stderr_tail for the
         *  operational question. */
        advisor: AdvisorRecord | null;
      } | null;
    }
  // issue #127: Node's spawn() itself failing (ENOENT/EACCES/PATH misconfig —
  // the child never comes into being, only an "error" event fires, never
  // "exit") — a different failure class from worker_exited, not a variant of
  // it. worker_exited(exit_code: null, signal: null) was considered and
  // rejected: CONTEXT.md's Worker session is "one run from spawn to exit",
  // and a process that never spawned never had a session — reusing
  // worker_exited would fabricate the fact of an exit that did not happen.
  // Node's real exits always carry a non-null code or signal, so (null, null)
  // is otherwise an impossible pair; smuggling meaning into an impossible
  // value makes the reader reverse-engineer what the pair "really" means.
  // stderr_tail also carries no evidence here (spawn failure writes nothing
  // to stderr), so the reuse would have bought nothing but a false pair.
  //
  // No `usage` field (unlike worker_exited): making it nullable would read as
  // "usage unknown" and collide with the null-usage case worker_exited
  // already has for a killed-but-real session — the field's *absence* is what
  // says "cost accounting does not apply here" rather than "cost was not
  // recorded".
  //
  // ADR 0025 point 6 contrast: the skill-enumeration failure path in
  // claude-worker.ts's start() deliberately writes no event at all — that
  // failure retreats before worker_spawned is written, so no pair is open and
  // there is nothing to close (silence is safe there). A spawn() failure is
  // the opposite shape: worker_spawned is already written by the time
  // "error" fires (launch() writes it synchronously right after spawn()
  // returns), so the pair is open — leaving it that way would make a failed
  // spawn indistinguishable in the event log from a session still running.
  // spawn_failed is what closes it.
  | { kind: "spawn_failed"; error_code: string | null; message: string };

export type EventKind = EventPayload["kind"];
export type EventOrigin = "webui" | "mcp" | "worker" | "board";

export interface EventRow {
  id: number;
  task_id: string;
  worker_id: string;
  origin: EventOrigin;
  kind: EventKind;
  payload: EventPayload;
  created_at: string;
}

/** The single typed write function: every state change is appended through
 *  here. Returns the event id so entries can be referenced (e.g. a decomposed
 *  child pointing at the decision it rests on). */
export function appendEvent(
  db: Db,
  event: {
    taskId: string;
    workerId: string;
    origin: EventOrigin;
    payload: EventPayload;
    at: Date;
  },
): number {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO events (task_id, worker_id, origin, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      event.taskId,
      event.workerId,
      event.origin,
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
 *  as `resolveExecutionWorkspace`, ADR 0009). Also carries every objection
 *  ever raised against the entry (ADR 0085) — the annotation is a fact of
 *  the entry, not a session's state, so bundled and still commit-pending
 *  objections both ride along. `session_id` is the sole fact the read model
 *  hands the caller for telling the two apart (against the current open
 *  session, if any); `at` and who raised it are deliberately left out
 *  (issue #371). */
export interface LogEntry extends EventRow {
  workspace: string | null;
  objections: { comment: string; session_id: number }[];
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
  // a second, flat query rather than N+1 per entry — grouped in JS below
  const objectionRows = db
    .prepare(
      `SELECT json_extract(payload, '$.entry_id') AS entry_id,
              json_extract(payload, '$.comment') AS comment,
              json_extract(payload, '$.session_id') AS session_id
         FROM events WHERE kind = 'objection_raised' ORDER BY id`,
    )
    .all() as Array<{ entry_id: number; comment: string; session_id: number }>;
  const objectionsByEntry = new Map<number, { comment: string; session_id: number }[]>();
  for (const o of objectionRows) {
    const list = objectionsByEntry.get(o.entry_id) ?? [];
    list.push({ comment: o.comment, session_id: o.session_id });
    objectionsByEntry.set(o.entry_id, list);
  }
  return rows.map((r) => ({
    ...r,
    payload: JSON.parse(r.payload) as EventPayload,
    objections: objectionsByEntry.get(r.id) ?? [],
  }));
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
