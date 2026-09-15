import { z } from "zod";
import type { BehaviorDraft, BehaviorDraftClient, BehaviorDraftInput } from "./attribution.js";
import { runOneShotJsonPrompt } from "./claude-draft-client.js";
import { defaultExec, type ExecFn } from "./claude-worker.js";
import type { ExecutionSettingRow } from "./execution-setting.js";

// mirrors BehaviorDraft: the model's reply is untrusted input and lands in the memory store
const draftSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  text: z.string().min(1),
  addressee: z.enum(["worker", "all"]),
});

/** The question the board asks once an objection's cause says an agent should
 *  learn from it (ADR 0120 決定1(b)(c)): word one standing rule a human can approve. */
function buildPrompt(input: BehaviorDraftInput): string {
  return (
    "You draft agent memory for a work-tracking board. A human objected to one entry of a worker's " +
    "decision log and left steering comments; the objection's cause says an agent should behave " +
    "differently from now on. Draft ONE behavior rule — a standing instruction a human will approve " +
    "later — from the objected entry, the steering, and the task's decision log as it stood at the " +
    "time. When the input carries rca_findings, the task's root-cause reviews have settled: draft " +
    "from what they found. Respond with ONLY a single JSON object (no markdown fences, no prose) " +
    'with these fields: "path" (string — a "/"-separated hierarchy such as build/tests; place it ' +
    "under an existing branch of the index when one fits), " +
    '"title" (string — a short name for the rule), "text" (string — the rule itself, in English, ' +
    'stated so it stays true wherever it applies), and "addressee" ("worker" when the rule is for the ' +
    'worker who wrote the entry, "all" when every agent should follow it). The index is the ' +
    "workspace's memory branches with their definitions (null when the store is empty).\n\n" +
    `Input:\n${JSON.stringify(input, null, 2)}`
  );
}

/** The real BehaviorDraftClient (issue #617): a headless one-shot `claude -p`
 *  call through the same runner as the attribution client; model / effort come
 *  from the execution-setting table row the caller resolved for the Board call. */
export class ClaudeBehaviorDraftClient implements BehaviorDraftClient {
  private readonly exec: ExecFn;

  constructor(options: { exec?: ExecFn } = {}) {
    this.exec = options.exec ?? defaultExec;
  }

  async draft(input: BehaviorDraftInput, setting: Pick<ExecutionSettingRow, "model" | "effort">): Promise<BehaviorDraft> {
    return draftSchema.parse(
      await runOneShotJsonPrompt(this.exec, buildPrompt(input), setting.model, setting.effort, "behavior draft"),
    );
  }
}
