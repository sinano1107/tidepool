import { z } from "zod";
import type { AttributionClient, AttributionInput, AttributionJudgment } from "./attribution.js";
import { CAUSES } from "./cause.js";
import { runOneShotJsonPrompt } from "./claude-draft-client.js";
import { defaultExec, type ExecFn } from "./claude-worker.js";
import type { ExecutionSettingRow } from "./execution-setting.js";

// mirrors AttributionJudgment: the model's reply is untrusted input, and only a
// value inside the shared vocabulary may land on the objected task as a judgment
const judgmentSchema = z.object({
  cause: z.enum(CAUSES),
  evidence: z.string().min(1),
});

/** The question the board asks when an objection is bundled (ADR 0115 決定2):
 *  the human has already objected and the objection stands; this call says
 *  whose shortfall the objection points at — so a matter of taste or a
 *  requirement that changed afterwards is never read as a worker failure. */
function buildPrompt(input: AttributionInput): string {
  return (
    "You are the attribution judge of a work-tracking board. A human reviewing a worker's " +
    "decision log objected to one entry and left steering comments on it. The objection itself " +
    "is final and not yours to re-litigate. Judge only what caused the objection — whose " +
    "shortfall it points at — from the objected entry, the steering, and the task's decision log " +
    "as it stood at the time. Respond with ONLY a single JSON object (no markdown fences, no " +
    'prose) with these fields: "cause" (one of ' +
    `${CAUSES.join(" / ")} — capability is the worker's own judgment falling short of what the ` +
    "task asked; task_ambiguity and missing_information are the task's framing leaving room " +
    "for the objected reading or omitting a fact the worker needed; environment is tooling, " +
    "network or sandbox trouble outside the worker; preference is the human's taste where the " +
    "worker's choice was equally valid; requirement_change is a requirement the human changed " +
    "or introduced after the fact; use uncertain when the evidence does not decide it), and " +
    '"evidence" (string — the concrete observations your judgment rests on). When the input ' +
    "carries rca_findings, an earlier judgment was uncertain and the task's root-cause reviews " +
    "have since settled: those are their decision logs and completion reports, read them as " +
    "evidence.\n\n" +
    `Input:\n${JSON.stringify(input, null, 2)}`
  );
}

/** The real AttributionClient (issue #574): a headless one-shot `claude -p`
 *  call through the same runner as the draft and allocation clients; the
 *  model / effort come from the board's execution-setting table row the caller
 *  resolved for the Board call, so a table edit reaches the next commit. */
export class ClaudeAttributionClient implements AttributionClient {
  private readonly exec: ExecFn;

  constructor(options: { exec?: ExecFn } = {}) {
    this.exec = options.exec ?? defaultExec;
  }

  async judge(
    input: AttributionInput,
    setting: Pick<ExecutionSettingRow, "model" | "effort">,
  ): Promise<AttributionJudgment> {
    return judgmentSchema.parse(
      await runOneShotJsonPrompt(this.exec, buildPrompt(input), setting.model, setting.effort, "attribution"),
    );
  }
}
