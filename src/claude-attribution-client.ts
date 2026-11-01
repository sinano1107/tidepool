import { z } from "zod";
import type { BoardCallAnswer, BoardCallSetting } from "./board-call-usage.js";
import { CAUSES } from "./cause.js";
import { runClaudeBoardCallJson } from "./claude-board-call-runner.js";
import type { ExecFn } from "./claude-worker.js";
import {
  ATTRIBUTION_INPUT_FIELDS,
  type AttributionClient,
  type AttributionInput,
  type AttributionJudgment,
  STOP_ATTRIBUTION_INPUT_FIELDS,
  type StopAttributionInput,
} from "./retrospective.js";

// mirrors AttributionJudgment: the model's reply is untrusted input, and only a
// value inside the shared vocabulary may land on the objected task as a judgment
const judgmentSchema = z.object({
  cause: z.enum(CAUSES),
  evidence: z.string().min(1),
  // prompt の JSON は model が null を書きうる —— 欠落と同じに読み、正しい判定を parse 失敗で落とさない
  wrong_memory_entries: z.array(z.number().int()).nullish().transform((v) => v ?? undefined),
});

/** The question the board asks when an objection is bundled (ADR 0115 決定2):
 *  the human has already objected and the objection stands; this call says
 *  whose shortfall the objection points at — so a matter of taste or a
 *  requirement that changed afterwards is never read as a worker failure. */
function buildPrompt(input: AttributionInput): string {
  const f = ATTRIBUTION_INPUT_FIELDS;
  return (
    "You are the attribution judge of a work-tracking board. A human reviewing a worker's " +
    "decision log objected to one entry and left steering comments on it. The objection itself " +
    "is final and not yours to re-litigate. Judge only what caused the objection — whose " +
    `shortfall it points at — from ${f.entry}, ${f.steering}, and decision_log. ${f.entry_id} ` +
    `${OBJECTION_FIELDS} ${f.written} ${f.decision_log} When skills_followed positions are null, the objected entry could not be ` +
    "placed among the session's tool calls: read the skills' order against the decision log yourself. When the input " +
    "carries rca_findings, an earlier judgment was uncertain and the task's root-cause reviews " +
    "have since settled: read them as " +
    `evidence. ${f.rca_findings} ${f.actor} ${f.human_stop}\n\n` +
    `Input:\n${JSON.stringify(input, null, 2)}`
  );
}

/** The question the board asks of a human stop (ADR 0310): the stop is the
 *  human's observation of a whole session, so the judge names no entry and
 *  weighs the reason as testimony against what the worker actually did. */
function buildStopPrompt(input: StopAttributionInput): string {
  const f = STOP_ATTRIBUTION_INPUT_FIELDS;
  return (
    `You are the attribution judge of a work-tracking board. A human stopped a running worker session; ${f.human_stop}. ` +
    "It is an observation, not a verdict: weigh it against what the worker actually did. " +
    `Judge whose shortfall the stop points at from that testimony and the rest of the input, including ${f.actions}. ` +
    "actions is null when the session's action sequence could not be read: judge from the rest. What the worker did that appears in actions but not in decision_log is " +
    "evidence — a worker that breaks a rule seldom logs it. A reason saying the work is no longer needed, or that what was wanted " +
    "changed, is requirement_change. When the input carries rca_findings, an earlier judgment of this stop was uncertain and the " +
    "root-cause reviews of the stop have since settled: read them as evidence. " +
    `${f.decision_log} ${f.rca_findings} ${STOP_FIELDS}\n\n` +
    `Input:\n${JSON.stringify(input, null, 2)}`
  );
}

/** The judgment fields both questions share: the cause vocabulary, evidence and wrong_memory_entries. `w` names what is judged —
 *  the objected entry's decision, or the stopped session's conduct; `f` is the input's own field descriptions (ADR 0324 決定1). */
const responseFields = (
  w: { reading: string; before: string; sound: string; cites: string },
  f: Pick<typeof ATTRIBUTION_INPUT_FIELDS, "memory_read" | "agent_definition" | "board_text" | "task" | "skills" | "skills_followed">,
) =>
  "Respond with ONLY a single JSON object (no markdown fences, no " +
  'prose) with these fields: "cause" (one of ' +
  `${CAUSES.join(" / ")} — capability is the worker's own judgment falling short of what the ` +
  "task asked; task_ambiguity and missing_information are the task's framing leaving room " +
  `for ${w.reading} or omitting a fact the worker needed; ` +
  // ADR 0320 決定3: cause を照らす「task が求めたこと」は入力の task(spawn で渡した user turn の逐語)
  `task is ${f.task}; judge ` +
  "capability, task_ambiguity and missing_information against it, and conduct the task asked for is not a shortfall; " +
  "task is null when the session's record could not be read: judge from the rest; environment is the worker's " +
  "surroundings — board tooling, network or sandbox trouble, or an upstream change — when the " +
  "worker's judgment was sound given what it had (working around or guessing past such trouble " +
  `instead of escalating is capability; following ${f.board_text} as written ` +
  "is environment, while misreading that text is capability); preference is the human's taste where the " +
  "worker's choice was equally valid; requirement_change is a requirement the human changed " +
  `or introduced after the fact; memory is when a memory entry the worker read before ${w.before}, and followed, ` +
  "was itself wrong — the shortfall is the memory entry's, not the worker's; agent_definition is when " +
  `${f.agent_definition} was itself wrong and ${w.sound} was sound against it; but when ` +
  "agent_definition.builtin is true the body is board code, and when agent_definition.authority.source is reviewer " +
  "or repair rather than profile, that Authority is board code: that is environment; " +
  "never answer agent_definition when agent_definition is null; workspace_document is when a document " +
  "placed in the task's workspace (AGENTS.md, a README) was itself wrong and the worker followed " +
  `it — name it only when ${w.cites} that document; ` +
  // ADR 0325 決定3: skill の持ち主は scope の欄で引く —— board_text と同じ型。名指しの門は置かない。
  // ADR 0340 決定3: 届いた文が skill の文面とは限らないことは欄の文が言い、規則は文面どおり / 読み違えのまま足さない
  `a followed skill row carries the text that reached the worker when it used the skill — ${f.skills_followed}, and ${f.skills}: ` +
  "following a skill in skills_followed as written is environment when its name is in skills.host and workspace_document when it is in " +
  "skills.workspace, while misreading the skill's text is capability; skills and skills_followed are null when the session's record " +
  "could not be read: judge from the rest; use uncertain when the evidence does " +
  'not decide it), "evidence" (string — the concrete observations your judgment rests on, in English), and "wrong_memory_entries" ' +
  `(only with cause memory: the ids of the wrong memory entries, named from ${f.memory_read}; never answer memory when memory_read is empty).`;
const OBJECTION_FIELDS = responseFields(
  { reading: "the objected reading", before: "the decision", sound: "the decision", cites: "the decision log cites" },
  ATTRIBUTION_INPUT_FIELDS,
);
const STOP_FIELDS = responseFields(
  {
    reading: "what the worker did",
    before: "the stop",
    sound: "the worker's conduct",
    cites: "the decision log or the action sequence shows the worker reading",
  },
  STOP_ATTRIBUTION_INPUT_FIELDS,
);

/** The real AttributionClient (issue #574): a headless one-shot `claude -p`
 *  call through the same runner as the draft and allocation clients; the
 *  model / effort come from the board's execution-setting table row the caller
 *  resolved for the Board call, so a table edit reaches the next commit. */
export class ClaudeAttributionClient implements AttributionClient {
  private readonly exec: ExecFn;

  constructor(options: { exec: ExecFn }) {
    this.exec = options.exec;
  }

  async judge(
    input: AttributionInput,
    setting: BoardCallSetting,
  ): Promise<BoardCallAnswer<AttributionJudgment>> {
    return runClaudeBoardCallJson(
      { exec: this.exec, label: "attribution", prompt: buildPrompt(input), setting, reasoning: true },
      judgmentSchema,
    );
  }

  async judgeStop(input: StopAttributionInput, setting: BoardCallSetting): Promise<BoardCallAnswer<AttributionJudgment>> {
    return runClaudeBoardCallJson(
      { exec: this.exec, label: "stop attribution", prompt: buildStopPrompt(input), setting, reasoning: true },
      judgmentSchema,
    );
  }
}
