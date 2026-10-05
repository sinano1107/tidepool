import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEventsOfKinds } from "../src/events.js";
import { toolError, toolResult } from "../src/mcp.js";
import { floorResponse, packItems, readNext } from "../src/response-budget.js";
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
  expect(() => packItems(readNext("get_task", next), "events", items.slice(0, 3))).toThrow(/next points at item \d+, which this read no longer has/);
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

/** 最初の読みから next が尽きるまで追った応答の列。 */
function followNext(items: readonly { id: number }[], envelope?: Record<string, unknown>) {
  const responses: any[] = [packItems(first, "events", items, envelope)];
  while (responses.at(-1).next) responses.push(packItems(readNext("get_task", responses.at(-1).next), "events", items));
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
  const position = (p: object) => Buffer.from(JSON.stringify({ ...first, at: 2, ...p })).toString("base64url");

  expect(() => readNext("get_task", position({ field: "line" }))).toThrow(/next is malformed/);
  expect(() => readNext("get_task", position({ field: ["line"], offset: "x" }))).toThrow(/next is malformed/);
  expect(() => readNext("get_task", position({ field: ["line"], offset: -10 }))).toThrow(/next is malformed/);
});

it("id を持たない item は渡した鍵(item と位置から)で続きの境目を表し、next を追うと欠けも重複もなく揃う", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `${i} ${"x".repeat(900)}`);
  const read = { verb: "preview_case", args: { event_id: 1 } };
  const byPosition = (_: string, i: number) => i;

  const responses: any[] = [packItems(read, "decisions", lines, {}, { keyOf: byPosition })];
  while (responses.at(-1).next) responses.push(packItems(readNext("preview_case", responses.at(-1).next), "decisions", lines, {}, { keyOf: byPosition }));

  expect(responses.length).toBeGreaterThan(1);
  for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(responses.flatMap((response) => response.decisions)).toEqual(lines);
});

it("1件で予算を超える文字列の item も切れで返し、つなぐと逐語の原文に戻る", () => {
  const long = "潮".repeat(30_000);
  const lines = ["short", long, "after"];
  const read = { verb: "preview_case", args: { event_id: 1 } };
  const byPosition = (_: string, i: number) => i;

  const responses: any[] = [packItems(read, "decisions", lines, {}, { keyOf: byPosition })];
  while (responses.at(-1).next) responses.push(packItems(readNext("preview_case", responses.at(-1).next), "decisions", lines, {}, { keyOf: byPosition }));

  for (const response of responses) expect(bytesOf(response)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const pieces = responses.filter((response) => response.partial);
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) expect(piece.partial).toEqual({ id: 1, field: "", field_bytes: Buffer.byteLength(long) });
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
