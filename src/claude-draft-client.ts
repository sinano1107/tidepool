import { z } from "zod";
import { defaultExec, type ExecFn } from "./claude-worker.js";
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
      // always explicit: the CLI remembers the host's last model/effort
      // choice, and a flip in some unrelated directory must not leak into
      // runs (ADR 0005) — draftTask is a real generation task, not the
      // trivial ping checkUsage() deliberately downgrades to haiku for
      "--model",
      "sonnet",
      "--effort",
      "medium",
      // no MCP tools are configured for this call — it's a single JSON
      // answer, not a working session, so more than one turn is a
      // malfunction to fail loud on, not something to allow for
      "--max-turns",
      "1",
    ]);
    const envelope = JSON.parse(stdout) as { result: string };
    return taskDraftSchema.parse(JSON.parse(envelope.result)) as TaskDraft;
  }
}
