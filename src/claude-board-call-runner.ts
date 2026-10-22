import { z } from "zod";
import { type BoardCallAnswer, type BoardCallSetting, type BoardCallUsage, BoardCallUsageError } from "./board-call-usage.js";
import {
  boardCallEnv,
  boardCallEnvWithoutThinking,
  type ExecFn,
  emptyToolSurfaceFlags,
  pinnedModelFlags,
} from "./claude-worker.js";
import {
  CliAuthError,
  execFailureEnvelope,
  isCapInterruptionEnvelope,
  isCliAuthFailureEnvelope,
  RowRefusalError,
  rowRefusalCause,
} from "./cli-auth.js";

/** 答えを取りに行く Board call の system prompt(ADR 0296 決定6)。用途に依らない1つの文面で、用途ごとの指示は
 *  user prompt が持つ。翻訳は ADR 0062 決定3 の自前の文面を `systemPrompt` で渡す。Codex の runner(#2417)も
 *  同じ文面を置換の鍵に書く。 */
const BOARD_CALL_SYSTEM_PROMPT = [
  "You answer a single one-shot question from the board.",
  "Do exactly what the user message instructs, and reply with only the JSON it asks for.",
  "No tools, no follow-up turns, no prose around the JSON.",
].join(" ");

/** 答えを取りに行く Board call の1ターンの姿勢。適合試験(ADR 0186 決定7)の Board call の形の1ターンも
 *  これから組む —— 手で写すと、ここに足したフラグを試験が測らない(ADR 0303 決定4)。 */
export const BOARD_CALL_ONE_TURN_FLAGS = [
  // with no tools at all a second turn is structurally impossible; the
  // flag stays as the explicit statement that a single answer is what
  // this call is for, so a CLI that ever raises another turn fails loud
  "--max-turns",
  "1",
  // this call runs with the board's own cwd, not a task workspace —
  // --safe-mode keeps the board repo's own CLAUDE.md/skills/MCP config,
  // hooks and plugins from leaking into what must stay a bare answer.
  // Auth/model/tools/permissions are unaffected (unlike --bare, which
  // would force API-key-only auth). It does **not** keep an advisor out
  // — measured, issue #174 — which is what the runner's env is for.
  "--safe-mode",
  // --safe-mode still reads `language` from the user and project tiers (measured
  // on 2.1.286 / 2.1.308, #2454): no settings tier at all (ADR 0303 決定1)
  "--setting-sources",
  "",
] as const;

/** One Board call that goes to **fetch an answer** (#662): the draft uses, the three retrospective uses and
 *  display-time translation all run through here. */
export interface ClaudeBoardCall {
  exec: ExecFn;
  /** names the use in error messages */
  label: string;
  /** absent → `BOARD_CALL_SYSTEM_PROMPT` */
  systemPrompt?: string;
  prompt: string;
  /** the table row the call runs on, or translation's own setting; a row refusal names its provider / model (ADR 0202 決定1) */
  setting: BoardCallSetting;
  /** false → the env also closes the model's reasoning (ADR 0062 決定2) */
  reasoning: boolean;
}

// the CLI's `-p --output-format json` usage (vendor-specific, kept to the Claude adapter side — ADR 0005; the
// probes in claude-cli-auth.ts read it too): the same total_cost_usd/usage shape claude-worker.ts's stream-json result event carries
export const envelopeUsageSchema = z
  .object({
    total_cost_usd: z.number(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_input_tokens: z.number(),
      cache_creation_input_tokens: z.number(),
    }),
  })
  .transform(({ total_cost_usd, usage }): BoardCallUsage => ({
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_input_tokens,
    cache_creation_tokens: usage.cache_creation_input_tokens,
    estimated_cost_usd: total_cost_usd,
  }));

/** Safely extracts a JSON object from a CLI response (issue #25): the model
 *  is instructed to answer with bare JSON, but real-world output sometimes
 *  wraps it in a markdown fence or a sentence of prose around it — a strict
 *  JSON.parse alone would reject those instead of drafting. Falls back to
 *  parsing the trimmed text as-is when no braces are found, so a
 *  genuinely malformed response still throws (draftTask rejects → #12's 503
 *  fallback), not silently drafts garbage. The fence and the prose both sit
 *  outside the outermost braces, so the slice alone drops them — matching the
 *  fence itself broke on a ``` inside a JSON string (a translated code block,
 *  #2414). */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return JSON.parse(start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed);
}

/** envelope が行の拒否(ADR 0202 決定1)・401(ADR 0070)・上限到達による中断の 429(ADR 0104 決定2)の証拠なら
 *  投げる。非ゼロ終了の stdout もゼロ終了の stdout も通る1か所で、順は拒否が先。どれも usage があっても行を残さない
 *  (ADR 0299 決定3・追記)。 */
function throwIfTurnDidNotRun(envelope: unknown, { provider, model }: BoardCallSetting): void {
  const cause = rowRefusalCause(envelope);
  if (cause) throw new RowRefusalError(provider, model, cause);
  if (isCliAuthFailureEnvelope(envelope)) {
    const { result } = envelope as { result?: unknown };
    throw new CliAuthError(typeof result === "string" ? result : "Claude API returned 401");
  }
  if (isCapInterruptionEnvelope(envelope)) {
    const { result } = envelope as { result?: unknown };
    throw new Error(typeof result === "string" ? result : "Claude API returned 429");
  }
}

/** The answer as the model wrote it. */
async function runClaudeBoardCallText(call: ClaudeBoardCall): Promise<BoardCallAnswer<string>> {
  const { exec, label, systemPrompt = BOARD_CALL_SYSTEM_PROMPT, prompt, setting, reasoning } = call;
  let stdout: string;
  try {
    stdout = await exec(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--system-prompt",
        systemPrompt,
        ...pinnedModelFlags(setting.model, setting.effort),
        ...emptyToolSurfaceFlags(),
        ...BOARD_CALL_ONE_TURN_FLAGS,
      ],
      // a Board call: no advisor, spelled explicitly (ADR 0044). Without it the
      // host's own advisorModel rode along on every JIT draft poll and burned
      // opus, unrecorded anywhere — a haiku main model is no protection either
      // (measured 2026-08-04). Translation also closes reasoning (ADR 0062 決定2).
      reasoning ? boardCallEnv() : boardCallEnvWithoutThinking(),
    );
  } catch (err) {
    const failed = execFailureEnvelope(err);
    throwIfTurnDidNotRun(failed, setting);
    // the CLI exits non-zero on an `is_error` result (#652): one that reported usage still ran a turn and carries it
    const usage = envelopeUsageSchema.safeParse(failed).data;
    if (usage) throw new BoardCallUsageError((err as Error).message, setting, usage);
    throw err;
  }
  const envelope: unknown = JSON.parse(stdout);
  throwIfTurnDidNotRun(envelope, setting);
  const { is_error, result } = envelope as { is_error?: unknown; result?: unknown };
  const usage = envelopeUsageSchema.safeParse(envelope).data;
  // a failure the CLI reported usage for still ran a turn: the error carries it (ADR 0299 決定3)
  const fail = (message: string) => (usage ? new BoardCallUsageError(message, setting, usage) : new Error(message));
  if (is_error === true) throw fail(typeof result === "string" ? result : `${label} CLI reported an error`);
  if (typeof result !== "string") throw fail(`${label} CLI response missing a string result field`);
  // an answer without usage is a broken answer, not a degraded record (ADR 0299 決定4)
  if (!usage) throw new Error(`${label} CLI response missing usage`);
  return { output: result, usage, setting };
}

/** The answer as the JSON object `extractJson` finds in it, validated by `schema` — the model's reply is untrusted input. */
export async function runClaudeBoardCallJson<T>(call: ClaudeBoardCall, schema: z.ZodType<T>): Promise<BoardCallAnswer<T>> {
  const { output, usage, setting } = await runClaudeBoardCallText(call);
  try {
    return { output: schema.parse(extractJson(output)), usage, setting };
  } catch (err) {
    throw new BoardCallUsageError((err as Error).message, call.setting, usage);
  }
}
