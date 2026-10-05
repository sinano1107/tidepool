import type { Db } from "./db.js";
import { appendEvent, type EventPayload } from "./events.js";
import { BOARD_WORKER_ID, DomainError } from "./tasks.js";

/** 盤面が返す MCP 応答1回の大きさの上限(ADR 0195 決定2)。text content に載るシリアライズ後の UTF-8 バイト数で測る。 */
const RESPONSE_BUDGET_BYTES = 40_000;

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

const MALFORMED_NEXT = "next is malformed: pass the next string exactly as a previous response returned it";

const encodeNext = (position: ReadPosition<unknown>) => Buffer.from(JSON.stringify(position)).toString("base64url");

/** 続きを読む。盤面は状態を持たず、続きが verb・最初の引数・位置を自己記述する(ADR 0195 決定6)。 */
export function readNext<A = Record<string, unknown>>(verb: string, next: string): ReadPosition<A> {
  let p: Partial<ReadPosition> | undefined;
  try {
    p = JSON.parse(Buffer.from(next, "base64url").toString());
  } catch {}
  const fieldIsWellFormed =
    p?.field === undefined || (Array.isArray(p.field) && p.field.every((name) => typeof name === "string") && Number.isInteger(p.offset) && p.offset! >= 0);
  if (typeof p?.verb !== "string" || typeof p.args !== "object" || p.args === null || !["string", "number"].includes(typeof p.at) || !fieldIsWellFormed)
    throw new DomainError(MALFORMED_NEXT);
  if (p.verb !== verb) throw new DomainError(`next belongs to ${p.verb}, not ${verb}: pass it to ${p.verb}`);
  return p as ReadPosition<A>;
}

/** 最初の呼び出しの引数か続き(next)から読みの位置を作る。続きは最初の引数を自分の中に持つので、他の引数と一緒には受けない。 */
export function readPosition<A extends object>(verb: string, input: A & { next?: string }): ReadPosition<A> {
  const { next, ...args } = input;
  if (next === undefined) return { verb, args: args as unknown as A };
  if (Object.values(args).some((value) => value !== undefined))
    throw new DomainError(`pass next alone: it carries the other arguments of the first ${verb} call`);
  return readNext<A>(verb, next);
}

/** 詰めた応答の形: 列の欄 `L` は毎回、封筒 `E` は最初の応答だけ、続きは残りがあるときだけ載る。 */
export type Packed<L, E = unknown> = L & Partial<E> & { next?: string; remaining?: number };

/** 読み口ごとの詰め方の違い。 */
interface PackOptions<T> {
  /** 続きの境目の鍵 —— 既定は `id`、id を持たない item(枝の行・文字列など)は item と列の位置から作る。 */
  keyOf?: (item: T, index: number) => ItemId;
  /** item を置く列(`key` に並べた点区切りの path のどれか)。既定は `key` の先頭。 */
  listOf?: (item: T, index: number) => string;
  /** 続きの応答にも毎回載る欄(封筒と違い最初の応答だけではない)。 */
  every?: Record<string, unknown>;
}

/** 予算と続きで読む口(管理MCP と Worker MCP)の description の続きの読み方(ADR 0195)。順序は各口が前に書く。 */
export const nextDescription = (verb: string, items: string, firstOnly?: string) =>
  `When the ${items} do not fit in one response, the response carries \`next\` and \`remaining\` (how many ${items} are not returned yet): ` +
  `call ${verb} again with only \`next\` to read the rest, and repeat until a response carries no \`next\` — then the list is complete.` +
  (firstOnly ? ` ${firstOnly} on the first response only.` : "") +
  " An item too large for one response comes alone in pieces marked `partial` (`id`, the item's id or the key `next` resumes from; `field`, " +
  "empty when the item is itself a string; and `field_bytes`, the field's full size in UTF-8 bytes): join that field across the pieces to get it verbatim.";

/** item の列を、予算に収まるだけ丸ごと `key` に詰めた応答にする(ADR 0195 決定3)。
 *  `envelope`(item の列以外の欄)は最初の読みにだけ載る。残りがあるときだけ `next` と `remaining`(残りの件数)が付く ——
 *  付かなければ読みは完結している。封筒・`next`・`remaining` の分も予算に数える。
 *  `key` を複数渡すと、item は `options.listOf` の列に分かれて載る(点区切りの path は封筒の中の欄にも置ける)。 */
export function packItems<T extends { id: ItemId }>(
  read: ReadPosition<unknown>,
  key: string | readonly string[],
  items: readonly T[],
  envelope?: object,
  options?: PackOptions<T>,
): Record<string, unknown>;
export function packItems<T>(
  read: ReadPosition<unknown>,
  key: string | readonly string[],
  items: readonly T[],
  envelope: object,
  options: PackOptions<T> & Required<Pick<PackOptions<T>, "keyOf">>,
): Record<string, unknown>;
export function packItems<T>(
  read: ReadPosition<unknown>,
  key: string | readonly string[],
  items: readonly T[],
  envelope: object = {},
  options: PackOptions<T> = {},
): Record<string, unknown> {
  const lists = [key].flat();
  const { keyOf = (item: T) => (item as { id: ItemId }).id, listOf = () => lists[0]!, every = {} } = options;
  let start = 0;
  if (read.at !== undefined) {
    start = items.findIndex((item, i) => keyOf(item, i) === read.at);
    if (start === -1) throw new DomainError(`next points at item ${read.at}, which this read no longer has`);
  }
  const firstOnly = read.at === undefined ? envelope : {};
  const head = { ...firstOnly, ...every };
  const rest = items.slice(start);
  const keyAt = (k: number) => keyOf(rest[k]!, start + k);
  const continueFrom = (k: number) =>
    k < rest.length ? { next: encodeNext({ verb: read.verb, args: read.args, at: keyAt(k) }), remaining: rest.length - k } : {};
  /** `base`(既定は `head`)に、`rest` の先頭から選んだ item(切れは `rest[0]` の代わり)をそれぞれの列に置いた応答(列は item が
   *  無くても空で載る)。列は位置で引く —— 切れは複製なので item そのものからは引けない。 */
  const render = (chosen: readonly T[], base: object = head) => {
    const out: Record<string, any> = { ...base };
    for (const list of lists) {
      const path = list.split(".");
      const parent = path.slice(0, -1).reduce((node, name) => (node[name] = { ...node[name] }), out);
      parent[path.at(-1)!] = chosen.filter((_, j) => listOf(rest[j]!, start + j) === list);
    }
    return out;
  };

  /** 1件で予算を超える先頭の item の、`field` の `offset` バイト目からの1切れを単独で返す(ADR 0195 決定4)。
   *  切れの item は他の欄を全部持ち、`partial` が部分であることと欄の名前・全体のバイト数を示す。欄を切り終えたら次の item へ進む。
   *  ponytail: 切るのは1欄だけ —— その欄を空にしても予算を超える item(長い欄が2つある等)は出口の床に落ちる。観測されたら欄を順に切る */
  const piece = (field: string[], offset: number) => {
    const item = rest[0]!;
    const value = field.reduce<any>((node, name) => node?.[name], item);
    if (typeof value !== "string") throw new DomainError(MALFORMED_NEXT);
    const text = Buffer.from(value);
    const pageUpTo = (end: number) => {
      // 欄の path が空なら item そのもの(文字列の item)を切る
      let cut: any = text.subarray(offset, end).toString();
      if (field.length > 0) {
        const slice = cut;
        cut = structuredClone(item);
        field.slice(0, -1).reduce((node, name) => node[name], cut)[field.at(-1)!] = slice;
      }
      return {
        ...render([cut]),
        partial: { id: keyAt(0), field: field.join("."), field_bytes: text.length },
        ...(end < text.length ? { next: encodeNext({ ...read, at: keyAt(0), field, offset: end }), remaining: rest.length } : continueFrom(1)),
      };
    };
    let [lo, hi] = [offset, text.length];
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (bytes(JSON.stringify(pageUpTo(charBoundary(text, mid)))) <= RESPONSE_BUDGET_BYTES) lo = mid;
      else hi = mid - 1;
    }
    // 他の欄だけで予算を超えると1文字も入らない —— 欄の残りを丸ごと返して床に任せ、続きが同じ位置を指し続けないようにする
    const end = charBoundary(text, lo);
    return pageUpTo(end > offset ? end : text.length);
  };
  if (read.field !== undefined) return piece(read.field, read.offset ?? 0);
  const whole = render(rest);
  if (bytes(JSON.stringify(whole)) <= RESPONSE_BUDGET_BYTES) return whole;

  // 全部は入らない(最後の1件は残る): 先頭から item を足していき、続きの分まで含めて予算に収まる最後の位置で切る
  const tailBytes = (k: number) => bytes(JSON.stringify(continueFrom(k))) - 1; // 先頭の `{` を `,` に読み替える
  let size = bytes(JSON.stringify(render([])));
  const filled = new Set<string>(); // 1件目の後ろにだけ `,` が要る
  let k = 0;
  while (k < rest.length - 1) {
    const list = listOf(rest[k]!, start + k);
    const grown = size + bytes(JSON.stringify(rest[k])) + (filled.has(list) ? 1 : 0);
    if (grown + tailBytes(k + 1) > RESPONSE_BUDGET_BYTES) break;
    size = grown;
    filled.add(list);
    k++;
  }
  if (k === 0) {
    // 先頭の item が封筒と一緒に入らないだけなら、封筒だけを返してその item は次の応答で丸ごと返す ——
    // 切るのは1件で予算を超える item だけ(ADR 0195 決定4)。その item は封筒と一緒に今切る(封筒だけの応答を挟まない)
    const fitsAlone = bytes(JSON.stringify({ ...render(rest.slice(0, 1), every), ...continueFrom(1) })) <= RESPONSE_BUDGET_BYTES;
    if (fitsAlone && Object.keys(firstOnly).length > 0) return { ...render([]), ...continueFrom(0) };
    return piece(longestStringField(rest[0]), 0);
  }
  return { ...render(rest.slice(0, k)), ...continueFrom(k) };
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

/** 応答を返す面(床の event の `surface`)。 */
export type ResponseSurface = Extract<EventPayload, { kind: "response_truncated" }>["surface"];

type ToolResponse = { isError?: boolean; content: { type: string; text?: string }[] };

/** 出口の床(ADR 0195 決定5): 成功の応答が予算を超えていたら、本文を予算まで切って英語の目印を付け、盤面スコープの event を
 *  1件書く。読み口の欠陥の床であって続きの読み方ではない。error にはしない —— 書き込み verb なら書き込みは済んでいる。
 *  error の応答(`toolError`)と予算以下の応答はそのまま返す。
 *  ponytail: 測るのは先頭の text content だけ —— 盤面の応答は `toolResult` の1切れしか持たない */
export function floorResponse<R extends ToolResponse>(
  result: R,
  context: { db: Db; surface: ResponseSurface; verb: string; taskId?: string | null; at: Date },
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
  return { ...result, content: [{ ...result.content[0], text: kept + marker }] };
}
