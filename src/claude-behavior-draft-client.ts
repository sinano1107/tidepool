import { z } from "zod";
import type { BoardCallAnswer, BoardCallSetting } from "./board-call-usage.js";
import { runClaudeBoardCallJson } from "./claude-board-call-runner.js";
import type { ExecFn } from "./claude-worker.js";
import { TIER_DEFINITION_RULE } from "./meta-review.js";
import type { BehaviorDraft, BehaviorDraftClient, BehaviorDraftInput, StopBehaviorDraftInput } from "./retrospective.js";

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
    `from what they found. ${responseFields("the worker who wrote the entry")} ` +
    "When present, human_stop is the human's account of why they stopped the session; " +
    '\"work no longer needed\" is not a cause of the objection, and leave an unanswered reason unanswered.\n\n' +
    `Input:\n${JSON.stringify(input, null, 2)}`
  );
}

/** The question the board asks once a human stop's attribution says an agent should learn from it (ADR 0310 決定4):
 *  the same one rule, drafted from the human's testimony weighed against what the session did. */
function buildStopPrompt(input: StopBehaviorDraftInput): string {
  return (
    "You draft agent memory for a work-tracking board. A human stopped a running worker session; human_stop.reason is the " +
    "human's testimony of why, and the stop's attribution says an agent should behave differently from now on. Draft ONE " +
    "behavior rule — a standing instruction a human will approve later — from that testimony weighed against what the worker " +
    "actually did: the session's whole decision log (decision_log), the memory entries it read before the stop (memory_read), " +
    "its agent definition as it stood then (agent_definition), and its action sequence (actions). actions.calls lists the " +
    "session's tool calls in order (index, tool, the extracted argument, and whether it failed); actions.decisions places each " +
    "decision-log line at its position in that sequence; actions is null when the sequence could not be read. When the input " +
    "carries rca_findings, the root-cause reviews of the stop have settled: draft from what they found. " +
    `${responseFields("the worker who ran the session")}\n\n` +
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
  `${TIER_DEFINITION_RULE} The index is the ` +
  "workspace's memory branches with their definitions (null when the store is empty).";

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
