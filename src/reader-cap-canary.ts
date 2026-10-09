/** 読み手の MCP 応答上限の canary(ADR 0195 決定7 / issue #1391)の判定側。I/O は scripts/reader-cap-canary.ts が持つ。 */
import { randomUUID } from "node:crypto";
import { RESPONSE_BUDGET_BYTES, responseBytes } from "./response-budget.js";
import { parseStreamLine } from "./stream-json.js";

/** canary の本文の中央と末尾に置く、呼び出しごとの乱数の目印。 */
export type Markers = { middle: string; tail: string };

/** 1行の JSON の本文。CallToolResult に包んだ大きさ(盤面の予算と同じ測り方、ADR 0195 追記1)が予算ちょうどになるように、
 *  小さい object の列を詰めて残りを `pad` で埋める —— 包み方が1段の読み手は合格し、それより多く包む読み手は欠ける。
 *  目印は呼び出しごとの乱数で、中央と末尾に1つずつ置く —— Codex は中央を切り詰めるので、末尾だけでは欠けを見逃す。 */
export function buildCanaryPayload(): Markers & { text: string } {
  const middle = `MIDDLE-${randomUUID()}`;
  const tail = `TAIL-${randomUUID()}`;
  const body = (rows: number, pad: string) => {
    // 埋め草は実際の応答(event の列)と同じく、引用符の多い小さい object
    const filler = Array(rows).fill({ kind: "decision_logged", line: "canary filler" });
    return JSON.stringify({ events: [...filler, { marker: middle }, ...filler], pad, tail });
  };
  const empty = responseBytes(body(0, ""));
  const rows = Math.floor((RESPONSE_BUDGET_BYTES - empty) / (responseBytes(body(1, "")) - empty));
  return { text: body(rows, "x".repeat(RESPONSE_BUDGET_BYTES - responseBytes(body(rows, "")))), middle, tail };
}

/** 一時 MCP の名前と、その1つの tool。 */
export const CANARY_SERVER = "canary";
export const CANARY_TOOL = "read_canary";

/** Codex の prompt で exec に逐語で走らせるコード。CallToolResult を1段包んだ形 —— 予算が覆う最悪の形 —— を出力させ、
 *  モデルの自然な包み方は観測しない(ADR 0195 の #1413 の追記)。 */
export const GIVEN_CODE = `const r = await tools.mcp__${CANARY_SERVER}__${CANARY_TOOL}({}); text(JSON.stringify(r));`;

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
 *  `code` はその call が exec ならモデルが書いたコードで、直接の MCP 呼び出しなら無い。
 *  ponytail: call は名前か入力に tool 名を含む最後の1回で選ぶ —— 呼んだあとに tool 名を含む別の exec を足されると
 *  そのコードは指定と一致せず観測なしに落ちる(取り違えて合否を出すことはない)。観測なしが続いたら対応を event から取る */
export function readCodexReceived(rollout: string): { received: string | null; code?: string } {
  const items = rollout.split("\n").flatMap((line) => {
    const parsed = parseStreamLine(line);
    return parsed?.type === "response_item" ? [parsed.payload as { type?: string; call_id?: string; name?: string; arguments?: string; input?: string; output?: unknown }] : [];
  });
  const call = items
    .filter((item) => (item.type === "function_call" || item.type === "custom_tool_call") && [item.name, item.arguments, item.input].some((text) => text?.includes(CANARY_TOOL)))
    .at(-1);
  const output = items.find((item) => (item.type === "function_call_output" || item.type === "custom_tool_call_output") && item.call_id === call?.call_id);
  return { received: output === undefined ? null : textOf(output.output), code: call?.input };
}

/** 読み手のモデルが実際に受け取った本文に、記録した目印が逐語で揃っているか。中央か末尾のどちらかが欠けたら不合格。
 *  上限の観測にならなかった回は観測なし(ADR 0195 の #1413 の追記)。
 *  `calls` は一時 MCP が呼び出しごとに記録した目印で、2回呼ばれたら最後の受け取りを最後の目印と突き合わせる。
 *  `failure` は読み手の CLI が失敗したときの stderr と要旨、`code` は Codex が canary を呼んだ exec のコード
 *  (直接の MCP 呼び出しなら無く、一致を見ない)。 */
export function judgeReceived(
  received: string | null,
  calls: Markers[],
  { failure, code }: { failure?: { stderr: string; summary: string }; code?: string } = {},
): { result: "合格" | "不合格" | "観測なし"; middle: boolean; tail: boolean; detail: string } {
  const unobserved = (detail: string) => ({ result: "観測なし" as const, middle: false, tail: false, detail });
  if (failure) return unobserved(failure.stderr.match(/^ERROR:.*$/m)?.[0] ?? failure.summary);
  const markers = calls.at(-1);
  if (markers === undefined) return unobserved("the reader never called the canary tool");
  if (code !== undefined && code.trim() !== GIVEN_CODE) return unobserved("the reader did not run the given code");
  if (received === null) return unobserved("no tool result found in the reader's record");
  const middle = received.includes(markers.middle);
  const tail = received.includes(markers.tail);
  const missing = [middle ? null : "middle", tail ? null : "tail"].filter(Boolean);
  const repeated = calls.length > 1 ? ` (called ${calls.length} times; last call judged)` : "";
  return {
    result: missing.length === 0 ? "合格" : "不合格",
    middle,
    tail,
    detail: `${Buffer.byteLength(received)} bytes received${missing.length ? `, ${missing.join(" and ")} marker missing` : ""}${repeated}`,
  };
}
