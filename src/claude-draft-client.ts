import { z } from "zod";
import type { BoardCallAnswer } from "./board-call-usage.js";
import { runClaudeBoardCallJson } from "./claude-board-call-runner.js";
import type { ExecFn } from "./claude-worker.js";
import type { Db } from "./db.js";
import type { ChildDraftContext, DraftClient, HandoffDraft, IssueInspection, TaskDraft } from "./draft.js";
import { boardDefaultTier } from "./execution-setting.js";
import type { Issue } from "./github.js";
import type { RegistryCandidates } from "./registry.js";
import { HANDOFF_FIELDS } from "./tasks.js";
import { boardCallRow } from "./throttle.js";
import { whyAssigneeCannotTake } from "./webui-rules.js";

// mirrors TaskDraft (src/draft.ts): the model's response is untrusted input,
// so every field is validated before it's allowed to reach the API layer
const taskDraftSchema = z.object({
  title: z.string().min(1),
  purpose: z.string().min(1),
  completion_criteria: z.string().min(1),
  assignee: z.string().optional(),
  workspace: z.string().optional(),
  risk_flag: z.boolean().optional(),
  review_flag: z.boolean().optional(),
});

// mirrors IssueInspection (src/draft.ts): the gate verdict is untrusted
// model output like every other response here — validated before the API
// layer turns it into a 201/422. A rejection without missing/
// suggested_comment is malformed output (the UI's approve flow hangs off
// both), so it rejects here → the gate's 503, same as any garbled response.
const issueInspectionSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    missing: z.string().min(1),
    suggested_comment: z.string().min(1),
  }),
]);

// mirrors HandoffDraft (src/draft.ts): every field optional — a human task's
// handoff doc is never enforced (issue #13), unlike taskDraftSchema's
// required trio above
const handoffDraftSchema = z.object(
  Object.fromEntries(HANDOFF_FIELDS.map((f) => [f, z.string().min(1).optional()])),
) as z.ZodType<HandoffDraft>;

/** The language-preservation instruction (issue #46 / ADR 0015): fragment-
 *  level preservation rather than "answer in the dump's language" — a dump
 *  that mixes prose in one language with English technical terms and quoted
 *  errors makes "the dump's language" ambiguous, and a blanket translate-
 *  everything instruction would wrongly translate quoted errors and
 *  verbatim completion criteria. Only the connective prose the model adds
 *  itself is steered toward the board's display language. */
function languageInstruction(language: string): string {
  return (
    "Preserve the language of the dump: keep each fragment in the language it was written in — " +
    "English technical terms, quoted error messages, and criteria stay exactly as given. Any " +
    `connective prose you add yourself, write in ${language}.`
  );
}

/** The child-decompose context section (issue #129 point 4): the parent's
 *  own content, its existing children's titles, and the human's own
 *  decompose reason if given — steers the draft toward a child that fits the
 *  split already under way instead of restating the parent or duplicating a
 *  sibling. Read-only, never stored. */
function buildChildContextSection(context: ChildDraftContext): string {
  const lines = [
    "This task is being registered as a CHILD of an existing parent task (a human decompose). " +
      "Context on the parent, for reference only — do not simply restate it:",
    `Parent title: ${context.parentTitle}`,
    `Parent purpose: ${context.parentPurpose}`,
    `Parent completion criteria: ${context.parentCompletionCriteria}`,
    context.siblingTitles.length > 0
      ? `Existing sibling children (avoid duplicating these): ${context.siblingTitles.join(", ")}`
      : "No sibling children exist yet.",
  ];
  if (context.decomposeReason?.trim()) {
    lines.push(`Reason given for this split: ${context.decomposeReason}`);
  }
  return lines.join("\n");
}

/** Instructs the model to answer with JSON only, and — when a registry is
 *  configured (issue #25) — steers assignee/workspace toward known names so
 *  a drafted response is likely to pass registration unmodified. */
function buildPrompt(
  dump: string,
  language: string,
  candidates?: RegistryCandidates,
  childContext?: ChildDraftContext,
): string {
  const instructions =
    "You are drafting a task registration from a free-text brain dump for a work-tracking board. " +
    "Respond with ONLY a single JSON object (no markdown fences, no prose) with these fields: " +
    "title, purpose, completion_criteria (all required strings), and optionally assignee, workspace " +
    "(strings), risk_flag, review_flag (booleans).";
  const candidateGuidance = candidates
    ? // 下書きは work のフォームを埋める(ADR 0235 決定2)
      `Known assignees: ${candidates.assignees.filter((name) => !whyAssigneeCannotTake(name, "work", candidates.builtIns.includes(name))).join(", ")}. ` +
      `Known workspaces: ${candidates.workspaces.join(", ")}. ` +
      "When suggesting assignee/workspace, only propose names from these lists."
    : "";
  return [
    instructions,
    candidateGuidance,
    childContext ? buildChildContextSection(childContext) : "",
    languageInstruction(language),
    `Brain dump:\n${dump}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Instructs the model to answer with a partial 6-field handoff doc from a
 *  free-text/voice dump (issue #13). Every field is optional — a human task's
 *  doc is never enforced, so a dump that only covers some fields drafts a
 *  partial answer rather than one padded with invented content. */
function buildHandoffPrompt(dump: string, language: string): string {
  return (
    "You are drafting a task-completion handoff doc from a free-text or voice-transcribed dump " +
    "for a work-tracking board. Respond with ONLY a single JSON object (no markdown fences, no " +
    `prose) with these OPTIONAL string fields, filling in only what the dump actually covers: ${HANDOFF_FIELDS.join(", ")}. ` +
    "Never invent content for a field the dump doesn't cover — omit it instead.\n\n" +
    `${languageInstruction(language)}\n\n` +
    `Dump:\n${dump}`
  );
}

/** The registration gate's question (issue #49 設計点4): can the board's
 *  three content fields be derived from this issue as it stands? "Issue"
 *  means the full thread — title + body + every comment (CONTEXT.md) — so a
 *  human's clarifying comment posted after an earlier rejection counts on
 *  the retry. A failing verdict must carry the drafted fix as an issue
 *  comment, because that's the only place a fix may land (ADR 0016: GitHub
 *  stays the sole source of truth). */
function buildInspectionPrompt(issue: Issue): string {
  return (
    "You are the registration gate of a work-tracking board, inspecting a GitHub issue a human " +
    "wants to register as an issue-backed task. The board derives three fields from the issue at " +
    "every use: title (from the issue title), purpose (from the issue body), and completion " +
    "criteria (the body and comments together must make it clear when the work is done). " +
    "Judge whether all three can be derived from the issue as it stands. Respond with ONLY a " +
    "single JSON object (no markdown fences, no prose) with these fields: " +
    '"ok" (boolean, required); when ok is false also include "missing" (string — what cannot be ' +
    'derived and why) and "suggested_comment" (string — a markdown comment that, once posted to ' +
    "the issue, would fill the gap).\n\n" +
    `Issue title:\n${issue.title}\n\n` +
    `Issue body:\n${issue.body}\n\n` +
    `Comments:\n${issue.comments.length > 0 ? issue.comments.join("\n---\n") : "(none)"}`
  );
}

export interface ClaudeDraftClientOptions {
  /** Assignee/workspace candidates (issue #12's registryCandidates) to steer
   *  the drafted assignee/workspace toward known names. Absent → the model
   *  drafts those fields freely. */
  candidates?: RegistryCandidates;
  /** the board whose execution-setting table and Anthropic window each call reads (ADR 0192) */
  db: Db;
  exec: ExecFn;
}

/** The real DraftClient (issue #25): a headless one-shot `claude -p` call,
 *  same ExecFn process boundary ClaudeCodeWorker's checkUsage() uses. */
export class ClaudeDraftClient implements DraftClient {
  private readonly candidates?: RegistryCandidates;
  private readonly db: Db;
  private readonly exec: ExecFn;

  constructor(options: ClaudeDraftClientOptions) {
    this.candidates = options.candidates;
    this.db = options.db;
    this.exec = options.exec;
  }

  async draftTask(
    dump: string,
    language: string,
    context?: ChildDraftContext,
  ): Promise<BoardCallAnswer<TaskDraft>> {
    return (await this.run(buildPrompt(dump, language, this.candidates, context), taskDraftSchema)) as BoardCallAnswer<TaskDraft>;
  }

  async draftHandoff(dump: string, language: string): Promise<BoardCallAnswer<HandoffDraft>> {
    return this.run(buildHandoffPrompt(dump, language), handoffDraftSchema);
  }

  async inspectIssue(issue: Issue): Promise<BoardCallAnswer<IssueInspection>> {
    return this.run(buildInspectionPrompt(issue), issueInspectionSchema);
  }

  // runs on the board default tier's cheapest runnable anthropic row whose window is open (ADR 0192 / ADR 0200 決定4 /
  // #1445): no such row fails with the reason, never falls back outside the table
  private async run<T>(prompt: string, schema: z.ZodType<T>): Promise<BoardCallAnswer<T>> {
    let row;
    try {
      row = boardCallRow(this.db, boardDefaultTier(this.db));
    } catch (err) {
      throw new Error(`draft not made: ${(err as Error).message}`);
    }
    return runClaudeBoardCallJson({ exec: this.exec, label: "draft", prompt, setting: row, reasoning: true }, schema);
  }
}
