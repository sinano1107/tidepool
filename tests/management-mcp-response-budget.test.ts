import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, expect, it } from "vitest";
import { appendEvent } from "../src/events.js";
import { api, bootTidepool, managementMcpClient, queueWork, type Tidepool } from "./harness.js";

// 管理MCP の読み口は応答予算(UTF-8 で 40,000 バイト、ADR 0195)に収まり、収まらない分は続き(next)で読む(issue #1388)。
// 詰め方の境目・欄の分割・続きの error は tests/response-budget.test.ts が言う。ここは読み口ごとの写像を言う。

const BUDGET = 40_000;

let t: Tidepool;
afterEach(() => t?.stop());

/** task に 1KB の decision_logged を `count` 件積む。 */
function logLines(taskId: string, count: number) {
  for (let i = 0; i < count; i++)
    appendEvent(t.db, { taskId, workerId: "human", origin: "mcp", at: t.clock.now(), payload: { kind: "decision_logged", line: `${i} ${"x".repeat(1000)}` } });
}

async function call(client: Client, args: Record<string, unknown>) {
  const result: any = await client.callTool({ name: "get_task", arguments: args });
  expect(result.isError ?? false).toBe(false);
  const text: string = result.content[0].text;
  return { bytes: Buffer.byteLength(text), payload: JSON.parse(text) };
}

/** HTTP の events の口(古い順)を新しい順にした id の列。 */
async function newestFirstIds(taskId: string) {
  return ((await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json as any[]).map((e) => e.id).reverse();
}

it("get_task は予算を超える量の event を新しい順に予算分ずつ返し、next を追うと欠けも重複もなく揃う。task 本体は最初の応答だけに載る", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "long history");
  logLines(task.id, 100);
  const client = await managementMcpClient(t.baseUrl);
  try {
    const pages = [await call(client, { task_id: task.id })];
    while (pages.at(-1)!.payload.next) pages.push(await call(client, { next: pages.at(-1)!.payload.next }));

    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) expect(page.bytes).toBeLessThanOrEqual(BUDGET);
    const ids = await newestFirstIds(task.id);
    expect(pages.flatMap((page) => page.payload.events.map((e: any) => e.id))).toEqual(ids);
    expect(pages[0]!.payload).toMatchObject({ id: task.id, title: "long history", purpose: task.purpose });
    for (const page of pages.slice(1)) expect(Object.keys(page.payload).filter((k) => !["events", "next", "remaining"].includes(k))).toEqual([]);
  } finally {
    await client.close();
  }
});

it("get_task を読んでいる途中に event が積まれても、next を追った読みは最初の読みの時点の履歴を欠けも重複もなく返す", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "growing history");
  logLines(task.id, 100);
  const before = await newestFirstIds(task.id);
  const client = await managementMcpClient(t.baseUrl);
  try {
    const pages = [await call(client, { task_id: task.id })];
    logLines(task.id, 5);
    while (pages.at(-1)!.payload.next) pages.push(await call(client, { next: pages.at(-1)!.payload.next }));

    expect(pages.flatMap((page) => page.payload.events.map((e: any) => e.id))).toEqual(before);
  } finally {
    await client.close();
  }
});

it("event の少ない task は1回の get_task で全部が新しい順に届き、next も remaining も付かない", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "short history");
  logLines(task.id, 3);
  const client = await managementMcpClient(t.baseUrl);
  try {
    const { payload } = await call(client, { task_id: task.id });

    expect(payload.events.map((e: any) => e.id)).toEqual(await newestFirstIds(task.id));
    expect(payload).not.toHaveProperty("next");
    expect(payload).not.toHaveProperty("remaining");
  } finally {
    await client.close();
  }
});
