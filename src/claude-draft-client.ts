import { z } from "zod";
import { boardCallEnv, defaultExec, type ExecFn, pinnedModelFlags } from "./claude-worker.js";
import type { ChildDraftContext, DraftClient, HandoffDraft, IssueInspection, TaskDraft } from "./draft.js";
import type { Issue } from "./github.js";
import type { RegistryCandidates } from "./registry.js";
import { HANDOFF_FIELDS } from "./tasks.js";

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
    ? `Known assignees: ${candidates.assignees.join(", ")}. ` +
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

/** Safely extracts a JSON object from a CLI response (issue #25): the model
 *  is instructed to answer with bare JSON, but real-world output sometimes
 *  wraps it in a markdown fence or a sentence of prose around it — a strict
 *  JSON.parse alone would reject those instead of drafting. Falls back to
 *  parsing the trimmed text as-is when no fence/braces are found, so a
 *  genuinely malformed response still throws (draftTask rejects → #12's 503
 *  fallback), not silently drafts garbage. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1]! : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const jsonSlice = start !== -1 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(jsonSlice);
}

export interface ClaudeDraftClientOptions {
  /** Assignee/workspace candidates (issue #12's registryCandidates) to steer
   *  the drafted assignee/workspace toward known names. Absent → the model
   *  drafts those fields freely. */
  candidates?: RegistryCandidates;
  exec?: ExecFn;
}

/** The real DraftClient (issue #25): a headless one-shot `claude -p` call,
 *  same ExecFn process boundary ClaudeCodeWorker's checkUsage() uses. */
export class ClaudeDraftClient implements DraftClient {
  private readonly candidates?: RegistryCandidates;
  private readonly exec: ExecFn;

  constructor(options: ClaudeDraftClientOptions = {}) {
    this.candidates = options.candidates;
    this.exec = options.exec ?? defaultExec;
  }

  async draftTask(
    dump: string,
    language: string,
    context?: ChildDraftContext,
  ): Promise<TaskDraft> {
    const result = await this.runDraftPrompt(
      buildPrompt(dump, language, this.candidates, context),
    );
    return taskDraftSchema.parse(extractJson(result)) as TaskDraft;
  }

  async draftHandoff(dump: string, language: string): Promise<HandoffDraft> {
    const result = await this.runDraftPrompt(buildHandoffPrompt(dump, language));
    return handoffDraftSchema.parse(extractJson(result));
  }

  async inspectIssue(issue: Issue): Promise<IssueInspection> {
    const result = await this.runDraftPrompt(buildInspectionPrompt(issue));
    return issueInspectionSchema.parse(extractJson(result));
  }

  /** The one-shot `claude -p` call both draftTask and draftHandoff share —
   *  only the prompt differs between them. */
  private async runDraftPrompt(prompt: string): Promise<string> {
    const stdout = await this.exec(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        // a real generation task, not the trivial ping checkUsage()
        // deliberately downgrades to haiku for
        ...pinnedModelFlags("sonnet", "medium"),
        // an empty tool surface, declared (ADR 0062 決定1): this call goes to
        // fetch an answer, not to work, so it carries no tools — and the
        // declaration is what keeps their *definitions* off the system prompt.
        // `--allowedTools ""` would not do it: that narrows the permission
        // surface while the definitions ride along regardless (measured).
        "--tools",
        "",
        // with no tools at all a second turn is structurally impossible; the
        // flag stays as the explicit statement that a single answer is what
        // this call is for, so a CLI that ever raises another turn fails loud
        "--max-turns",
        "1",
        // this call runs with the board's own cwd, not a task workspace —
        // --safe-mode keeps the board repo's own CLAUDE.md/skills/MCP config
        // from leaking into what must stay a bare JSON answer. Auth/model/
        // tools/permissions are unaffected (unlike --bare, which would force
        // API-key-only auth). It does **not** keep an advisor out — measured,
        // issue #174 — which is what the env below is for.
        "--safe-mode",
      ],
      // a Board call: no advisor, spelled explicitly (ADR 0044). Without it the
      // host's own advisorModel rode along on every JIT draft poll and burned
      // opus, unrecorded anywhere.
      boardCallEnv(),
    );
    const envelope: unknown = JSON.parse(stdout);
    const result = (envelope as { result?: unknown }).result;
    if (typeof result !== "string") {
      throw new Error("draft CLI response missing a string result field");
    }
    return result;
  }
}
