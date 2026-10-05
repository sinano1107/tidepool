import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { BOARD_WORKER_ID, DomainError } from "./tasks.js";

/** 盤面が返す MCP 応答1回の大きさの上限(ADR 0195 決定2)。text content に載るシリアライズ後の UTF-8 バイト数で測る。 */
export const RESPONSE_BUDGET_BYTES = 40_000;

type ItemId = string | number;

/** 読みの位置。最初の読みは verb と引数だけ、続き(next)はそれに読み口の位置を足す ——
 *  `at` は次に返す item の id、`field` / `offset` は1件で予算を超える item の欄の続き(UTF-8 のバイト位置)。 */
export interface ReadPosition<A = Record<string, unknown>> {
  verb: string;
  args: A;
  at?: ItemId;
  field?: string[];
  offset?: number;
}

const bytes = (text: string) => Buffer.byteLength(text);

/** `end` が文字の途中(UTF-8 の継続バイト)に当たっていたら、手前の文字境界へ戻す。 */
function charBoundary(buf: Buffer, end: number): number {
  while (end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
  return end;
}

const encodeNext = (position: ReadPosition) => Buffer.from(JSON.stringify(position)).toString("base64url");

/** 続きを読む。盤面は状態を持たず、続きが verb・最初の引数・位置を自己記述する(ADR 0195 決定6)。 */
export function readNext<A = Record<string, unknown>>(verb: string, next: string): ReadPosition<A> {
  let position: unknown;
  try {
    position = JSON.parse(Buffer.from(next, "base64url").toString());
  } catch {
    position = undefined;
  }
  const p = position as Partial<ReadPosition> | undefined;
  if (typeof p?.verb !== "string" || typeof p.args !== "object" || p.args === null || !["string", "number"].includes(typeof p.at))
    throw new DomainError("next is malformed: pass the next string exactly as a previous response returned it");
  if (p.verb !== verb) throw new DomainError(`next belongs to ${p.verb}, not ${verb}: pass it to ${p.verb}`);
  return p as ReadPosition<A>;
}

/** item の列を、予算に収まるだけ丸ごと `key` に詰めた応答にする(ADR 0195 決定3)。
 *  `envelope`(item の列以外の欄)は最初の読みにだけ載る。残りがあるときだけ `next` と `remaining`(残りの件数)が付く ——
 *  付かなければ読みは完結している。封筒・`next`・`remaining` の分も予算に数える。 */
export function packItems<T extends { id: ItemId }>(
  read: ReadPosition,
  key: string,
  items: readonly T[],
  envelope: Record<string, unknown> = {},
): Record<string, unknown> {
  let start = 0;
  if (read.at !== undefined) {
    start = items.findIndex((item) => item.id === read.at);
    if (start === -1) throw new DomainError(`next points at item ${read.at}, which this read no longer has`);
  }
  const head = read.at === undefined ? envelope : {};
  const rest = items.slice(start);
  const nextAt = (k: number) =>
    k < rest.length ? { next: encodeNext({ verb: read.verb, args: read.args, at: rest[k]!.id }), remaining: rest.length - k } : {};
  if (read.field !== undefined) return piece(read, read.field, read.offset ?? 0, head, key, rest, nextAt);
  const whole = { ...head, [key]: rest };
  if (bytes(JSON.stringify(whole)) <= RESPONSE_BUDGET_BYTES) return whole;

  // 全部は入らない(最後の1件は残る): 先頭から item を足していき、続きの分まで含めて予算に収まる最後の位置で切る
  const tailBytes = (k: number) => bytes(JSON.stringify(nextAt(k))) - 1; // 先頭の `{` を `,` に読み替える
  let size = bytes(JSON.stringify({ ...head, [key]: [] }));
  let k = 0;
  while (k < rest.length - 1) {
    const grown = size + bytes(JSON.stringify(rest[k])) + (k > 0 ? 1 : 0);
    if (grown + tailBytes(k + 1) > RESPONSE_BUDGET_BYTES) break;
    size = grown;
    k++;
  }
  if (k === 0) return piece(read, longestStringField(rest[0]), 0, head, key, rest, nextAt);
  return { ...head, [key]: rest.slice(0, k), ...nextAt(k) };
}

/** 1件で予算を超える item の、`field` の `offset` バイト目からの1切れを単独で返す(ADR 0195 決定4)。
 *  切れの item は他の欄を全部持ち、`partial` が部分であることと欄の名前・全体のバイト数を示す。欄を切り終えたら次の item へ進む。
 *  ponytail: 切るのは1欄だけ —— その欄を空にしても予算を超える item(長い欄が2つある等)は出口の床に落ちる。観測されたら欄を順に切る */
function piece(
  read: ReadPosition,
  field: string[],
  offset: number,
  head: Record<string, unknown>,
  key: string,
  rest: readonly { id: ItemId }[],
  nextAt: (k: number) => Record<string, unknown>,
): Record<string, unknown> {
  const item = rest[0]!;
  const value = field.reduce<any>((node, name) => node?.[name], item);
  if (typeof value !== "string") throw new DomainError("next is malformed: pass the next string exactly as a previous response returned it");
  const text = Buffer.from(value);
  const pageUpTo = (end: number) => {
    const cut = structuredClone(item) as any;
    field.slice(0, -1).reduce((node, name) => node[name], cut)[field.at(-1)!] = text.subarray(offset, end).toString();
    return {
      ...head,
      [key]: [cut],
      partial: { id: item.id, field: field.join("."), field_bytes: text.length },
      ...(end < text.length ? { next: encodeNext({ ...read, at: item.id, field, offset: end }), remaining: rest.length } : nextAt(1)),
    };
  };
  const boundary = (end: number) => charBoundary(text, end);
  let [lo, hi] = [offset, text.length];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(JSON.stringify(pageUpTo(boundary(mid)))) <= RESPONSE_BUDGET_BYTES) lo = mid;
    else hi = mid - 1;
  }
  // 他の欄だけで予算を超えると1文字も入らない —— それでも1文字は進め、続きが同じ位置を指し続けないようにする(応答は床に落ちる)
  let end = boundary(lo);
  if (end === offset) for (end++; end < text.length && (text[end]! & 0xc0) === 0x80; ) end++;
  return pageUpTo(end);
}

/** item の中で UTF-8 バイト数が最も大きい文字列の欄の path。 */
function longestStringField(item: unknown): string[] {
  let best: { path: string[]; size: number } = { path: [], size: -1 };
  const walk = (node: unknown, path: string[]) => {
    if (typeof node === "string" && bytes(node) > best.size) best = { path, size: bytes(node) };
    else if (typeof node === "object" && node !== null) for (const [name, child] of Object.entries(node)) walk(child, [...path, name]);
  };
  walk(item, []);
  return best.path;
}

type ToolResponse = { isError?: boolean; content: { type: string; text?: string }[] };

/** 出口の床(ADR 0195 決定5): 成功の応答が予算を超えていたら、本文を予算まで切って英語の目印を付け、盤面スコープの event を
 *  1件書く。読み口の欠陥の床であって続きの読み方ではない。error にはしない —— 書き込み verb なら書き込みは済んでいる。
 *  error の応答(`toolError`)と予算以下の応答はそのまま返す。
 *  ponytail: 測るのは先頭の text content だけ —— 盤面の応答は `toolResult` の1切れしか持たない */
export function floorResponse<R extends ToolResponse>(
  result: R,
  context: { db: Db; surface: "management" | "worker"; verb: string; taskId?: string | null; at: Date },
): R {
  const text = result.content[0]?.text;
  if (result.isError || text === undefined || bytes(text) <= RESPONSE_BUDGET_BYTES) return result;
  const { db, surface, verb, taskId, at } = context;
  const original = Buffer.from(text);
  const marker =
    `\n[tidepool: response cut to the ${RESPONSE_BUDGET_BYTES}-byte response budget by a board defect — ` +
    `${verb} returned ${original.length} bytes. The text above is incomplete.]`;
  appendEvent(db, {
    taskId: null,
    workerId: BOARD_WORKER_ID,
    origin: "board",
    at,
    payload: { kind: "response_truncated", surface, verb, bytes: original.length, budget: RESPONSE_BUDGET_BYTES, ...(taskId ? { task_id: taskId } : {}) },
  });
  const kept = original.subarray(0, charBoundary(original, RESPONSE_BUDGET_BYTES - bytes(marker))).toString();
  return { ...result, content: [{ ...result.content[0], text: kept + marker }, ...result.content.slice(1)] };
}
