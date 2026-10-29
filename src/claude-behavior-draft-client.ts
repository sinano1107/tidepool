import { z } from "zod";
import type { BoardCallAnswer, BoardCallSetting } from "./board-call-usage.js";
import { runClaudeBoardCallJson } from "./claude-board-call-runner.js";
import type { ExecFn } from "./claude-worker.js";
import { TIER_DEFINITION_RULE, TIER_QUALITY_FLOOR } from "./meta-review.js";
import {
  BEHAVIOR_DRAFT_INPUT_FIELDS,
  type BehaviorDraft,
  type BehaviorDraftClient,
  type BehaviorDraftInput,
  STOP_BEHAVIOR_DRAFT_INPUT_FIELDS,
  type StopBehaviorDraftInput,
} from "./retrospective.js";

// mirrors BehaviorDraft: the model's reply is untrusted input and lands in the memory store
const draftSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  text: z.string().min(1),
  addressee: z.enum(["worker", "all"]),
});

/** What the worker was given at its spawn and by the skills it invoked (ADR 0314 決定3・4 / ADR 0320 決定3 / ADR 0325 決定3) —— both
 *  drafts read the same fields. */
const spawnTextFields = (f: Pick<typeof BEHAVIOR_DRAFT_INPUT_FIELDS, "agent_definition" | "board_text" | "task" | "skills" | "skills_followed">) =>
  `${f.agent_definition} (null when not recorded), ${f.board_text}, task (${f.task}; null when not recorded), ` +
  `${f.skills_followed} and ${f.skills} (both null when not recorded)`;

/** The question the board asks once an objection's cause says an agent should
 *  learn from it (ADR 0120 決定1(b)(c)): word one standing rule a human can approve. */
function buildPrompt(input: BehaviorDraftInput): string {
  const f = BEHAVIOR_DRAFT_INPUT_FIELDS;
  return (
    "You draft agent memory for a work-tracking board. A human objected to one entry of a worker's " +
    "decision log and left steering comments; the objection's cause says an agent should behave " +
    "differently from now on. Draft ONE behavior rule — a standing instruction a human will approve " +
    `later — from ${f.entry}, ${f.steering}, ${f.memory_read}, ${spawnTextFields(f)}, and ` +
    `decision_log. ${f.entry_id} ${f.written} ${f.decision_log} When the input carries rca_findings, the ` +
    "task's root-cause reviews have settled: draft " +
    `from what they found. ${f.rca_findings} ${f.actor} ${responseFields("the worker who wrote the entry")} ` +
    `${f.human_stop}\n\n` +
    `Input:\n${JSON.stringify(input, null, 2)}`
  );
}

/** The question the board asks once a human stop's attribution says an agent should learn from it (ADR 0310 決定4):
 *  the same one rule, drafted from the human's testimony weighed against what the session did. */
function buildStopPrompt(input: StopBehaviorDraftInput): string {
  const f = STOP_BEHAVIOR_DRAFT_INPUT_FIELDS;
  return (
    `You draft agent memory for a work-tracking board. A human stopped a running worker session; ${f.human_stop}, ` +
    "and the stop's attribution says an agent should behave differently from now on. Draft ONE " +
    "behavior rule — a standing instruction a human will approve later — from that testimony weighed against what the worker " +
    `actually did: decision_log, ${f.memory_read}, ${spawnTextFields(f)}, and ${f.actions}; ` +
    "actions is null when the sequence could not be read. When the input " +
    "carries rca_findings, the root-cause reviews of the stop have settled: draft from what they found. " +
    `${f.decision_log} ${f.rca_findings} ${responseFields("the worker who ran the session")}\n\n` +
    `Input:\n${JSON.stringify(input, null, 2)}`
  );
}

/** The fields both questions share; `workerPhrase` says whose rule addressee "worker" means. */
const responseFields = (workerPhrase: string) =>
  "Respond with ONLY a single JSON object (no markdown fences, no prose) " +
  'with these fields: "path" (string — a "/"-separated hierarchy in English, such as build/tests; place it ' +
  "under an existing branch of the index when one fits), " +
  '"title" (string — a short name for the rule, in English), "text" (string — the rule itself, in English, ' +
  `stated so it stays true wherever it applies), and "addressee" ("worker" when the rule is for ${workerPhrase}, ` +
  '"all" when every agent should follow it). ' +
  `${TIER_QUALITY_FLOOR}. ${TIER_DEFINITION_RULE} ${BEHAVIOR_DRAFT_INPUT_FIELDS.index}`;

/** The real BehaviorDraftClient (issue #617): a headless one-shot `claude -p`
 *  call through the same runner as the attribution client; model / effort come
 *  from the execution-setting table row the caller resolved for the Board call. */
export class ClaudeBehaviorDraftClient implements BehaviorDraftClient {
  private readonly exec: ExecFn;

  constructor(options: { exec: ExecFn }) {
    this.exec = options.exec;
  }

  async draft(input: BehaviorDraftInput, setting: BoardCallSetting): Promise<BoardCallAnswer<BehaviorDraft>> {
    return runClaudeBoardCallJson(
      { exec: this.exec, label: "behavior draft", prompt: buildPrompt(input), setting, reasoning: true },
      draftSchema,
    );
  }

  async draftFromStop(input: StopBehaviorDraftInput, setting: BoardCallSetting): Promise<BoardCallAnswer<BehaviorDraft>> {
    return runClaudeBoardCallJson(
      { exec: this.exec, label: "stop behavior draft", prompt: buildStopPrompt(input), setting, reasoning: true },
      draftSchema,
    );
  }
}
