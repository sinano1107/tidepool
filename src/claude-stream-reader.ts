/** Claude の stream-json から `worker_exited` の stream 由来の欄を作る1つの読み手(ADR 0316 決定1)。
 *  live の adapter は pipe から1行ずつ、起動時の復旧は記録済みの transcript から同じ行を食わせる。
 *  純粋: DB もファイルも触らず、帰結(quarantine・cap・行の拒否)は live の呼び手だけが撃つ(決定3)。 */

import { isCapInterruptionEnvelope, isCliAuthFailureEnvelope, rowRefusalCause } from "./cli-auth.js";
import { type AdvisorRecord, type EventPayload, type ModelSwap, type RowRefusalCause, swapsMain } from "./events.js";
import { ownEntry } from "./registry.js";
import {
  isRootAssistant,
  readAdvisorOutcomes,
  readInitModel,
  readModelSwap,
  readRootRefusal,
  readSubagentModel,
  readSubagentStart,
} from "./stream-json.js";

type WorkerExitedUsage = Extract<EventPayload, { kind: "worker_exited" }>["usage"];

/** The stream-json CLI's own final `result` event shape (vendor-specific,
 *  hence kept private to this reader — ADR 0005) — only the fields
 *  worker_exited needs. */
interface StreamResultEvent {
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    /** issue #33: present only on newer CLIs, and only ever describing the
     *  **final turn** (measured) — an earlier turn's `advisor_message` is gone
     *  by the time this line is written. The one place the CLI names the
     *  advisor's resolved model id. */
    iterations?: unknown;
  };
  /** Per-model breakdown, keyed by resolved model id — the only place the
   *  advisor's own token/cost slice can be read off. Optional because a result
   *  line without it must still yield usage rather than being discarded. */
  modelUsage?: unknown;
}

/** One entry of the result line's per-model breakdown, narrowed on read (the
 *  keys are vendor camelCase and only some are needed). */
interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

function isModelUsageEntry(value: unknown): value is ModelUsageEntry {
  if (typeof value !== "object" || value === null) return false;
  const { inputTokens, outputTokens, costUSD } = value as Record<string, unknown>;
  return (
    typeof inputTokens === "number" &&
    typeof outputTokens === "number" &&
    typeof costUSD === "number"
  );
}

/** One entry of the result line's per-model breakdown, narrowed for
 *  `worker_exited.usage.models` (ADR 0094 決定2). Composed on top of
 *  `isModelUsageEntry` rather than widening it: that predicate is shared with
 *  `advisorUsage`, whose contract (issue #307) stays exactly as it was. */
interface ModelUsageBreakdownEntry extends ModelUsageEntry {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

function isModelUsageBreakdownEntry(value: unknown): value is ModelUsageBreakdownEntry {
  if (!isModelUsageEntry(value)) return false;
  const { cacheReadInputTokens, cacheCreationInputTokens } = value as Partial<ModelUsageBreakdownEntry>;
  return typeof cacheReadInputTokens === "number" && typeof cacheCreationInputTokens === "number";
}

/** The advisor's resolved model id, from the only surface that names it: an
 *  `advisor_message` entry in the final turn's iterations (issue #33, measured
 *  2026-08-04). null when the session's last consultation happened in an
 *  earlier turn — the CLI keeps nothing about it.
 *
 *  There is deliberately no fallback. Subtracting the main model from
 *  `modelUsage`'s keys does not identify the advisor: the breakdown can also
 *  carry the CLI's internal helper model (measured — three keys for one
 *  consultation), so the remainder is not a single answer, and a rule that is
 *  right only when that helper happens not to have run would make the field's
 *  meaning depend on something the board cannot observe. */
function advisorModelFrom(result: StreamResultEvent): string | null {
  const { iterations } = result.usage;
  if (!Array.isArray(iterations)) return null;
  for (const entry of iterations) {
    if (typeof entry !== "object" || entry === null) continue;
    const { type, model } = entry as Record<string, unknown>;
    if (type === "advisor_message" && typeof model === "string") return model;
  }
  return null;
}

/** Fail-closed like the adapter's vendor-shape handling (claude-worker.ts:
 *  `checkUsage`'s try/catch, the quarantine-on-drift paths in `start()`): a
 *  `result` line whose `usage`/`total_cost_usd` don't match the expected
 *  shape is treated as no result at all, never cast through blind and left
 *  to throw later inside a stdout "data" handler. */
function isStreamResultEvent(value: unknown): value is StreamResultEvent {
  if (typeof value !== "object" || value === null) return false;
  const { total_cost_usd, usage } = value as Record<string, unknown>;
  if (typeof total_cost_usd !== "number") return false;
  if (typeof usage !== "object" || usage === null) return false;
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
    usage as Record<string, unknown>;
  return (
    typeof input_tokens === "number" &&
    typeof output_tokens === "number" &&
    typeof cache_read_input_tokens === "number" &&
    typeof cache_creation_input_tokens === "number"
  );
}

/** The decoded-line form. A line that isn't a `result`, or one whose shape
 *  doesn't match, simply isn't one — the last *accepted* result line already
 *  seen wins. `is_error: true` is not a usage self-report either (issue
 *  #534). */
export function readResultEvent(parsed: Record<string, unknown> | null): StreamResultEvent | null {
  if (parsed === null || parsed.type !== "result") return null;
  if (parsed.is_error === true) return null;
  return isStreamResultEvent(parsed) ? parsed : null;
}

/** ADR 0188: the failure the CLI reported on an `is_error` result line, verbatim — the
 *  API error's `result` (with its status when numeric), else the CLI-side `errors`.
 *  Display only, read separately so `readResultEvent` keeps dropping these lines (#534).
 *  The last `is_error` line is kept whole, so one without text leaves null, not an earlier line's text. */
function readErrorResult(parsed: Record<string, unknown> | null): Record<string, unknown> | null {
  return parsed?.type === "result" && parsed.is_error === true ? parsed : null;
}

/** root のモデルの応答の行 —— CLI が API の失敗に合成する `<synthetic>` の行と subagent の行は数えない。
 *  1行でもあればターンが走った(ADR 0331 決定2 の0ターンの否定)。 */
function isRootTurn(parsed: Record<string, unknown> | null): parsed is Record<string, unknown> {
  return isRootAssistant(parsed) && (parsed.message as { model?: unknown } | undefined)?.model !== "<synthetic>";
}

/** ADR 0189: root のモデルが書いた最後の空でない text。CLI が合成した `<synthetic>` の行(ADR 0188 の主語)と
 *  subagent の行は読まない。text の無い行は null —— 前の行の文を残す。 */
function readRootText(parsed: Record<string, unknown> | null): string | null {
  if (!isRootTurn(parsed)) return null;
  const message = parsed.message as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return null;
  const texts = message.content.filter(
    (block): block is { text: string } => block?.type === "text" && typeof block.text === "string" && block.text !== "",
  );
  return texts.at(-1)?.text ?? null;
}

function reportedError(line: Record<string, unknown> | null): string | null {
  if (line === null) return null;
  const { result, errors, api_error_status: status } = line;
  const text = (typeof result === "string" && result) || (Array.isArray(errors) ? errors.join("\n") : "");
  if (!text) return null;
  return typeof status === "number" ? `API error status ${status}: ${text}` : text;
}

function isCliAuthFailure(parsed: Record<string, unknown> | null): boolean {
  return parsed?.type === "result" && isCliAuthFailureEnvelope(parsed);
}

/** 上限到達による中断(ADR 0104 決定2)。`isCliAuthFailure` と同じ形 — 判定は
 *  `result` envelope の構造化フィールド一点であり、stream 中の `rate_limit_event`
 *  も本文の「session limit」も根拠にしない。 */
function isCapInterruption(parsed: Record<string, unknown> | null): boolean {
  return parsed?.type === "result" && isCapInterruptionEnvelope(parsed);
}

/** 行の拒否(ADR 0184 決定3・ADR 0187 決定1)の証拠の種類。`isCapInterruption` と同じく result 行だけを
 *  読む —— 2.1.261〜2.1.284 はこの code を assistant 行にだけ載せる(#1267)。 */
function rowRefusalOf(parsed: Record<string, unknown> | null): RowRefusalCause | null {
  return parsed?.type === "result" ? rowRefusalCause(parsed) : null;
}

/** What the stdout scan collected while the stream ran (ADR 0316 決定1: the
 *  one reader, fed live from the pipe or after the fact from the transcript).
 *  Besides the last result line and the facts the live caller acts on, the
 *  session's advisor (issue #33), its model swaps and refusals (ADR 0215) and
 *  its subagents' models (issue #2432). These last are needed at exit and none
 *  survives on the result line: the consultations, failed calls and refusals
 *  happen in assistant lines, the swaps, subagent launches and the main model's
 *  resolved id on system lines, the subagents' resolved models on tool_result
 *  lines. */
interface StreamObservation {
  /** issue #32: the latest accepted `result` line, for usage/cost at exit. */
  lastResult: StreamResultEvent | null;
  /** ADR 0097 / ADR 0104 / ADR 0184: observations only — the live caller fires
   *  their consequences (quarantine, cap, row refusal), recovery never does (ADR 0316 決定3). */
  cliAuthFailed: boolean;
  capInterrupted: boolean;
  refusalCause: RowRefusalCause | null;
  /** ADR 0331 決定2: root のモデルの応答を1つでも観測したか —— false のまま閉じた session が0ターン。 */
  turnRan: boolean;
  /** ADR 0188 / ADR 0189: display-only transcriptions. */
  lastErrorResult: Record<string, unknown> | null;
  lastMessage: string | null;
  /** Advisor calls whose result carried advice, seen on the parent thread (ADR 0214). */
  consultations: number;
  /** Failed advisor calls' `error_code`, verbatim and in order (ADR 0214). */
  failedCalls: (string | null)[];
  /** The init line's resolved main model, used only to decide whether the
   *  advisor's own usage is separable from it. */
  mainModel: string | null;
  /** ADR 0215: `worker_exited.model_swaps` as it will be written. */
  modelSwaps: ModelSwap[];
  /** ADR 0215: `worker_exited.refusals` keyed by `message.id` — one message splits into
   *  several assistant lines, one per block, so a refusal counts once per id. */
  refusals: Map<unknown, string | null>;
  /** issue #2432: the subagents seen on the stream, keyed by `tool_use_id`, with the resolved
   *  model observed for each — null while none has been. An unpairable id gets a key of its own. */
  subagents: Map<unknown, string | null>;
}

/** The advisor record of worker_exited (issue #33 判断6). Non-null only
 *  on positive evidence — at least one consultation or failed call actually
 *  observed on the stream (ADR 0214) — so "the board pinned an advisor" alone
 *  never produces a row that claims one was attached. */
function toAdvisorRecord(
  result: StreamResultEvent | null,
  observed: StreamObservation,
): AdvisorRecord | null {
  if (observed.consultations === 0 && observed.failedCalls.length === 0) return null;
  const model = result ? advisorModelFrom(result) : null;
  return {
    model,
    consultations: observed.consultations,
    usage: result ? advisorUsage(result, model, observed) : null,
    failed_calls: observed.failedCalls,
  };
}

/** The advisor's own token/cost slice, or null when it cannot be measured
 *  (see the field's own doc in events.ts). Five ways it is unmeasurable:
 *
 *  - the advisor's resolved id was never reported;
 *  - it resolved to the same model as the main one, which merges both into a
 *    single per-model entry, leaving no way to tell whose tokens are whose
 *    (measured);
 *  - **the main model's resolved id was never observed** — a session whose
 *    init line was missing or carried no `model`. Then separability itself is
 *    unknown: the two may well have resolved to the same id, in which case the
 *    per-model entry read below is the merged one and publishing it would
 *    report the session's combined usage as the advisor's. "Could not be
 *    measured" must not turn into a confident wrong number;
 *  - **the main model was swapped** mid-session (ADR 0215 決定4) — the init
 *    line's model is then not the one that ran, so the comparison above says
 *    nothing. A `local` swap leaves the session's model as it was;
 *  - **something else ran, or may have run, on the advisor's model** (issue
 *    #2432) — `modelUsage` sums per model id, so its tokens sit in the
 *    advisor's entry: a subagent resolved to the advisor's id, a subagent
 *    launch with no resolved model observed by exit (a nested one, or a
 *    renamed field), or a `local` swap to the advisor's id. Not subtracted
 *    (ADR 0094 決定2). */
function advisorUsage(
  result: StreamResultEvent,
  model: string | null,
  observed: StreamObservation,
): AdvisorRecord["usage"] {
  if (model === null || observed.mainModel === null || model === observed.mainModel) return null;
  if (observed.modelSwaps.some((swap) => swapsMain(swap) || swap.to === model)) return null;
  if ([...observed.subagents.values()].some((resolved) => resolved === null || resolved === model)) return null;
  const breakdown = result.modelUsage;
  if (typeof breakdown !== "object" || breakdown === null) return null;
  const entry = ownEntry(breakdown as Record<string, unknown>, model);
  if (!isModelUsageEntry(entry)) return null;
  return {
    input_tokens: entry.inputTokens,
    output_tokens: entry.outputTokens,
    estimated_cost_usd: entry.costUSD,
  };
}

type ModelBreakdown = NonNullable<WorkerExitedUsage>["models"];

/** ADR 0094 決定2: the result line's per-model breakdown carried into
 *  `worker_exited.usage.models` as observed, board vocabulary only — no
 *  attribution is inferred here (that is left to a reader pairing this with
 *  `worker_spawned.advisor`, per the field's own doc comment in events.ts).
 *
 *  Fail-closed and all-or-nothing, the same posture as `isStreamResultEvent`:
 *  `modelUsage` absent or not an object, or any single entry missing one of
 *  the five numeric fields, omits `models` entirely rather than publish a
 *  partial breakdown that would read as complete. */
function modelBreakdownFrom(result: StreamResultEvent): ModelBreakdown {
  const breakdown = result.modelUsage;
  if (typeof breakdown !== "object" || breakdown === null) return undefined;
  const models: NonNullable<ModelBreakdown> = {};
  for (const [modelId, entry] of Object.entries(breakdown as Record<string, unknown>)) {
    if (!isModelUsageBreakdownEntry(entry)) return undefined;
    models[modelId] = {
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      cache_read_tokens: entry.cacheReadInputTokens,
      cache_creation_tokens: entry.cacheCreationInputTokens,
      estimated_cost_usd: entry.costUSD,
    };
  }
  return models;
}

/** Translates the CLI's vendor-shaped result event into the board's own
 *  worker_exited usage vocabulary (ADR 0005 / issue #32): total_cost_usd
 *  becomes estimated_cost_usd, no CLI field names leak past this point.
 */
function toUsage(result: StreamResultEvent): WorkerExitedUsage {
  const models = modelBreakdownFrom(result);
  return {
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cache_read_tokens: result.usage.cache_read_input_tokens,
    cache_creation_tokens: result.usage.cache_creation_input_tokens,
    estimated_cost_usd: result.total_cost_usd,
    ...(models !== undefined ? { models } : {}),
  };
}

export const claudeStreamObservation = (): StreamObservation => ({
  lastResult: null,
  cliAuthFailed: false,
  capInterrupted: false,
  refusalCause: null,
  turnRan: false,
  lastErrorResult: null,
  lastMessage: null,
  consultations: 0,
  failedCalls: [],
  mainModel: null,
  modelSwaps: [],
  refusals: new Map(),
  subagents: new Map(),
});

/** 1行の観測はここ1か所(issue #1301)。行は呼び手が1度だけ decode して渡す(see parseStreamLine)。 */
export function observeClaudeLine(observed: StreamObservation, parsed: Record<string, unknown> | null): void {
  observed.lastResult = readResultEvent(parsed) ?? observed.lastResult;
  observed.cliAuthFailed ||= isCliAuthFailure(parsed);
  observed.capInterrupted ||= isCapInterruption(parsed);
  observed.refusalCause ??= rowRefusalOf(parsed);
  observed.turnRan ||= isRootTurn(parsed);
  observed.lastErrorResult = readErrorResult(parsed) ?? observed.lastErrorResult;
  observed.lastMessage = readRootText(parsed) ?? observed.lastMessage;
  for (const outcome of readAdvisorOutcomes(parsed)) {
    if (outcome === "consulted") observed.consultations++;
    else observed.failedCalls.push(outcome.failed);
  }
  observed.mainModel = readInitModel(parsed) ?? observed.mainModel;
  const swap = readModelSwap(parsed);
  if (swap) observed.modelSwaps.push(swap);
  const started = readSubagentStart(parsed);
  if (started) observed.subagents.set(started.id ?? {}, null);
  const resolved = readSubagentModel(parsed);
  if (resolved) observed.subagents.set(resolved.id ?? {}, resolved.model);
  const refusal = readRootRefusal(parsed);
  if (refusal && !observed.refusals.has(refusal.id)) observed.refusals.set(refusal.id, refusal.category);
}

/** 観測 → `worker_exited` の stream 由来の欄。live の settle と起動時の復旧が同じこれを呼ぶ(ADR 0316 決定1)。 */
export function claudeExitFields(
  observed: StreamObservation,
): Pick<Extract<EventPayload, { kind: "worker_exited" }>, "usage" | "reported_error" | "last_message" | "model_swaps" | "refusals" | "advisor"> {
  return {
    usage: observed.lastResult ? toUsage(observed.lastResult) : null,
    model_swaps: observed.modelSwaps,
    refusals: [...observed.refusals.values()],
    advisor: toAdvisorRecord(observed.lastResult, observed),
    reported_error: reportedError(observed.lastErrorResult),
    last_message: observed.lastMessage,
  };
}
