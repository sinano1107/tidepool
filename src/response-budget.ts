import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, type EventPayload, listEventsOfKinds } from "./events.js";
import type { Unstored } from "./tasks.js";
import { BOARD_WORKER_ID } from "./worker-id.js";

/** 盤面が返す MCP 応答1回の大きさの上限(ADR 0195 決定2)。text content の本文ではなく、盤面が返す CallToolResult を丸ごと
 *  シリアライズした UTF-8 バイト数(`responseBytes`)で測る(ADR 0195 追記1)。 */
export const RESPONSE_BUDGET_BYTES = 40_000;

type ItemId = string | number;

/** 切る欄の path と、その欄の全体のバイト数と digest(ADR 0195 追記 #1399 の4)。 */
interface CutField {
  path: string[];
  bytes: number;
  digest: string;
}

/** 読みの位置。最初の読みは verb と引数だけ、続き(next)はそれに読み口の位置を足す ——
 *  `at` は次に返す item の id、`count` と `digest` はそれまでに返した件数とその鍵の列の digest(ADR 0195 追記 #1399 の1)、
 *  `cut` は予算を超える object の切る欄すべて(長い順)で、`reading` はそのうち今読んでいる欄の位置、`offset` はその欄の続きの
 *  UTF-8 のバイト位置(追記 #1393 の1・3)。封筒の切れの続きは item をまだ返していないので `at` を持たない(同2)。 */
export interface ReadPosition<A = Record<string, unknown>> {
  verb: string;
  args: A;
  at?: ItemId;
  count?: number;
  digest?: string;
  cut?: CutField[];
  reading?: number;
  offset?: number;
}

const bytes = (text: string) => Buffer.byteLength(text);

/** 本文 `text` を載せて盤面が返す CallToolResult(`toolResult` の形)を丸ごとシリアライズした UTF-8 バイト数 —— 予算が測る大きさ
 *  (ADR 0195 追記1)。JSON の文字列の escape は1文字ずつなので、本文の断片をつないだ大きさは断片ごとの増分の和になる。 */
export const responseBytes = (text: string) => bytes(JSON.stringify({ content: [{ type: "text", text }] }));
/** 本文に `fragment` を足したときに CallToolResult が増える分(escape 後のバイト数)。 */
const grownBy = (fragment: string) => responseBytes(fragment) - responseBytes("");

/** `end` が文字の途中(UTF-8 の継続バイト)に当たっていたら、手前の文字境界へ戻す。 */
function charBoundary(buf: Buffer, end: number): number {
  while (end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
  return end;
}

/** `buf` の `from` から先で、`fits` が成り立つ最も遠い文字境界。1文字も入らなければ `from`。 */
function fitEnd(buf: Buffer, from: number, fits: (end: number) => boolean): number {
  let [lo, hi] = [from, buf.length];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(charBoundary(buf, mid))) lo = mid;
    else hi = mid - 1;
  }
  return charBoundary(buf, lo);
}

const MALFORMED_NEXT = "next is malformed: pass the next string exactly as a previous response returned it";
/** 読む間に既読の範囲が変わった続きの error(ADR 0195 追記 #1399)。 */
const listChanged = (verb: string) => `the list changed since the first ${verb} call: call ${verb} again without next to read it from the start`;
const digestOf = (text: string) => createHash("sha256").update(text).digest("base64url");

const encodeNext = (position: ReadPosition<unknown>) => Buffer.from(JSON.stringify(position)).toString("base64url");

/** 続きを読む。盤面は状態を持たず、続きが verb・最初の引数・位置を自己記述する(ADR 0195 決定6)。 */
export function readNext<A = Record<string, unknown>>(verb: string, next: string): ReadPosition<A> {
  let p: Partial<ReadPosition> | undefined;
  try {
    p = JSON.parse(Buffer.from(next, "base64url").toString());
  } catch {}
  const isCount = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
  const cutIsWellFormed =
    p?.cut === undefined ||
    (Array.isArray(p.cut) &&
      p.cut.every((field) => Array.isArray(field?.path) && field.path.every((name) => typeof name === "string") && isCount(field.bytes) && typeof field.digest === "string") &&
      isCount(p.reading) &&
      p.reading! < p.cut.length &&
      isCount(p.offset));
  const rangeIsWellFormed = ["string", "number"].includes(typeof p?.at) && isCount(p?.count) && typeof p?.digest === "string";
  const isEnvelopePiece = p?.at === undefined && p?.cut !== undefined;
  if (typeof p?.verb !== "string" || typeof p.args !== "object" || p.args === null || !(rangeIsWellFormed || isEnvelopePiece) || !cutIsWellFormed)
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

/** 詰めた応答の形: 列の欄 `L` は毎回、封筒 `E` は最初の応答(封筒の切れなら切れごとに一部)だけ、続きは残りがあるときだけ載る。 */
export type Packed<L, E = unknown> = L & Partial<E> & { next?: string; remaining?: number };

/** 読み口ごとの詰め方の違い。 */
interface PackOptions<T> {
  /** 続きの境目の鍵 —— 既定は `id`、id を持たない item(枝の行・文字列など)は item ごとに変わらない識別子を渡す。
   *  列の位置で作ると、先頭の範囲の digest が変化を表さない(ADR 0195 追記 #1399)。 */
  keyOf?: (item: T, index: number) => ItemId;
  /** item を置く列(`key` に並べた点区切りの path のどれか)。既定は `key` の先頭。 */
  listOf?: (item: T, index: number) => string;
  /** 続きの応答にも毎回載る欄(封筒と違い最初の応答だけではない)。 */
  every?: Record<string, unknown>;
  /** 続きを先頭の範囲の digest で照らさず、`at` の鍵で引き直す。先頭に伸びる新しい順の履歴(`get_task` と `read_decision_log`)
   *  だけが使う —— 照らすと動いている task を読み終えられず、event は消えないので鍵は外れない(ADR 0195 追記 #1399 の3)。 */
  resumeByKey?: boolean;
}

/** 1欄を切っても収まらない object の切れの読み方(ADR 0195 追記 #1393 の1)。 */
const CUT_FIELDS_DESCRIPTION =
  " When cutting one field is not enough, the longest string fields are cut in turn: each piece carries one field's text, " +
  "and the other fields being cut come as empty strings named in `partial.emptied`.";

/** 予算と続きで読む口(管理MCP と Worker MCP)の description の続きの読み方(ADR 0195)。順序は各口が前に書く。
 *  `resumeByKey` は packItems の同名のオプションを使う口 —— 読み直せの error が出ない代わりに、読み始めた後の分が返らない。 */
export const nextDescription = (verb: string, items: string, firstOnly?: string, resumeByKey?: boolean) =>
  `When the ${items} do not fit in one response, the response carries \`next\` and \`remaining\` (how many ${items} are not returned yet): ` +
  `call ${verb} again with only \`next\` to read the rest, and repeat until a response carries no \`next\` — then the list is complete.` +
  (firstOnly ? ` ${firstOnly} on the first response only.` : "") +
  " An item too large for one response comes alone in pieces marked `partial` (`id`, the item's id or the key `next` resumes from; `field`, " +
  "empty when the item is itself a string; and `field_bytes`, the field's full size in UTF-8 bytes): join that field across the pieces to get it verbatim." +
  CUT_FIELDS_DESCRIPTION +
  (firstOnly
    ? ` When what comes on the first response only is itself too large, it comes first in pieces the same way, before any ${items}: ` +
      `those pieces' \`partial\` has no \`id\`, its \`field\` is the path from the response root, the lists are empty, and \`remaining\` counts all the ${items}.`
    : "") +
  (resumeByKey
    ? ` ${items[0]!.toUpperCase()}${items.slice(1)} added after the first call are not returned` +
      (firstOnly ? " (when what comes on the first response only is itself too large, those added after its last piece instead)" : "") +
      ": call again without `next` to see them."
    : ` If the list changes under the read, the call fails with "${listChanged(verb)}"; read again from the start.`);

/** item の列を、予算に収まるだけ丸ごと `key` に詰めた応答にする(ADR 0195 決定3)。
 *  `envelope`(item の列以外の欄)は最初の読みにだけ載る —— 予算を超える封筒は切れで返すので、呼び出し側は `at` の無い続き(封筒の
 *  切れの続き)にも同じ封筒を渡す。残りがあるときだけ `next` と `remaining`(残りの件数)が付く ——
 *  付かなければ読みは完結している。封筒・`next`・`remaining` の分も予算に数える。
 *  `key` を複数渡すと、item は `options.listOf` の列に分かれて載る(点区切りの path は封筒の中の欄にも置ける)。 */
export function packItems<T extends { id: ItemId }, E extends object>(
  read: ReadPosition<unknown>,
  key: string | readonly string[],
  items: readonly Unstored<T>[],
  envelope?: Unstored<E>,
  options?: PackOptions<T>,
): Record<string, unknown>;
export function packItems<T, E extends object>(
  read: ReadPosition<unknown>,
  key: string | readonly string[],
  items: readonly Unstored<T>[],
  envelope: Unstored<E>,
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
  const { keyOf = (item: T) => (item as { id: ItemId }).id, listOf = () => lists[0]!, every = {}, resumeByKey = false } = options;
  /** 列の先頭 `count` 件の鍵の digest。詰める間は件数を伸ばしながら何度も引くので、増分で求めて覚える。 */
  const prefixDigests: string[] = [];
  const keyHash = createHash("sha256");
  const prefixDigest = (count: number) => {
    for (let i = prefixDigests.length; i <= count; i++) {
      if (i > 0) keyHash.update(`${JSON.stringify(keyOf(items[i - 1]!, i - 1))}\n`);
      prefixDigests.push(keyHash.copy().digest("base64url"));
    }
    return prefixDigests[count]!;
  };
  let start = 0;
  if (read.at !== undefined) {
    // 先頭の範囲が返したものと同じなら、残りは今の列の位置 count から先と一致する —— 境目の item の離脱もそのまま続く
    const { count = 0, digest, cut, at } = read;
    const sameRange = () =>
      count <= items.length && prefixDigest(count) === digest && (cut === undefined || (count < items.length && keyOf(items[count]!, count) === at));
    start = resumeByKey ? items.findIndex((item, i) => keyOf(item, i) === at) : sameRange() ? count : -1;
    if (start === -1) throw new DomainError(listChanged(read.verb));
  }
  const firstOnly = read.at === undefined ? envelope : {};
  const head = { ...firstOnly, ...every };
  const rest = items.slice(start);
  const keyAt = (k: number) => keyOf(rest[k]!, start + k);
  const positionOf = (k: number) => ({ verb: read.verb, args: read.args, at: keyAt(k), count: start + k, digest: prefixDigest(start + k) });
  const continueFrom = (k: number) => (k < rest.length ? { next: encodeNext(positionOf(k)), remaining: rest.length - k } : {});
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

  /** 切る object: 封筒か先頭の item。 */
  const objectOf = (ofEnvelope: boolean): unknown => (ofEnvelope ? firstOnly : rest[0]);
  const fits = (response: object) => responseBytes(JSON.stringify(response)) <= RESPONSE_BUDGET_BYTES;

  /** 予算を超える object(先頭の item か封筒)の1切れ(ADR 0195 決定4・追記 #1393 の1・2): 切る欄 `cut` の `reading` 番目に断片
   *  `fragment` を載せ、ほかの切る欄を空にする。切れは切らない欄を全部持ち、`partial` が部分であることと欄の名前・全体の
   *  バイト数を示し、空にした切る欄を `emptied` で名指す。封筒の切れは item の列を空で載せ、`partial` に `id` を持たない(欄の
   *  path は応答の根から数える)。`after` は続きの位置で、無ければ切り終えて item(封筒なら先頭の、item なら次の)へ進む。 */
  const page = (ofEnvelope: boolean, cut: CutField[], reading: number, fragment: string, after?: { reading: number; offset: number }) => {
    // 欄の path が空なら item そのもの(文字列の item)を切る
    let cutObject: any = fragment;
    if (cut[reading]!.path.length > 0) {
      cutObject = structuredClone(objectOf(ofEnvelope));
      for (const [i, { path }] of cut.entries()) path.slice(0, -1).reduce((node, name) => node[name], cutObject)[path.at(-1)!] = i === reading ? fragment : "";
    }
    const emptied = cut.filter((_, i) => i !== reading).map(({ path }) => path.join("."));
    return {
      ...(ofEnvelope ? render([], { ...cutObject, ...every }) : render([cutObject])),
      partial: { ...(!ofEnvelope && { id: keyAt(0) }), field: cut[reading]!.path.join("."), field_bytes: cut[reading]!.bytes, ...(emptied.length > 0 && { emptied }) },
      ...(after
        ? { next: encodeNext({ ...(ofEnvelope ? { verb: read.verb, args: read.args } : positionOf(0)), cut, ...after }), remaining: rest.length }
        : continueFrom(ofEnvelope ? 0 : 1)),
    };
  };
  /** `cut` の `reading` 番目の欄の `offset` バイト目から、予算に収まるだけの1切れ。欄を読み終えたら次の切る欄へ進む。 */
  const piece = (ofEnvelope: boolean, cut: CutField[], reading: number, offset: number) => {
    const text = Buffer.from(valueAt(objectOf(ofEnvelope), cut[reading]!.path));
    const pageUpTo = (end: number) =>
      page(ofEnvelope, cut, reading, text.subarray(offset, end).toString(), end < text.length ? { reading, offset: end } : reading + 1 < cut.length ? { reading: reading + 1, offset: 0 } : undefined);
    // 1文字も入らないのは、1文字と続きの印を載せると予算を超える object(追記 #1393 の5)。切り始めでは切れないと判定する
    // (cutToFit)ので、ここに来るのは切り始めの後に切らない欄が伸びた続きか、読み手が作った続き —— 欄の残りを丸ごと返して
    // 床に任せ、続きが同じ位置を指し続けないようにする
    const end = fitEnd(text, offset, (to) => fits(pageUpTo(to)));
    return pageUpTo(end > offset ? end : text.length);
  };
  /** 予算を超える object の最初の切れ: 収まるまで長い順に文字列の欄を切る(ADR 0195 追記 #1393 の1)。収まるかは、断片に
   *  escape 後に最も広い1文字(制御文字は CallToolResult の中で7バイト)だけを載せてほかの切る欄を空にし、続きの位置を最も長く
   *  書いた切れで測る —— 切れは1文字以上を載せないと進めず、後ろの切れほど続きの offset の桁が伸びる。こうすると、切ると
   *  決めた object のどの切れも予算に収まる(ADR 0195 決定5 の不変条件、issue #1700)。文字列の欄が無いか、全部切っても
   *  1文字と続きの印の分で収まらなければ切れず、undefined を返す。短い欄ばかりの object は、欄を切るたびに続きの印が欄より
   *  大きく伸びるので、全部切っても収まらない。 */
  const cutToFit = (ofEnvelope: boolean) => {
    const fields = stringFields(objectOf(ofEnvelope));
    const fitsCutting = (count: number) => fits(page(ofEnvelope, fields.slice(0, count), 0, "\u0001", { reading: count - 1, offset: fields[0]!.bytes }));
    if (fields.length === 0 || !fitsCutting(fields.length)) return undefined;
    let count = 1;
    while (count < fields.length && !fitsCutting(count)) count++;
    return piece(ofEnvelope, fields.slice(0, count), 0, 0);
  };
  if (read.cut !== undefined) {
    // 封筒の切れの続きは `at` を持たない(追記 #1393 の2)
    const ofEnvelope = read.at === undefined;
    // 切る欄が切れの間に書き換わっていたら、つなぐと新旧の継ぎはぎになる(ADR 0195 追記 #1399 の4・追記 #1393 の3)。
    // 文字列でなくなったときも同じ —— 切り始めは文字列の欄だけを選ぶ
    const changed = read.cut.some(({ path, bytes: size, digest }) => {
      const value = valueAt(objectOf(ofEnvelope), path);
      return typeof value !== "string" || bytes(value) !== size || digestOf(value) !== digest;
    });
    if (changed) throw new DomainError(listChanged(read.verb));
    return piece(ofEnvelope, read.cut, read.reading!, read.offset!);
  }
  const whole = render(rest);
  if (fits(whole)) return whole;

  // 全部は入らない(最後の1件は残る): 先頭から item を足していき、続きの分まで含めて予算に収まる最後の位置で切る
  const tailBytes = (k: number) => grownBy(JSON.stringify(continueFrom(k))) - 1; // 先頭の `{` を `,` に読み替える
  let size = responseBytes(JSON.stringify(render([])));
  const filled = new Set<string>(); // 1件目の後ろにだけ `,` が要る
  let k = 0;
  while (k < rest.length - 1) {
    const list = listOf(rest[k]!, start + k);
    const grown = size + grownBy(JSON.stringify(rest[k])) + (filled.has(list) ? 1 : 0);
    if (grown + tailBytes(k + 1) > RESPONSE_BUDGET_BYTES) break;
    size = grown;
    filled.add(list);
    k++;
  }
  if (k === 0) {
    const envelopeOnly = { ...render([]), ...continueFrom(0) };
    // 封筒だけで予算を超えるなら、item より先に封筒を切る(ADR 0195 追記 #1393 の2)。文字列以外の中身だけで超える封筒は
    // 切れない(追記 #1393 の5)—— 丸ごと返して床に任せる
    if (!fits(envelopeOnly)) return cutToFit(true) ?? envelopeOnly;
    // 先頭の item が封筒と一緒に入らないだけなら、封筒だけを返してその item は次の応答で丸ごと返す ——
    // 切るのは、その item と続きの印を合わせて1応答を超える item だけ(ADR 0195 追記 #1393 の4)。その item は、封筒の横で
    // 切って収まるなら封筒と一緒に今切る(封筒だけの応答を挟まない)
    const hasEnvelope = Object.keys(firstOnly).length > 0;
    const fitsAlone = fits({ ...render(rest.slice(0, 1), every), ...continueFrom(1) });
    if (fitsAlone && hasEnvelope) return envelopeOnly;
    // 封筒の横では切っても収まらないなら、封筒だけを先に返し、item は続きで封筒なしに切る —— 丸ごと返すと床に落ち、
    // 続きの印も切れる(ADR 0195 決定5 の不変条件、issue #1668)。封筒なしでも切れない item(追記 #1393 の5)も、封筒を
    // 先に返したうえで、続きで丸ごと返して床に任せる
    return cutToFit(false) ?? (hasEnvelope ? envelopeOnly : { ...render(rest.slice(0, 1)), ...continueFrom(1) });
  }
  return { ...render(rest.slice(0, k)), ...continueFrom(k) };
}

const valueAt = (node: unknown, path: string[]) => path.reduce<any>((child, name) => child?.[name], node);

/** object の中の文字列の欄を UTF-8 バイト数の大きい順に。object そのものが文字列なら path は空。 */
function stringFields(object: unknown): CutField[] {
  const fields: CutField[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (typeof node === "string") fields.push({ path, bytes: bytes(node), digest: digestOf(node) });
    else if (typeof node === "object" && node !== null) for (const [name, child] of Object.entries(node)) walk(child, [...path, name]);
  };
  walk(object, []);
  return fields.sort((a, b) => b.bytes - a.bytes);
}

/** 応答を返す面(床の event の `surface`)。 */
export type ResponseSurface = Extract<EventPayload, { kind: "response_truncated" }>["surface"];

type ToolResponse = { isError?: boolean; content: { type: string; text?: string }[] };

/** 出口の床(ADR 0195 決定5): 成功の応答の CallToolResult が予算を超えていたら、目印込みの CallToolResult が予算に収まるまで
 *  本文を切って英語の目印を付け、盤面スコープの event を1件書く。読み口の欠陥の床であって続きの読み方ではない。
 *  error にはしない —— 書き込み verb なら書き込みは済んでいる。error の応答(`toolError`)と予算以下の応答はそのまま返す。
 *  ponytail: 測るのは先頭の text content を `toolResult` の形に包んだ大きさだけ —— 盤面の応答は `toolResult` の1切れしか持たない。
 *  他の欄(`structuredContent` 等)を返す応答が出たら CallToolResult そのものを測る */
export function floorResponse<R extends ToolResponse>(
  result: R,
  context: { db: Db; surface: ResponseSurface; verb: string; taskId?: string | null; at: Date },
): R {
  const text = result.content[0]?.text;
  if (result.isError || text === undefined) return result;
  const size = responseBytes(text);
  if (size <= RESPONSE_BUDGET_BYTES) return result;
  const { db, surface, verb, taskId, at } = context;
  const marker =
    `\n[tidepool: response cut to the ${RESPONSE_BUDGET_BYTES}-byte response budget by a board defect — ` +
    `${verb} returned ${size} bytes. The text above is incomplete.]`;
  appendEvent(db, {
    taskId: null,
    workerId: BOARD_WORKER_ID,
    origin: "board",
    at,
    payload: { kind: "response_truncated", surface, verb, bytes: size, budget: RESPONSE_BUDGET_BYTES, ...(taskId ? { task_id: taskId } : {}) },
  });
  const original = Buffer.from(text);
  const keptUpTo = (end: number) => original.subarray(0, end).toString();
  const kept = keptUpTo(fitEnd(original, 0, (end) => responseBytes(keptUpTo(end) + marker) <= RESPONSE_BUDGET_BYTES));
  return { ...result, content: [{ ...result.content[0], text: kept + marker }] };
}

/** 床の記録の行(ADR 0219 決定2): `response_truncated` の event を (surface, verb) ごとに1行にまとめる。新しい状態は持たず、
 *  events だけから導出する。`max_bytes` は切る前の最大の大きさ、`last_task_id` は最後の event の task(無ければ null)。 */
export function listFloorRows(db: Db) {
  const rows = new Map<string, { surface: ResponseSurface; verb: string; count: number; last_at: string; max_bytes: number; last_task_id: string | null }>();
  for (const { payload, created_at } of listEventsOfKinds(db, ["response_truncated"])) {
    const key = JSON.stringify([payload.surface, payload.verb]);
    const row = rows.get(key);
    rows.set(key, {
      surface: payload.surface,
      verb: payload.verb,
      count: (row?.count ?? 0) + 1,
      last_at: created_at,
      max_bytes: Math.max(row?.max_bytes ?? 0, payload.bytes),
      last_task_id: payload.task_id ?? null,
    });
  }
  return [...rows.values()];
}
