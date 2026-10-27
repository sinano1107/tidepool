/** Codex の `exec --json`(JSONL)から `worker_exited` の stream 由来の欄を作る1つの読み手(ADR 0316 決定1)。
 *  live の adapter は pipe から1行ずつ、起動時の復旧は記録済みの transcript から同じ行を食わせる。
 *  純粋: DB もファイルも触らず、`turn.failed` の読み直し(ADR 0261)は live の呼び手だけが撃つ(決定3)。 */

import type { EventPayload, TokenUsage } from "./events.js";

/** `turn.completed.usage` のうち盤面が読む 4 欄。`cached_input_tokens` と `cache_write_input_tokens` は
 *  `input_tokens` の内数(codex-rs 0.147.0)。`reasoning_output_tokens` は読まない(#2423)。 */
interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
}

export function readCodexUsage(value: unknown): CodexUsage | null {
  if (!value || typeof value !== "object") return null;
  const event = value as { type?: unknown; usage?: Record<string, unknown> };
  const usage = event.type === "turn.completed" ? event.usage : undefined;
  return usage &&
    [usage.input_tokens, usage.cached_input_tokens, usage.cache_write_input_tokens, usage.output_tokens].every(Number.isFinite)
    ? usage as unknown as CodexUsage
    : null;
}

/** Codex の usage を盤面の語彙に写す唯一の入口(#2410)。欄が欠けるか引き算が負なら欠測(null) ——
 *  0 で埋めず、負を 0 に丸めない(#534)。入力 0 も欠測: codex は usage の報告を受け取らないと
 *  `Usage::default()`(全欄 0)を書く(#2426)。 */
export function codexTokenUsage(value: unknown): TokenUsage | null {
  const usage = readCodexUsage(value);
  if (!usage || usage.input_tokens === 0) return null;
  const input = usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens;
  return input < 0
    ? null
    : {
        input_tokens: input,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cached_input_tokens,
        cache_creation_tokens: usage.cache_write_input_tokens,
        estimated_cost_usd: null,
      };
}

/** ADR 0188: `turn.failed` の message を逐語で(入れ子の JSON は解かない)。`error` event は
 *  再試行のたびにも流れるので代用しない —— `turn.failed` が自分で代用している。 */
export function readTurnFailure(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const event = value as { type?: unknown; error?: { message?: unknown } };
  const message = event.type === "turn.failed" ? event.error?.message : undefined;
  return typeof message === "string" ? message : null;
}

/** ADR 0261 決定2: `turn.failed` の行か —— 行の有無だけを見て、文は読まない。 */
function isTurnFailure(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "turn.failed";
}

/** ADR 0189: worker の発話は `item.completed` の `agent_message`(空の text は前の発話を残す)。 */
function readAgentMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const item = (value as { type?: unknown; item?: { type?: unknown; text?: unknown } }).item;
  const completed = (value as { type?: unknown }).type === "item.completed" && item?.type === "agent_message";
  return completed && typeof item.text === "string" && item.text !== "" ? item.text : null;
}

/** JSONL の1行を読む。空行も壊れた行も null —— 逐語の transcript が残る証拠で、
 *  壊れた行は正規化した usage も認証の事実も運ばない。 */
export function parseJsonl(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

interface CodexStreamObservation {
  usage: TokenUsage | null;
  reportedError: string | null;
  lastMessage: string | null;
  /** ADR 0261 決定2: 読み直しの条件は `turn.failed` の行の有無だけ —— 文(reported_error)は読まない */
  turnFailed: boolean;
}

export const codexStreamObservation = (): CodexStreamObservation => ({ usage: null, reportedError: null, lastMessage: null, turnFailed: false });

export function observeCodexLine(observed: CodexStreamObservation, event: unknown): void {
  observed.usage = codexTokenUsage(event) ?? observed.usage;
  observed.reportedError = readTurnFailure(event) ?? observed.reportedError;
  observed.turnFailed ||= isTurnFailure(event);
  observed.lastMessage = readAgentMessage(event) ?? observed.lastMessage;
}

/** 観測 → `worker_exited` の stream 由来の欄。live の settle と起動時の復旧が同じこれを呼ぶ(ADR 0316 決定1)。
 *  Codex は advisor・差し替え・拒否を観測しないので空で正規化する。 */
export function codexExitFields(
  observed: CodexStreamObservation,
): Pick<Extract<EventPayload, { kind: "worker_exited" }>, "usage" | "reported_error" | "last_message"> {
  return {
    usage: observed.usage ? { ...observed.usage, advisor: null, model_swaps: [], refusals: [] } : null,
    reported_error: observed.reportedError,
    last_message: observed.lastMessage,
  };
}
