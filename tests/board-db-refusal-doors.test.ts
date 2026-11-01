import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeDraftClient } from "./fakes.js";
import { AUTH_HEADERS, bootTidepool, HOUR, managementMcpClient, mcpClient, queueWork, registerWork, type Tidepool } from "./harness.js";

/** ADR 0342 決定4: 再 throw が底に届かない口(express と MCP SDK が外側で受ける)は、盤面 DB の拒否(A)で `bootTidepool` の
 *  終了の関数を直接呼ぶ。lever は生きた接続の `query_only`(書き込みが SQLITE_READONLY になる)。 */
let t: Tidepool | undefined;
afterEach(async () => {
  t?.db.pragma("query_only = 0");
  await t?.stop();
  t = undefined;
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const refused = expect.objectContaining({ code: "SQLITE_READONLY" });

/** 応答がまだ無いか(盤面は終わる途中なので、口は何も答えない)。 */
const stillPending = (answer: Promise<unknown>) =>
  Promise.race([answer.then(() => "answered", () => "answered"), new Promise((resolve) => setTimeout(resolve, 50, "pending"))]);

const postTask = (t: Tidepool, title: string) =>
  fetch(`${t.baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ type: "work", title, purpose: "p", completion_criteria: "c" }),
  });

it("人間の HTTP verb の書き込みが拒まれれば、500 を返さず終了の関数を1度呼ぶ。拒まれなければ同じ verb が通る", async () => {
  const terminate = vi.fn();
  t = await bootTidepool({ terminateOnBoardDbRefusal: terminate });
  t.db.pragma("query_only = 1");

  const answer = postTask(t, "refused");

  await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
  expect(terminate).toHaveBeenCalledWith(refused, { operation: "POST /api/tasks" });
  expect(await stillPending(answer)).toBe("pending");
  t.db.pragma("query_only = 0");
  expect((await postTask(t, "accepted")).status).toBe(201);
});

it("worker の MCP verb の書き込みが拒まれれば、tool error を返さず終了の関数を verb と task で1度呼ぶ。拒まれなければ同じ verb が通る", async () => {
  const terminate = vi.fn();
  t = await bootTidepool({ terminateOnBoardDbRefusal: terminate });
  const task = await registerWork(t, "build the parser");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  t.db.pragma("query_only = 1");

  const answer = client.callTool({ name: "log_decision", arguments: { line: "refused" } });

  await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
  expect(terminate).toHaveBeenCalledWith(refused, { operation: "log_decision", taskId: task.id });
  expect(await stillPending(answer)).toBe("pending");
  t.db.pragma("query_only = 0");
  expect(await client.callTool({ name: "log_decision", arguments: { line: "accepted" } })).not.toHaveProperty("isError", true);
});

it("管理 MCP の verb の書き込みが拒まれれば、tool error を返さず終了の関数を verb で1度呼ぶ。拒まれなければ同じ verb が通る", async () => {
  const terminate = vi.fn();
  t = await bootTidepool({ terminateOnBoardDbRefusal: terminate });
  const [first, second] = [queueWork(t, "first"), queueWork(t, "second")];
  const client = await managementMcpClient(t.baseUrl);
  t.db.pragma("query_only = 1");

  const answer = client.callTool({ name: "cancel_task", arguments: { task_id: first.id } });

  await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
  expect(terminate).toHaveBeenCalledWith(refused, { operation: "cancel_task" });
  expect(await stillPending(answer)).toBe("pending");
  t.db.pragma("query_only = 0");
  expect(await client.callTool({ name: "cancel_task", arguments: { task_id: second.id } })).not.toHaveProperty("isError", true);
});

it("終了の関数が無い盤面では、拒まれた書き込みは今日どおり HTTP の 500 と MCP の tool error に投げ上がる", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "build the parser");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  t.db.pragma("query_only = 1");

  expect((await postTask(t, "refused")).status).toBe(500);
  expect(await client.callTool({ name: "log_decision", arguments: { line: "refused" } })).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("attempt to write a readonly database") }],
  });
});

// 応答を全部 4xx / 5xx に写す catch の族(api.ts の 502 / 503、管理 MCP の registryToolError)の代表
it("下書きの Board call の記録が拒まれれば、503 を返さず終了の関数を1度呼ぶ", async () => {
  const terminate = vi.fn();
  t = await bootTidepool({ terminateOnBoardDbRefusal: terminate, draftClient: new FakeDraftClient() });
  t.db.pragma("query_only = 1");

  const answer = fetch(`${t.baseUrl}/api/tasks/draft`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ dump: "draft this" }),
  });

  await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
  expect(terminate).toHaveBeenCalledWith(refused, { operation: "POST /api/tasks/draft" });
  expect(await stillPending(answer)).toBe("pending");
});
