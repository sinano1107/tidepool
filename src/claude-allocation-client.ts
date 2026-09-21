import { z } from "zod";
import {
  ALLOCATIONS,
  type AllocationClient,
  type AllocationJudgment,
  type AllocationReviewInput,
} from "./allocation-review.js";
import { CAUSES } from "./cause.js";
import { runOneShotJsonPrompt } from "./claude-draft-client.js";
import type { ExecFn } from "./claude-worker.js";
import type { ExecutionSettingRow } from "./execution-setting.js";

// mirrors AllocationJudgment: the model's reply is untrusted input, and only a
// value inside the shared vocabulary may land on the episode as a judgment
const judgmentSchema = z.object({
  allocation: z.enum(ALLOCATIONS),
  cause: z.enum(CAUSES),
  evidence: z.string().min(1),
});

/** The question the board asks after quality is fixed (ADR 0111 決定4): the
 *  review has already said whether the deliverable is acceptable; this call
 *  says whether the compute spent on it was the right amount, and why a miss
 *  happened — so an environment failure is never read as a weak model. */
function buildPrompt(input: AllocationReviewInput): string {
  return (
    "You are the allocation reviewer of a work-tracking board. A worker session ran a task under " +
    "a fixed execution setting (provider / model / effort / advisor), and a separate read-only " +
    "review has already judged the deliverable — its verdict and findings are final and not yours " +
    "to re-litigate. Judge only whether the execution setting was appropriate for this task's " +
    "outcome, and what caused any shortfall. Respond with ONLY a single JSON object (no markdown " +
    "fences, no prose) with these fields: " +
    `"allocation" (one of ${ALLOCATIONS.join(" / ")} — overpowered means a cheaper setting would ` +
    "very likely have produced the same accepted result), " +
    `"cause" (one of ${CAUSES.join(" / ")} — capability is the model itself falling short; ` +
    "task_ambiguity and missing_information are the task's own framing; environment is tooling, " +
    "network or sandbox trouble outside the worker; preference and requirement_change are the human's " +
    "taste or a requirement changed after the fact; use uncertain when the evidence does not " +
    'decide it), and "evidence" (string — the concrete observations your judgment rests on).\n\n' +
    `Input:\n${JSON.stringify(input, null, 2)}`
  );
}

export interface ClaudeAllocationClientOptions {
  exec: ExecFn;
}

/** The real AllocationClient (issue #547): a headless one-shot `claude -p`
 *  call through the same runner as ClaudeDraftClient — but the model / effort are not a
 *  constant here: they come from the board's execution-setting table row the
 *  caller resolved for the Board call, so a table edit reaches the next call. */
export class ClaudeAllocationClient implements AllocationClient {
  private readonly exec: ExecFn;

  constructor(options: ClaudeAllocationClientOptions) {
    this.exec = options.exec;
  }

  async judge(
    input: AllocationReviewInput,
    setting: Pick<ExecutionSettingRow, "model" | "effort">,
  ): Promise<AllocationJudgment> {
    return judgmentSchema.parse(
      await runOneShotJsonPrompt(
        this.exec,
        buildPrompt(input),
        setting.model,
        setting.effort,
        "allocation review",
      ),
    );
  }
}
