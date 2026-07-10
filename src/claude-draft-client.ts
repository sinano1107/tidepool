import { z } from "zod";
import { defaultExec, pinnedModelFlags, type ExecFn } from "./claude-worker.js";
import type { DraftClient, TaskDraft } from "./draft.js";
import type { RegistryCandidates } from "./registry.js";

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

/** Instructs the model to answer with JSON only, and — when a registry is
 *  configured (issue #25) — steers assignee/workspace toward known names so
 *  a drafted response is likely to pass registration unmodified. */
function buildPrompt(dump: string, candidates?: RegistryCandidates): string {
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
  return [instructions, candidateGuidance, `Brain dump:\n${dump}`].filter(Boolean).join("\n\n");
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

  async draftTask(dump: string): Promise<TaskDraft> {
    const prompt = buildPrompt(dump, this.candidates);
    const stdout = await this.exec("claude", [
      "-p",
      prompt,
      "--output-format",
      "json",
      // draftTask is a real generation task, not the trivial ping
      // checkUsage() deliberately downgrades to haiku for
      ...pinnedModelFlags("sonnet", "medium"),
      // no MCP tools are configured for this call — it's a single JSON
      // answer, not a working session, so more than one turn is a
      // malfunction to fail loud on, not something to allow for
      "--max-turns",
      "1",
    ]);
    const envelope: unknown = JSON.parse(stdout);
    const result = (envelope as { result?: unknown }).result;
    if (typeof result !== "string") {
      throw new Error("draft CLI response missing a string result field");
    }
    return taskDraftSchema.parse(extractJson(result)) as TaskDraft;
  }
}
