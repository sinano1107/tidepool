import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEventsOfKinds } from "../src/events.js";
import { toolError, toolResult } from "../src/mcp.js";
import { floorResponse, listFloorRows, nextDescription, packItems, type ResponseSurface, readNext } from "../src/response-budget.js";
import { RESPONSE_BUDGET_BYTES } from "./harness.js";

// 応答予算(ADR 0195): 詰める関数の境目・欄の分割・続きの error と、出口の床はここで言う(issue #1388)。
// 大きさは盤面が返す CallToolResult を丸ごとシリアライズした UTF-8 バイト数で測る(ADR 0195 追記1)。

const resultBytes = (result: unknown) => Buffer.byteLength(JSON.stringify(result));
/** payload を `toolResult` に包んだ CallToolResult の大きさ。 */
const bytesOf = (payload: unknown) => resultBytes(toolResult(payload));
const first = { verb: "get_task", args: { task_id: "t1" } };

/** `{ events }` を CallToolResult に包んだ大きさがちょうど `total` バイトになる item 列。 */
function itemsTotalling(total: number) {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: 40 - i, line: "x".repeat(900) }));
  items[0]!.line += "x".repeat(total - bytesOf({ events: items }));
  return items;
}

it("ちょうど予算の読みは1回で全部返り next も remaining も付かない", () => {
  const items = itemsTotalling(RESPONSE_BUDGET_BYTES);

  expect(packItems(first, "events", items)).toEqual({ events: items });
});

it("1バイト超えると、予算に収まる先頭の item を丸ごと返し、next と remaining を付ける。next を追うと残りが続く", () => {
  const items = itemsTotalling(RESPONSE_BUDGET_BYTES + 1);

  const response: any = packItems(first, "events", items);
  expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(response.events).toEqual(items.slice(0, response.events.length));
  expect(response.remaining).toBe(items.length - response.events.length);
  expect(response.next).toEqual(expect.any(String));

  const rest: any = packItems(readNext("get_task", response.next), "events", items);
  expect(rest).toEqual({ events: items.slice(response.events.length) });
});

it("壊れた続き・別の verb の続き・指す item が無い続きは、それぞれ何が悪いかを名指す error になる", () => {
  const items = itemsTotalling(RESPONSE_BUDGET_BYTES + 1);
  const { next } = packItems(first, "events", items) as { next: string };

  expect(() => readNext("get_task", "not-a-next")).toThrow(/next is malformed/);
  expect(() => readNext("read_decision_log", next)).toThrow(/next belongs to get_task, not read_decision_log/);
  expect(() => packItems(readNext("get_task", next), "events", items.slice(0, 3), {}, { resumeByKey: true })).toThrow(
    "the list changed since the first get_task call: call get_task again without next to read it from the start",
  );
});

// 読む間に既読の範囲が変わったとき(ADR 0195 追記 #1399): 続きは返した件数と鍵の列の digest で先頭の範囲を照らす
const queueRead = { verb: "list_queue", args: {} };
const LIST_CHANGED = "the list changed since the first list_queue call: call list_queue again without next to read it from the start";
/** 1KB の item を `count` 件(id は 1 から)。 */
const pile = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i + 1, line: "x".repeat(1000) }));
/** 最初の応答と、`changed` の列に対して続きを読む関数。 */
function firstThen(items: readonly { id: number; line: string }[], options?: { resumeByKey: true }) {
  const response: any = packItems(queueRead, "tasks", items, {}, options);
  return { returned: response.tasks.length as number, resume: (changed: readonly { id: number; line: string }[]) => packItems(readNext("list_queue", response.next), "tasks", changed, {}, options) as any };
}

it("未読の item が先頭へ移ると、続きは黙って欠けずに読み直せの error になる", () => {
  const items = pile(60);
  const { resume } = firstThen(items);

  expect(() => resume([items.at(-1)!, ...items.slice(0, -1)])).toThrow(LIST_CHANGED);
});

it("既読の item が末尾へ移ると、続きは重複を返さずに読み直せの error になる", () => {
  const items = pile(60);
  const { resume } = firstThen(items);

  expect(() => resume([...items.slice(1), items[0]!])).toThrow(LIST_CHANGED);
});

it("既読の範囲で item が抜けても、途中に入っても、続きは読み直せの error になる", () => {
  const items = pile(60);
  const { resume } = firstThen(items);

  expect(() => resume(items.filter((item) => item.id !== 2))).toThrow(LIST_CHANGED);
  expect(() => resume([items[0]!, { id: 61, line: "new" }, ...items.slice(1)])).toThrow(LIST_CHANGED);
});

it("境目の item だけが抜けたときは、続きは error にならず残りを欠けなく返す", () => {
  const items = pile(60);
  const { returned, resume } = firstThen(items);
  const changed = items.filter((_, i) => i !== returned);

  const responses = [resume(changed)];
  while (responses.at(-1).next) responses.push(packItems(readNext("list_queue", responses.at(-1).next), "tasks", changed));

  expect(responses.flatMap((response) => response.tasks)).toEqual(changed.slice(returned));
});

it("末尾に足された item は、続きで返る", () => {
  const items = pile(60);
  const { returned, resume } = firstThen(items);
  const grown = [...items, { id: 61, line: "new" }];

  const responses = [resume(grown)];
  while (responses.at(-1).next) responses.push(packItems(readNext("list_queue", responses.at(-1).next), "tasks", grown));

  expect(responses.flatMap((response) => response.tasks)).toEqual(grown.slice(returned));
});

it("未読の範囲の中の並べ替えでは、続きは error にならず今の順で残りを返す", () => {
  const items = pile(60);
  const { returned, resume } = firstThen(items);
  const reordered = [...items.slice(0, returned), ...items.slice(returned).reverse()];

  const responses = [resume(reordered)];
  while (responses.at(-1).next) responses.push(packItems(readNext("list_queue", responses.at(-1).next), "tasks", reordered));

  expect(responses.flatMap((response) => response.tasks)).toEqual(reordered.slice(returned));
});

it("検査を外した読み口では、先頭に足された item を続きで返さず、error にもならない", () => {
  const items = pile(60).reverse();
  const { returned, resume } = firstThen(items, { resumeByKey: true });

  expect(resume([{ id: 61, line: "new" }, ...items]).tasks[0]).toEqual(items[returned]);
});

it("1件を切って返している途中にその欄が変わると、続きは継ぎはぎを返さずに読み直せの error になる", () => {
  const items = [{ id: 1, line: "潮".repeat(30_000) }];
  for (const options of [undefined, { resumeByKey: true as const }]) {
    const { resume } = firstThen(items, options);

    expect(() => resume([{ id: 1, line: "汐".repeat(30_000) }])).toThrow(LIST_CHANGED);
    expect(() => resume([{ id: 1, line: "潮".repeat(29_999) }])).toThrow(LIST_CHANGED);
  }
});

it("1件を切って返している途中にその item が抜け、同じ欄の item が位置を継いでも、続きは別の item をつながずに読み直せの error になる", () => {
  const line = "潮".repeat(30_000);
  const { resume } = firstThen([{ id: 1, line }, { id: 2, line }]);

  expect(() => resume([{ id: 2, line }])).toThrow(LIST_CHANGED);
});

it("1件を切って返している途中にその欄が文字列でなくなると、続きは読み直せの error になる", () => {
  const { resume } = firstThen([{ id: 1, line: "潮".repeat(30_000) }]);

  expect(() => resume([{ id: 1, line: 0 as unknown as string }])).toThrow(LIST_CHANGED);
});

const at = new Date(0);
const textOf = (result: { content: { text: string }[] }) => result.content[0]!.text;

it("出口の床は予算を超える応答を予算まで切り、盤面の欠陥の目印を付け、盤面スコープの event を1件残す。error にはしない", () => {
  const db = openDb(":memory:");
  const payload = { line: "潮".repeat(20_000) };

  const result = floorResponse(toolResult(payload), { db, surface: "worker", verb: "complete_task", taskId: "t1", at });

  expect(result).not.toHaveProperty("isError");
  expect(resultBytes(result)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(textOf(result)).toContain("board defect");
  expect(textOf(result)).toContain(String(bytesOf(payload)));
  expect(textOf(result)).toContain("complete_task");
  expect(listEventsOfKinds(db, ["response_truncated"]).map((e) => [e.task_id, e.payload])).toEqual([
    [null, { kind: "response_truncated", surface: "worker", verb: "complete_task", bytes: bytesOf(payload), budget: RESPONSE_BUDGET_BYTES, task_id: "t1" }],
  ]);
});

it("出口の床は本文を UTF-8 の文字の途中で切らない", () => {
  // 切る位置が多バイト文字のどの位置にも当たるよう、先頭の ASCII で揃え方をずらす。
  // 4バイトの文字の切れ端は U+FFFD(3バイト)に化けて小さく見えるので、文字境界へ戻さないと予算の際で切れ端が残る
  for (const lead of ["", "a", "aa", "aaa"]) {
    const result = floorResponse(toolResult({ line: lead + "🐙".repeat(15_000) }), { db: openDb(":memory:"), surface: "worker", verb: "complete_task", at });
    expect(textOf(result)).not.toContain("\uFFFD");
  }
});

it("出口の床は、本文は予算以下でも CallToolResult に包むと予算を超える応答を切り、切ったあとの CallToolResult も目印込みで予算以下にする", () => {
  const db = openDb(":memory:");
  // 本文で `\"` の2バイトが、包むと4バイトになる
  const payload = { line: '"'.repeat(15_000) };
  const response = toolResult(payload);
  expect(Buffer.byteLength(textOf(response))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);

  const result = floorResponse(response, { db, surface: "management", verb: "get_task", at });

  expect(resultBytes(result)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(textOf(result)).toContain("board defect");
  expect(textOf(result)).toContain(String(bytesOf(payload)));
  expect(listEventsOfKinds(db, ["response_truncated"]).map((e) => e.payload)).toEqual([
    { kind: "response_truncated", surface: "management", verb: "get_task", bytes: bytesOf(payload), budget: RESPONSE_BUDGET_BYTES },
  ]);
});

it("出口の床は予算以下の応答と error の応答をそのまま通し、event を残さない", () => {
  const db = openDb(":memory:");
  const small = toolResult({ events: itemsTotalling(RESPONSE_BUDGET_BYTES) });
  const error = toolError("x".repeat(RESPONSE_BUDGET_BYTES + 1));

  expect(floorResponse(small, { db, surface: "management", verb: "get_task", at })).toBe(small);
  expect(floorResponse(error, { db, surface: "management", verb: "get_task", at })).toBe(error);
  expect(listEventsOfKinds(db, ["response_truncated"])).toEqual([]);
});

// 床の記録の行(ADR 0219 決定2): (surface, verb) ごとに1行、events だけから導出する(issue #1386)
it("床の記録が無ければ床の行は空", () => {
  expect(listFloorRows(openDb(":memory:"))).toEqual([]);
});

it("床の行は (surface, verb) ごとに1つで、回数・最後の時刻・最大の bytes・最後の event の task を持つ。surface が違えば同じ verb でも別の行", () => {
  const db = openDb(":memory:");
  const big = toolResult({ line: "x".repeat(60_000) });
  const small = toolResult({ line: "x".repeat(45_000) });
  const floor = (result: typeof big, surface: ResponseSurface, verb: string, minute: number, taskId?: string) =>
    floorResponse(result, { db, surface, verb, taskId, at: new Date(minute * 60_000) });
  floor(small, "worker", "get_task", 1, "t1");
  floor(big, "worker", "get_task", 2, "t2");
  floor(small, "management", "get_task", 3);
  floor(small, "worker", "get_task", 4, "t3");
  floor(small, "worker", "list_events", 5, "t4");
  floor(small, "worker", "list_events", 6);

  expect(listFloorRows(db)).toEqual([
    { surface: "worker", verb: "get_task", count: 3, last_at: new Date(4 * 60_000).toISOString(), max_bytes: resultBytes(big), last_task_id: "t3" },
    { surface: "management", verb: "get_task", count: 1, last_at: new Date(3 * 60_000).toISOString(), max_bytes: resultBytes(small), last_task_id: null },
    { surface: "worker", verb: "list_events", count: 2, last_at: new Date(6 * 60_000).toISOString(), max_bytes: resultBytes(small), last_task_id: null },
  ]);
});

/** 最初の読みから next が尽きるまで追った応答の列。読み口と同じく、封筒は続きでも渡す。 */
function followNext(items: readonly { id: number }[], envelope?: Record<string, unknown>) {
  const responses: any[] = [packItems(first, "events", items, envelope)];
  while (responses.at(-1).next) responses.push(packItems(readNext("get_task", responses.at(-1).next), "events", items, envelope));
  return responses;
}

it("1件で予算を超える item は長い欄を UTF-8 の文字境界で切って単独で返し、部分の印を付ける。next を追ってつなぐと逐語の原文に戻る", () => {
  // 多バイト文字・JSON で escape される文字を混ぜ、どの位置で切っても文字の途中に当たりうるようにする
  const long = '潮だまり🐙"\n'.repeat(9_000);
  const items = [{ id: 3, line: "short" }, { id: 2, payload: { kind: "decision_logged", line: long } }, { id: 1, line: "after" }];

  const responses = followNext(items);

  for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const pieces = responses.filter((response) => response.partial);
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) {
    expect(piece.partial).toEqual({ id: 2, field: "payload.line", field_bytes: Buffer.byteLength(long) });
    expect(piece.events).toHaveLength(1);
    expect(piece.events[0]).toMatchObject({ id: 2, payload: { kind: "decision_logged" } });
  }
  expect(pieces.map((piece) => piece.events[0].payload.line).join("")).toBe(long);
  expect(responses.flatMap((response) => response.events.filter((e: any) => e.id !== 2))).toEqual([items[0], items[2]]);
});

it("封筒と先頭の item が一緒に入らないとき、最初の応答は封筒だけを返し、その item は次の応答で丸ごと返る", () => {
  const envelope = { purpose: "p".repeat(30_000) };
  const items = [3, 2, 1].map((id) => ({ id, line: "x".repeat(15_000) }));

  const responses = followNext(items, envelope);

  expect(responses[0]).toMatchObject({ ...envelope, events: [], remaining: 3 });
  for (const response of responses.slice(1)) expect(response).not.toHaveProperty("purpose");
  expect(responses.some((response) => response.partial)).toBe(false);
  expect(responses.flatMap((response) => response.events)).toEqual(items);
});

it("欄の位置が壊れた続きも名指しの error になる", () => {
  const position = (p: object) =>
    Buffer.from(JSON.stringify({ ...first, at: 2, count: 0, digest: "d", cut: [{ path: ["line"], bytes: 1, digest: "d" }], reading: 0, offset: 0, ...p })).toString("base64url");

  expect(() => readNext("get_task", position({}))).not.toThrow();
  expect(() => readNext("get_task", position({ cut: "line" }))).toThrow(/next is malformed/);
  expect(() => readNext("get_task", position({ cut: [{ path: "line", bytes: 1, digest: "d" }] }))).toThrow(/next is malformed/);
  expect(() => readNext("get_task", position({ offset: "x" }))).toThrow(/next is malformed/);
  expect(() => readNext("get_task", position({ offset: -10 }))).toThrow(/next is malformed/);
  expect(() => readNext("get_task", position({ reading: 1 }))).toThrow(/next is malformed/);
  // 封筒の切れの続きだけが `at` を持たない —— 切る欄も持たなければ最初の読みと区別できない
  expect(() => readNext("get_task", position({ at: undefined }))).not.toThrow();
  expect(() => readNext("get_task", position({ at: undefined, cut: undefined }))).toThrow(/next is malformed/);
});

it("id を持たない item は渡した鍵(item に添えた id の列から)で続きの境目を表し、next を追うと欠けも重複もなく揃う", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `${i} ${"x".repeat(900)}`);
  const read = { verb: "preview_case", args: { event_id: 1 } };
  const lineIds = lines.map((_, i) => 100 + i);
  const byLineId = (_: string, i: number) => lineIds[i]!;

  const responses: any[] = [packItems(read, "decisions", lines, {}, { keyOf: byLineId })];
  while (responses.at(-1).next) responses.push(packItems(readNext("preview_case", responses.at(-1).next), "decisions", lines, {}, { keyOf: byLineId }));

  expect(responses.length).toBeGreaterThan(1);
  for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(responses.flatMap((response) => response.decisions)).toEqual(lines);
});

it("1件で予算を超える文字列の item も切れで返し、つなぐと逐語の原文に戻る", () => {
  const long = "潮".repeat(30_000);
  const lines = ["short", long, "after"];
  const read = { verb: "preview_case", args: { event_id: 1 } };
  const lineIds = lines.map((_, i) => 100 + i);
  const byLineId = (_: string, i: number) => lineIds[i]!;

  const responses: any[] = [packItems(read, "decisions", lines, {}, { keyOf: byLineId })];
  while (responses.at(-1).next) responses.push(packItems(readNext("preview_case", responses.at(-1).next), "decisions", lines, {}, { keyOf: byLineId }));

  for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const pieces = responses.filter((response) => response.partial);
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) expect(piece.partial).toEqual({ id: 101, field: "", field_bytes: Buffer.byteLength(long) });
  expect(pieces.map((piece) => piece.decisions[0]).join("")).toBe(long);
  expect(responses.flatMap((response) => (response.partial ? [] : response.decisions))).toEqual(["short", "after"]);
});

it("先頭の item が封筒なしでも1件で予算を超えるときは、最初の応答から封筒とその item の切れを返す —— 封筒だけの応答を挟まない", () => {
  const envelope = { dropped: [] };
  const long = "潮".repeat(20_000);
  const items = [{ id: 2, line: long }, { id: 1, line: "after" }];

  const responses = followNext(items, envelope);

  for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(responses[0]).toMatchObject({ ...envelope, partial: { id: 2, field: "line" } });
  expect(responses.filter((response) => response.partial).map((response) => response.events[0].line).join("")).toBe(long);
  expect(responses.at(-1).events).toEqual([items[1]]);
});

it("複数の列に詰めると item は自分の列に載り(列は空でも載る)、続きは列の境を跨いで順に続く。毎回載る欄(every)はどの応答にも載り、その分も予算に数える", () => {
  const items = Array.from({ length: 45 }, (_, i) => ({ id: i, text: "x".repeat(2_000) }));
  const every = { event_id: Number.MAX_SAFE_INTEGER };
  const options = { listOf: (item: { id: number }) => (item.id < 30 ? "parent.history" : "history"), every };
  const read = { verb: "get_current_task", args: {} };

  const responses: any[] = [packItems(read, ["parent.history", "history"], items, { parent: { id: "p" } }, options)];
  while (responses.at(-1).next) responses.push(packItems(readNext("get_current_task", responses.at(-1).next), ["parent.history", "history"], items, {}, options));

  expect(responses.length).toBeGreaterThan(2);
  for (const response of responses) {
    expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(response).toMatchObject({ event_id: every.event_id, parent: { history: expect.any(Array) }, history: expect.any(Array) });
  }
  expect(responses[0].parent.id).toBe("p");
  for (const response of responses.slice(1)) expect(response.parent).not.toHaveProperty("id");
  expect(responses.flatMap((response) => response.parent.history.map((item: any) => item.id))).toEqual(items.slice(0, 30).map((item) => item.id));
  expect(responses.flatMap((response) => response.history.map((item: any) => item.id))).toEqual(items.slice(30).map((item) => item.id));
});

it("引用符の多い item で詰めても、包んだ CallToolResult は最初の応答も続きの応答も予算以下で、next を追うと欠けも重複もなく揃う", () => {
  // 小さい object を多数 —— 本文では1バイトの `"` が、CallToolResult に包むと `\"` の2バイトになる
  const items = Array.from({ length: 1_500 }, (_, i) => ({ id: i, kind: "decision_logged", line: `"${i}" said "ok"` }));
  // 封筒の大きさを1バイトずつずらし、詰め終わりと予算の隙間がどの幅にもなるようにする(続きの欄の引用符の分も境目で効く)
  for (let pad = 0; pad < 80; pad++) {
    const envelope = { title: `"quoted" title ${"x".repeat(pad)}` };

    const responses = followNext(items, envelope);

    expect(responses.length).toBeGreaterThan(2);
    for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(responses[0]).toMatchObject(envelope);
    expect(responses.flatMap((response) => response.events)).toEqual(items);
  }
});

it("1件で予算を超える item の欄が包むと膨らむ文字(引用符・バックスラッシュ・改行)だらけでも、切れの CallToolResult は予算以下で、つなぐと逐語の原文に戻る", () => {
  // 本文で2バイトの `\"` `\\` `\n` は、CallToolResult に包むとそれぞれ4バイトになる。多バイト文字も混ぜ、文字の途中で切れうるようにする
  const long = '"\\\n潮🐙"'.repeat(8_000);
  const items = [{ id: 3, line: "short" }, { id: 2, payload: { kind: "decision_logged", line: long } }, { id: 1, line: "after" }];

  const responses = followNext(items);

  for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const pieces = responses.filter((response) => response.partial);
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) expect(piece.partial).toEqual({ id: 2, field: "payload.line", field_bytes: Buffer.byteLength(long) });
  expect(pieces.map((piece) => piece.events[0].payload.line).join("")).toBe(long);
  expect(responses.flatMap((response) => response.events.filter((e: any) => e.id !== 2))).toEqual([items[0], items[2]]);
});

// 1欄を切っても予算に収まらない object(ADR 0195 追記 #1393): 収まるまで長い順に欄を切り、封筒は item より先に切る
const fieldAt = (node: any, path: string) => path.split(".").reduce((n, name) => n[name], node);
/** 切れの列を `partial.field` ごとにつなぐ。`cutOf` は切れの応答から切った object を取る。 */
function joinPieces(pieces: any[], cutOf: (piece: any) => unknown) {
  const joined: Record<string, string> = {};
  for (const piece of pieces) joined[piece.partial.field] = (joined[piece.partial.field] ?? "") + fieldAt(cutOf(piece), piece.partial.field);
  return joined;
}

it("長い欄を2つ持つ item は、収まるまで長い順に欄を切り、切れごとに1つの欄の断片だけを載せてほかの切る欄を空にし emptied で名指す。next を追うとどの応答も予算以下で、各欄が逐語に戻り、後ろの item も届く", () => {
  const handoff = "h".repeat(50_000);
  const result = '潮"'.repeat(11_250); // 45,000 バイト
  const items = [{ id: 2, case: { handoff, result }, kind: "exemplar" }, { id: 1, line: "after" }];

  const responses = followNext(items);

  for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const pieces = responses.filter((response) => response.partial);
  for (const piece of pieces) {
    const other = piece.partial.field === "case.handoff" ? "case.result" : "case.handoff";
    expect(piece.partial).toEqual({ id: 2, field: piece.partial.field, field_bytes: Buffer.byteLength(fieldAt(items[0], piece.partial.field)), emptied: [other] });
    expect(fieldAt(piece.events[0], other)).toBe("");
    expect(piece.events[0].kind).toBe("exemplar");
  }
  expect(joinPieces(pieces, (piece) => piece.events[0])).toEqual({ "case.handoff": handoff, "case.result": result });
  expect(responses.flatMap((response) => (response.partial ? [] : response.events))).toEqual([items[1]]);
});

it("封筒だけで予算を超えるときは、item より先に封筒を切れで返す。封筒の切れの partial は id を持たず field は応答の根からの path で、item の列は空、remaining は item の全件数。封筒を読み終えると item が続く", () => {
  const handoff = "潮".repeat(15_000); // 45,000 バイト
  const envelope = { title: "t", parent: { handoff_doc: handoff } };
  for (const items of [[{ id: 1, line: "small" }], []]) {
    const responses = followNext(items, envelope);

    for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const pieces = responses.filter((response) => response.partial);
    expect(pieces.length).toBeGreaterThan(1);
    expect(responses.slice(0, pieces.length)).toEqual(pieces);
    for (const piece of pieces) {
      expect(piece.partial).toEqual({ field: "parent.handoff_doc", field_bytes: Buffer.byteLength(handoff) });
      expect(piece).toMatchObject({ title: "t", events: [] });
    }
    for (const piece of pieces.slice(0, -1)) expect(piece.remaining).toBe(items.length);
    expect(joinPieces(pieces, (piece) => piece)).toEqual({ "parent.handoff_doc": handoff });
    for (const response of responses.slice(pieces.length)) expect(response).not.toHaveProperty("title");
    expect(responses.flatMap((response) => response.events)).toEqual(items);
  }
});

it("切れの途中で、今読んでいない切る欄が書き換わると、続きは継ぎはぎを返さずに読み直せの error になる", () => {
  const item = { id: 1, case: { handoff: "h".repeat(50_000), result: "r".repeat(45_000) } };
  const response: any = packItems(queueRead, "tasks", [item]);
  expect(response.partial.field).toBe("case.handoff");

  expect(() => packItems(readNext("list_queue", response.next), "tasks", [{ id: 1, case: { ...item.case, result: "R".repeat(45_000) } }])).toThrow(LIST_CHANGED);
});

it("鍵で引き直す新しい順の履歴(get_task の形)でも、予算を超える封筒を切れで読み終えると、その後に event が届く", () => {
  const envelope = { purpose: "潮".repeat(15_000) };
  const events = [3, 2, 1].map((id) => ({ id, line: "e" }));
  const options = { resumeByKey: true } as const;

  const responses: any[] = [packItems(first, "events", events, envelope, options)];
  while (responses.at(-1).next) responses.push(packItems(readNext("get_task", responses.at(-1).next), "events", events, envelope, options));

  for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(joinPieces(responses.filter((response) => response.partial), (piece) => piece)).toEqual({ purpose: envelope.purpose });
  expect(responses.flatMap((response) => response.events)).toEqual(events);
});

it("短い文字列の欄ばかりで予算を超える封筒は、欄を全部切っても続きの印の分で収まらないので、切らずに丸ごと返して床に任せる(ADR 0195 追記 #1393 の5)", () => {
  const envelope = { dropped: Array.from({ length: 1_000 }, (_, i) => ({ id: `entry-${i}`, reason: "r".repeat(40) })) };

  expect(packItems(first, "events", [], envelope)).toEqual({ ...envelope, events: [] });
});

it.each([
  { shape: "1欄 45,000 バイト", item: { id: 2, line: "潮".repeat(15_000) }, envelope: { purpose: "p".repeat(39_700) } },
  { shape: "2欄 30,000 バイト ×2", item: { id: 2, case: { handoff: "h".repeat(30_000), result: "r".repeat(30_000) } }, envelope: { purpose: "p".repeat(39_500) } },
  // 空の断片なら封筒の横で収まるが、1文字(制御文字は CallToolResult の中で7バイト)を載せると超える窓(issue #1700)
  ...[39_496, 39_497, 39_498].map((n) => ({ shape: `制御文字 9,000 字・封筒 ${n} 字`, item: { id: 2, line: "\u0001".repeat(9_000) }, envelope: { purpose: "p".repeat(n) } })),
])("封筒の横で先頭の item($shape)を切っても収まらないときは、最初の応答で封筒だけを返し、item はその後に封筒なしの切れで届く。next を追うとどの応答も予算以下で、各欄が逐語に戻り、後ろの item も届く(issue #1668)", ({ item, envelope }) => {
  const items = [item, { id: 1, line: "after" }];

  const responses = followNext(items, envelope);

  for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(responses[0]).toEqual({ ...envelope, events: [], next: expect.any(String), remaining: items.length });
  // 切れの1つに、つないだ欄を戻すと item が逐語に戻る(切らない欄は切れごとに丸ごと載る)
  const pieces = responses.filter((response) => response.partial);
  const restored = structuredClone(pieces[0].events[0]);
  for (const [field, text] of Object.entries(joinPieces(pieces, (piece) => piece.events[0]))) {
    const path = field.split(".");
    path.slice(0, -1).reduce((node, name) => node[name], restored)[path.at(-1)!] = text;
  }
  expect(restored).toEqual(item);
  expect(responses.flatMap((response) => (response.partial ? [] : response.events))).toEqual([items[1]]);
});

it("文字列以外の骨格が予算の縁にある object を切るとき、封筒なしの item でも封筒そのものでも、partial を持つ応答は続きの offset の桁が伸びる途中の切れまで予算以下(issue #1700)", () => {
  // 制御文字(CallToolResult の中で7バイト)を続きの offset が 1→2 桁・2→3 桁に伸びる位置(10 と 100)にまたがって置く。
  // ほかは1バイトの文字にして、縁で切れが数バイトずつしか載せられなくても切れの数を抑える(末尾の 200 字は、欄を続きの印より
  // 大きくして item を切れる大きさにするため)
  const line = "\u0001".repeat(12) + "x".repeat(84) + "\u0001".repeat(8) + "x".repeat(200);
  const shapes = [
    { last: 200, read: (nums: number[]) => followNext([{ id: 2, nums, line }, { id: 1 }] as { id: number }[]), cutOf: (piece: any) => piece.events[0] },
    { last: 258, read: (nums: number[]) => followNext([{ id: 1 }], { nums, line }), cutOf: (piece: any) => piece },
  ];
  for (const { last, read, cutOf } of shapes) {
    // 骨格(数の配列)を1要素(2バイト)ずつ大きくし、切れる最後の大きさ `last` から、1文字と続きの印を載せると超える縁の先までを動かす
    const pieceCounts = [];
    for (let k = last; k <= last + 4; k++) {
      const pieces = read([...Array<number>(2_300).fill(Number.MAX_SAFE_INTEGER), ...Array<number>(k).fill(7)]).filter((response) => response.partial);
      for (const piece of pieces) expect(bytesOf(piece)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
      if (pieces.length > 0) expect(joinPieces(pieces, cutOf)).toEqual({ line });
      pieceCounts.push(pieces.length);
    }
    // 動かした範囲が縁をまたいでいる(切れる読みと切れない読みの両方がある)
    expect(pieceCounts[0]).toBeGreaterThan(0);
    expect(pieceCounts).toContain(0);
  }
  // 縁で切れる読みは数十の切れになり、切れごとに予算の位置を探すので数秒かかる
}, 20_000);

it("短い文字列の欄ばかりで予算を超える item は切らずに丸ごと返して床に任せる。封筒があれば、封筒だけを先に返してから続きで丸ごと返す(ADR 0195 追記 #1393 の5)", () => {
  const items = [{ id: 2, tags: Array.from({ length: 10_000 }, () => "ab") }, { id: 1, line: "after" }];

  const alone = packItems(first, "events", items);
  expect(alone).toEqual({ events: [items[0]], next: expect.any(String), remaining: 1 });
  expect(bytesOf(alone)).toBeGreaterThan(RESPONSE_BUDGET_BYTES);

  const envelope = { purpose: "small" };
  const withEnvelope = packItems(first, "events", items, envelope);
  expect(withEnvelope).toEqual({ ...envelope, events: [], next: expect.any(String), remaining: 2 });
  expect(packItems(readNext("get_task", withEnvelope.next as string), "events", items, envelope)).toEqual(alone);
});

it("鍵で引き直す口の説明は、最初の応答だけの部分があれば、その最後の切れより後に積まれた分も返らないと言う。無ければ最初の呼び出しより後だけを言う", () => {
  expect(nextDescription("get_task", "events", "The task itself comes", true)).toContain(
    "Events added after the first call are not returned (when what comes on the first response only is itself too large, those added after its last piece instead): call again without `next` to see them.",
  );
  expect(nextDescription("get_task", "events", undefined, true)).toContain(
    "Events added after the first call are not returned: call again without `next` to see them.",
  );
});
