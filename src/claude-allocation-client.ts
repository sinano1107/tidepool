import { z } from "zod";
import {
  ALLOCATIONS,
  type AllocationClient,
  type AllocationJudgment,
  type AllocationReviewInput,
} from "./allocation-review.js";
import { CAUSES } from "./cause.js";
import { extractJson } from "./claude-draft-client.js";
import {
  boardCallEnv,
  defaultExec,
  type ExecFn,
  emptyToolSurfaceFlags,
  pinnedModelFlags,
} from "./claude-worker.js";
import { rethrowCliAuthExecFailure } from "./cli-auth.js";
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
    "network or sandbox trouble outside the worker; use uncertain when the evidence does not " +
    'decide it), and "evidence" (string — the concrete observations your judgment rests on).\n\n' +
    `Input:\n${JSON.stringify(input, null, 2)}`
  );
}

export interface ClaudeAllocationClientOptions {
  exec?: ExecFn;
}

/** The real AllocationClient (issue #547): a headless one-shot `claude -p`
 *  call, same shape as ClaudeDraftClient — but the model / effort are not a
 *  constant here: they come from the board's execution-setting table row the
 *  caller resolved for the Board call, so a table edit reaches the next call. */
export class ClaudeAllocationClient implements AllocationClient {
  private readonly exec: ExecFn;

  constructor(options: ClaudeAllocationClientOptions = {}) {
    this.exec = options.exec ?? defaultExec;
  }

  async judge(
    input: AllocationReviewInput,
    setting: Pick<ExecutionSettingRow, "model" | "effort">,
  ): Promise<AllocationJudgment> {
    let stdout: string;
    try {
      stdout = await this.exec(
        "claude",
        [
          "-p",
          buildPrompt(input),
          "--output-format",
          "json",
          ...pinnedModelFlags(setting.model, setting.effort),
          ...emptyToolSurfaceFlags(),
          // with no tools at all a second turn is structurally impossible; the
          // flag stays as the explicit statement that a single answer is what
          // this call is for, so a CLI that ever raises another turn fails loud
          "--max-turns",
          "1",
          // this call runs with the board's own cwd, not a task workspace —
          // --safe-mode keeps the board repo's own CLAUDE.md/skills/MCP config
          // out of what must stay a bare JSON answer (see ClaudeDraftClient)
          "--safe-mode",
        ],
        // a Board call: no advisor, spelled explicitly (ADR 0044)
        boardCallEnv(),
      );
    } catch (err) {
      rethrowCliAuthExecFailure(err);
    }
    const { is_error, result } = JSON.parse(stdout) as { is_error?: unknown; result?: unknown };
    if (typeof result !== "string") {
      throw new Error("allocation review CLI response missing a string result field");
    }
    if (is_error === true) throw new Error(result);
    return judgmentSchema.parse(extractJson(result));
  }
}
