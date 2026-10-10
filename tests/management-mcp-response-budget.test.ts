import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, expect, it } from "vitest";
import { appendEvent } from "../src/events.js";
import { listMemoryBranches } from "../src/memory.js";
import { nextDescription } from "../src/response-budget.js";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, HOUR, haltedRefires, managementMcpClient, queueWork, RESPONSE_BUDGET_BYTES, readFollowingNext, type Tidepool, WORKER_SPAWNED } from "./harness.js";

// 管理MCP の読み口は応答予算(UTF-8 で 40,000 バイト、ADR 0195)に収まり、収まらない分は続き(next)で読む(issue #1388)。
// 詰め方の境目・欄の分割・続きの error は tests/response-budget.test.ts が言う。ここは読み口ごとの写像を言う。

let t: Tidepool;
afterEach(() => t?.stop());

/** task に 1KB の decision_logged を `count` 件積む。 */
function logLines(taskId: string, count: number) {
  for (let i = 0; i < count; i++)
    appendEvent(t.db, { taskId, workerId: "human", origin: "mcp", at: t.clock.now(), payload: { kind: "decision_logged", line: `${i} ${"x".repeat(1000)}` } });
}

/** 1回の呼び出し。床で切れた応答は目印が JSON の後ろに付くので、JSON.parse が通ることも「続きで読めた」ことの一部 */
async function call(client: Client, args: Record<string, unknown>, verb = "get_task") {
  const result: any = await client.callTool({ name: verb, arguments: args });
  expect(result.isError ?? false, result.content[0].text).toBe(false);
  const text: string = result.content[0].text;
  return { bytes: Buffer.byteLength(JSON.stringify(result)), payload: JSON.parse(text) };
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
    const responses = [await call(client, { task_id: task.id })];
    while (responses.at(-1)!.payload.next) responses.push(await call(client, { next: responses.at(-1)!.payload.next }));

    expect(responses.length).toBeGreaterThan(2);
    for (const response of responses) expect(response.bytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const ids = await newestFirstIds(task.id);
    expect(responses.flatMap((response) => response.payload.events.map((e: any) => e.id))).toEqual(ids);
    expect(responses[0]!.payload).toMatchObject({ id: task.id, title: "long history", purpose: task.purpose });
    for (const response of responses.slice(1)) expect(Object.keys(response.payload).filter((k) => !["events", "next", "remaining"].includes(k))).toEqual([]);
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
    const responses = [await call(client, { task_id: task.id })];
    logLines(task.id, 5);
    while (responses.at(-1)!.payload.next) responses.push(await call(client, { next: responses.at(-1)!.payload.next }));

    expect(responses.flatMap((response) => response.payload.events.map((e: any) => e.id))).toEqual(before);
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

// 残りの読み口(issue #1389): 予算を超える量を積むと各応答が予算以下になり、next を追うと決めた順で欠けも重複もなく揃う。
// 小さいときは1回で全部届き next が付かない。封筒(item の列以外の欄)は最初の応答だけに載る。

const KB = "x".repeat(1000);
const http = async (path: string) => (await api(t.baseUrl, "GET", path)).json;

/** 配分評価の撃ち直しを3回失敗させて打ち切った行を `count` 件置く(行の失敗の理由が 1KB)。 */
function haltAllocationReviews(count: number) {
  const at = t.clock.now();
  for (let i = 0; i < count; i++) {
    const reviewed = queueWork(t, `reviewed ${i}`);
    appendEvent(t.db, { taskId: reviewed.id, workerId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
    const review = registerTask(t.db, { type: "review", title: `review ${i}`, purpose: "p", completion_criteria: "c", parent_id: reviewed.id, integration_review: true }, at, "board", "board");
    const completed = appendEvent(t.db, { taskId: review.id, workerId: "deckhand", origin: "board", at, payload: { kind: "task_completed", handoff_present: false, result: null } });
    for (let n = 0; n < 3; n++)
      appendEvent(t.db, {
        taskId: reviewed.id,
        workerId: "board",
        origin: "board",
        at,
        payload: { kind: "allocation_review_failed", review_completed_event_id: completed, review_task_id: review.id, reviewed_task_id: reviewed.id, reason: `${i} ${KB}` },
      });
  }
}

/** 読み口ごとの積み方(`count` 件)・最初の引数・item の列の欄・item の鍵・HTTP / domain が返す同じ列。 */
const reads: Array<{
  verb: string;
  key: string;
  pile: (client: Client, count: number) => Promise<Record<string, unknown>>;
  keyOf: (item: any) => unknown;
  expected: (args: Record<string, unknown>) => Promise<unknown[]>;
}> = [
  {
    verb: "read_decision_log",
    key: "entries",
    pile: async (_, count) => (logLines(queueWork(t, "busy").id, count), {}),
    keyOf: (entry) => entry.id,
    expected: async () => (await http("/api/log")).entries.map((e: any) => e.id).reverse(),
  },
  {
    verb: "list_board",
    key: "tasks",
    pile: async (_, count) => (Array.from({ length: count }, (_, i) => queueWork(t, `${i} ${KB}`)), {}),
    keyOf: (task) => task.id,
    expected: async () => (await http("/api/tasks")).map((task: any) => task.id),
  },
  {
    verb: "list_queue",
    key: "tasks",
    pile: async (_, count) => (Array.from({ length: count }, (_, i) => queueWork(t, `${i} ${KB}`)), {}),
    keyOf: (task) => task.id,
    expected: async () => (await http("/api/queue")).tasks.map((task: any) => task.id),
  },
  {
    verb: "list_your_tasks",
    key: "tasks",
    pile: async (_, count) => (Array.from({ length: count }, (_, i) => queueWork(t, `${i} ${KB}`, undefined, "human")), {}),
    keyOf: (task) => task.id,
    expected: async () => (await http("/api/your-tasks")).map((task: any) => task.id),
  },
  {
    verb: "list_memory_entries",
    key: "entries",
    // 絞り込みの外にも1件置き、続きが最初の引数(path)を自分の中から戻すことも言う
    pile: async (client, count) => {
      for (const path of ["elsewhere", ...Array<string>(count).fill("pile")])
        await client.callTool({ name: "record_knowledge", arguments: { workspace: null, path, title: path, text: KB } });
      return { path: "pile" };
    },
    keyOf: (entry) => entry.id,
    expected: async () => (await http("/api/settings/memory/entries?path=pile")).entries.map((e: any) => e.id),
  },
  {
    verb: "list_memory_branches",
    key: "branches",
    pile: async (client, count) => {
      for (let i = 0; i < count; i++) await client.callTool({ name: "define_memory_branch", arguments: { workspace: null, path: `pile/${i}`, text: KB } });
      return {};
    },
    keyOf: (row) => row.path,
    expected: async () => listMemoryBranches(t.db).map((row) => row.path),
  },
  {
    verb: "list_halted_refires",
    key: "halted",
    pile: async (_, count) => (haltAllocationReviews(count), {}),
    keyOf: (row) => `${row.refire}:${row.target}`,
    expected: async () => (await haltedRefires(t)).map((row: any) => `${row.refire}:${row.target}`),
  },
  {
    verb: "preview_case",
    key: "decisions",
    pile: async (_, count) => {
      const task = queueWork(t, "a long session");
      const spawned = appendEvent(t.db, { taskId: task.id, workerId: "deckhand", origin: "board", at: t.clock.now(), payload: WORKER_SPAWNED });
      logLines(task.id, count);
      return { event_id: spawned };
    },
    keyOf: (line) => line,
    expected: async (args) => (await http(`/api/settings/memory/cases/${args.event_id}`)).decisions,
  },
];

it.each(reads)("$verb は予算を超える量を予算分ずつ返し、next を追うと欠けも重複もなく揃う。封筒は最初の応答だけに載る", async ({ verb, key, pile, keyOf, expected }) => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const args = await pile(client, 60);
    const responses = await readFollowingNext(client, verb, args);

    expect(responses.length).toBeGreaterThan(1);
    for (const response of responses) expect(response.bytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(responses.flatMap((response) => response.payload[key].map(keyOf))).toEqual(await expected(args));
    for (const response of responses.slice(1)) expect(Object.keys(response.payload).filter((k) => ![key, "next", "remaining"].includes(k))).toEqual([]);
  } finally {
    await client.close();
  }
});

it.each(reads)("$verb は小さいとき1回で全部を返し、next も remaining も付かない", async ({ verb, key, pile, keyOf, expected }) => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const args = await pile(client, 2);
    const { payload } = await call(client, args, verb);

    expect(payload[key].map(keyOf)).toEqual(await expected(args));
    expect(payload).not.toHaveProperty("next");
    expect(payload).not.toHaveProperty("remaining");
  } finally {
    await client.close();
  }
});

it("read_decision_log を読んでいる途中に entry が積まれても、next を追った読みは最初の読みの時点のログを新しい順に欠けも重複もなく返し、未読カーソルは最初の応答だけに載る", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "busy");
  logLines(task.id, 100);
  const before = (await http("/api/log")).entries.map((e: any) => e.id).reverse();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const responses = [await call(client, {}, "read_decision_log")];
    logLines(task.id, 5);
    while (responses.at(-1)!.payload.next) responses.push(await call(client, { next: responses.at(-1)!.payload.next }, "read_decision_log"));

    expect(responses.flatMap((response) => response.payload.entries.map((e: any) => e.id))).toEqual(before);
    expect(responses[0]!.payload.cursor).toEqual(expect.any(Number));
  } finally {
    await client.close();
  }
});

// 読む間に既読の範囲が変わったとき(ADR 0195 追記 #1399): #1399 の観測と同じ 1KB の task 60件の queue

/** 1KB の task を60件積んだ queue の、最初の list_queue の応答と queue の id の列。 */
async function queueRead(client: Client) {
  Array.from({ length: 60 }, (_, i) => queueWork(t, `${i} ${KB}`));
  const ids: string[] = (await http("/api/queue")).tasks.map((task: any) => task.id);
  const { payload } = await call(client, {}, "list_queue");
  return { ids, returned: payload.tasks.length as number, next: payload.next as string };
}

it("list_queue の続きの途中で未読の task を先頭へ move すると、続きは黙って欠けずに読み直せの error になる", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const { ids, next } = await queueRead(client);
    await api(t.baseUrl, "POST", `/api/tasks/${ids.at(-1)}/move`, { after: null });

    const result: any = await client.callTool({ name: "list_queue", arguments: { next } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("the list changed since the first list_queue call: call list_queue again without next to read it from the start");
  } finally {
    await client.close();
  }
});

it("list_queue の続きの途中で境目の task を cancel しても、続きは残りを欠けなく返す", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const { ids, returned, next } = await queueRead(client);
    await api(t.baseUrl, "POST", `/api/tasks/${ids[returned]}/cancel`, {});

    const responses = [await call(client, { next }, "list_queue")];
    while (responses.at(-1)!.payload.next) responses.push(await call(client, { next: responses.at(-1)!.payload.next }, "list_queue"));

    expect(responses.flatMap((response) => response.payload.tasks.map((task: any) => task.id))).toEqual(ids.slice(returned + 1));
  } finally {
    await client.close();
  }
});

it("続きで読む口の説明は、一覧が読む間に変わると最初から読み直せの error になると言う。新しい順の履歴の口は代わりに、読み始めた後の分は返らないと言う", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const description = Object.fromEntries((await client.listTools()).tools.map((tool) => [tool.name, tool.description]));

    expect(description.list_queue).toContain(
      'If the list changes under the read, the call fails with "the list changed since the first list_queue call: call list_queue again without next to read it from the start"; read again from the start.',
    );
    expect(description.list_your_tasks).toContain(
      'If the list changes under the read, the call fails with "the list changed since the first list_your_tasks call: call list_your_tasks again without next to read it from the start"; read again from the start.',
    );
    expect(description.read_decision_log).toContain(nextDescription("read_decision_log", "entries", "`cursor` comes", true));
    expect(description.get_task).toContain(nextDescription("get_task", "events", "The task itself comes", true));
    for (const verb of ["read_decision_log", "get_task"]) expect(description[verb]).not.toContain("the list changed");
  } finally {
    await client.close();
  }
});

it("register_task・cancel_task・complete_task の ack は task の識別と状態だけを返し、呼び手が渡した本文をエコーしない", async () => {
  t = await bootTidepool();
  // 登録は pickup の契機なので(ADR 0119 決定2)、slot を埋めて行を取り消せる todo のまま置く
  queueWork(t, "occupies the slot");
  await t.clock.advance(HOUR);
  const human = queueWork(t, "confirm the licence", undefined, "human");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const registered = (await call(client, { type: "work", title: "t", purpose: KB, completion_criteria: KB }, "register_task")).payload;
    const cancelled = (await call(client, { task_id: registered.id }, "cancel_task")).payload;
    const done = (await call(client, { task_id: human.id, handoff: { outcome: KB } }, "complete_task")).payload;

    expect(registered).toEqual({ id: expect.any(String), type: "work", status: "todo", assignee: "fake-worker", raw_assignee: null });
    expect(cancelled).toEqual({ ...registered, status: "cancelled" });
    expect(done).toEqual({ id: human.id, type: "work", status: "done", assignee: "human", raw_assignee: "human" });
  } finally {
    await client.close();
  }
});
