import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEventsOfKinds } from "../src/events.js";
import { toolError, toolResult } from "../src/mcp.js";
import { floorResponse, packItems, readNext } from "../src/response-budget.js";

// 応答予算(ADR 0195): 詰める関数の境目・欄の分割・続きの error と、出口の床はここで言う(issue #1388)。
// 大きさは MCP の text content に載るシリアライズ後の UTF-8 バイト数で測る。

const RESPONSE_BUDGET_BYTES = 40_000;
const bytesOf =(payload: unknown) => Buffer.byteLength(JSON.stringify(payload));
const first = { verb: "get_task", args: { task_id: "t1" } };

/** シリアライズ後がちょうど `total` バイトになる `{ events }` の item 列。 */
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

  const page: any = packItems(first, "events", items);
  expect(bytesOf(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(page.events).toEqual(items.slice(0, page.events.length));
  expect(page.remaining).toBe(items.length - page.events.length);
  expect(page.next).toEqual(expect.any(String));

  const rest: any = packItems(readNext("get_task", page.next), "events", items);
  expect(rest).toEqual({ events: items.slice(page.events.length) });
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
  expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(textOf(result)).toContain("board defect");
  expect(textOf(result)).toContain(String(bytesOf(payload)));
  expect(textOf(result)).toContain("complete_task");
  expect(listEventsOfKinds(db, ["response_truncated"]).map((e) => [e.task_id, e.payload])).toEqual([
    [null, { kind: "response_truncated", surface: "worker", verb: "complete_task", bytes: bytesOf(payload), budget: RESPONSE_BUDGET_BYTES, task_id: "t1" }],
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
function readAll(items: readonly { id: number }[], envelope?: Record<string, unknown>) {
  const pages: any[] = [packItems(first, "events", items, envelope)];
  while (pages.at(-1).next) pages.push(packItems(readNext("get_task", pages.at(-1).next), "events", items));
  return pages;
}

it("1件で予算を超える item は長い欄を UTF-8 の文字境界で切って単独で返し、部分の印を付ける。next を追ってつなぐと逐語の原文に戻る", () => {
  // 多バイト文字・JSON で escape される文字を混ぜ、どの位置で切っても文字の途中に当たりうるようにする
  const long = '潮だまり🐙"\n'.repeat(9_000);
  const items = [{ id: 3, line: "short" }, { id: 2, payload: { kind: "decision_logged", line: long } }, { id: 1, line: "after" }];

  const pages = readAll(items);

  for (const page of pages) expect(bytesOf(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const pieces = pages.filter((page) => page.partial);
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) {
    expect(piece.partial).toEqual({ id: 2, field: "payload.line", field_bytes: Buffer.byteLength(long) });
    expect(piece.events).toHaveLength(1);
    expect(piece.events[0]).toMatchObject({ id: 2, payload: { kind: "decision_logged" } });
  }
  expect(pieces.map((piece) => piece.events[0].payload.line).join("")).toBe(long);
  expect(pages.flatMap((page) => page.events.filter((e: any) => e.id !== 2))).toEqual([items[0], items[2]]);
});

it("封筒と先頭の item が一緒に入らないとき、最初の応答は封筒だけを返し、その item は次の応答で丸ごと返る", () => {
  const envelope = { purpose: "p".repeat(30_000) };
  const items = [3, 2, 1].map((id) => ({ id, line: "x".repeat(15_000) }));

  const pages = readAll(items, envelope);

  expect(pages[0]).toMatchObject({ ...envelope, events: [], remaining: 3 });
  for (const page of pages.slice(1)) expect(page).not.toHaveProperty("purpose");
  expect(pages.some((page) => page.partial)).toBe(false);
  expect(pages.flatMap((page) => page.events)).toEqual(items);
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

  const pages: any[] = [packItems(read, "decisions", lines, {}, byPosition)];
  while (pages.at(-1).next) pages.push(packItems(readNext("preview_case", pages.at(-1).next), "decisions", lines, {}, byPosition));

  expect(pages.length).toBeGreaterThan(1);
  for (const page of pages) expect(bytesOf(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(pages.flatMap((page) => page.decisions)).toEqual(lines);
});

it("1件で予算を超える文字列の item も切れで返し、つなぐと逐語の原文に戻る", () => {
  const long = "潮".repeat(30_000);
  const lines = ["short", long, "after"];
  const read = { verb: "preview_case", args: { event_id: 1 } };
  const byPosition = (_: string, i: number) => i;

  const pages: any[] = [packItems(read, "decisions", lines, {}, byPosition)];
  while (pages.at(-1).next) pages.push(packItems(readNext("preview_case", pages.at(-1).next), "decisions", lines, {}, byPosition));

  for (const page of pages) expect(bytesOf(page)).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  const pieces = pages.filter((page) => page.partial);
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) expect(piece.partial).toEqual({ id: 1, field: "", field_bytes: Buffer.byteLength(long) });
  expect(pieces.map((piece) => piece.decisions[0]).join("")).toBe(long);
  expect(pages.flatMap((page) => (page.partial ? [] : page.decisions))).toEqual(["short", "after"]);
});
