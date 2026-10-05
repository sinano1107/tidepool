/** 読み手の MCP 応答上限の canary(ADR 0195 決定7 / issue #1391)の判定側。I/O は scripts/reader-cap-canary.ts が持つ。 */
import { randomUUID } from "node:crypto";
import { RESPONSE_BUDGET_BYTES } from "./response-budget.js";
import { parseStreamLine } from "./stream-json.js";

/** 盤面の予算ちょうどの1行の JSON。盤面と同じく text content のシリアライズ後の UTF-8 バイト数で測る。
 *  目印は呼び出しごとの乱数で、中央と末尾に1つずつ置く —— Codex は中央を切り詰めるので、末尾だけでは欠けを見逃す。 */
export type Markers = { middle: string; tail: string };

export function buildCanaryPayload(): Markers & { text: string } {
  const middle = `MIDDLE-${randomUUID()}`;
  const tail = `TAIL-${randomUUID()}`;
  const fill = RESPONSE_BUDGET_BYTES - Buffer.byteLength(JSON.stringify({ canary: middle + tail }));
  const half = Math.floor(fill / 2);
  const text = JSON.stringify({ canary: "x".repeat(half) + middle + "x".repeat(fill - half) + tail });
  return { text, middle, tail };
}

/** 一時 MCP の名前と、その1つの tool。 */
export const CANARY_SERVER = "canary";
export const CANARY_TOOL = "read_canary";

type Block = { type?: string; text?: string };
/** 文字列か `{type:"text", text}` の列で来る本文を1つの文字列にする。 */
const textOf = (content: unknown) =>
  typeof content === "string" ? content : Array.isArray(content) ? (content as Block[]).map((block) => block.text ?? "").join("") : null;

/** `claude -p --output-format stream-json --verbose` の stdout から、canary の tool_use に返った tool_result の本文 ——
 *  モデルが受け取ったもの —— を読む。`tool_use_result` 欄は読まない(読み手の上限が掛かる前の本文でありうる)。
 *  2回呼ばれたら最後の1回。 */
export function readClaudeReceived(stdout: string): string | null {
  const blocks = stdout.split("\n").flatMap((line) => {
    const content = (parseStreamLine(line)?.message as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) ? (content as Array<Block & { id?: string; name?: string; tool_use_id?: string; content?: unknown }>) : [];
  });
  const ids = new Set(blocks.filter((b) => b.type === "tool_use" && b.name === `mcp__${CANARY_SERVER}__${CANARY_TOOL}`).map((b) => b.id));
  const result = blocks.filter((b) => b.type === "tool_result" && ids.has(b.tool_use_id)).at(-1);
  return result === undefined ? null : textOf(result.content);
}

/** Codex の rollout から、canary を呼んだ call の出力 —— モデルが受け取ったもの —— を読む。直接の MCP 呼び出しなら
 *  `function_call_output`、code mode なら `exec` の `custom_tool_call_output` に載る(0.147.0 の gpt-5.6 系は後者)。
 *  `mcp_tool_call_end` の event と `codex exec --json` の `item.completed` は切り詰め前の本文なので読まない。
 *  ponytail: call は名前か入力に tool 名を含む最後の1回で選ぶ —— code mode の入力はモデルが書くコードなので、
 *  呼んだあとに tool 名を含む別の call を足されると取り違える。観測されたら呼び出しの対応を event から取る */
export function readCodexReceived(rollout: string): string | null {
  const items = rollout.split("\n").flatMap((line) => {
    const parsed = parseStreamLine(line);
    return parsed?.type === "response_item" ? [parsed.payload as { type?: string; call_id?: string; name?: string; arguments?: string; input?: string; output?: unknown }] : [];
  });
  const call = items
    .filter((item) => (item.type === "function_call" || item.type === "custom_tool_call") && [item.name, item.arguments, item.input].some((text) => text?.includes(CANARY_TOOL)))
    .at(-1);
  const output = items.find((item) => (item.type === "function_call_output" || item.type === "custom_tool_call_output") && item.call_id === call?.call_id);
  return output === undefined ? null : textOf(output.output);
}

/** 読み手のモデルが実際に受け取った本文に、記録した目印が逐語で揃っているか。中央か末尾のどちらかが欠けたら不合格。
 *  `calls` は一時 MCP が呼び出しごとに記録した目印で、2回呼ばれたら最後の受け取りを最後の目印と突き合わせる。 */
export function judgeReceived(
  received: string | null,
  calls: Markers[],
): { pass: boolean; middle: boolean; tail: boolean; detail: string } {
  const markers = calls.at(-1);
  if (markers === undefined) return { pass: false, middle: false, tail: false, detail: "the reader never called the canary tool" };
  if (received === null) return { pass: false, middle: false, tail: false, detail: "no tool result found in the reader's record" };
  const middle = received.includes(markers.middle);
  const tail = received.includes(markers.tail);
  const missing = [middle ? null : "middle", tail ? null : "tail"].filter(Boolean);
  const repeated = calls.length > 1 ? ` (called ${calls.length} times; last call judged)` : "";
  return {
    pass: missing.length === 0,
    middle,
    tail,
    detail: `${Buffer.byteLength(received)} bytes received${missing.length ? `, ${missing.join(" and ")} marker missing` : ""}${repeated}`,
  };
}
