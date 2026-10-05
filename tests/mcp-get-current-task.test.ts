import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, RESPONSE_BUDGET_BYTES, readFollowingNext, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("get_current_task returns purpose and completion criteria over MCP", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "index the tide charts",
      purpose: "make historical tides searchable",
      completion_criteria: "a query for 2025-06 returns chart rows",
    })
  ).json;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe(task.id);
    expect(payload.purpose).toBe("make historical tides searchable");
    expect(payload.completion_criteria).toBe("a query for 2025-06 returns chart rows");
    expect(payload.parent).toBeNull();
  } finally {
    await client.close();
  }
});

it("親の兄弟の handoff 群が予算を超えると、get_current_task は予算分ずつ返し、next を追うと親の decision の子が欠けも重複もなく順に揃い、その後に task の history が続く。task と親の本体は最初の応答だけに載り、親の history を読み終えた続きには親の欄が載らない(ADR 0195)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "toolchain");
  await t.clock.advance(HOUR); // parent picked up
  const titles = Array.from({ length: 20 }, (_, i) => `part ${String(i).padStart(2, "0")}`);
  const decomposeClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await decomposeClient.callTool({
    name: "decompose",
    arguments: { reason: "split into parts", children: titles.map((title) => ({ title, purpose: "p", completion_criteria: "c" })) },
  });
  await decomposeClient.close();
  await t.clock.advance(HOUR); // 子の1件目が slot に入る
  // setup のみ: slot の子のほかの19件を handoff つきで終わったことにする
  const children = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.parent_id === parent.id);
  const current = children.find((child) => child.status === "in_progress");
  for (const child of children.filter((c) => c.id !== current.id))
    t.db.prepare("UPDATE tasks SET status = 'done', handoff_doc = ? WHERE id = ?").run(`${child.title} ${"潮".repeat(1_000)}`, child.id);

  const client = await mcpClient(t.mcpBaseUrl, current.id);
  try {
    const lines = Array.from({ length: 15 }, (_, i) => `${i} ${"x".repeat(3_000)}`);
    for (const line of lines) await client.callTool({ name: "log_decision", arguments: { line } });
    const responses = await readFollowingNext(client, "get_current_task");

    for (const response of responses) expect(response.bytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const decisions = responses.flatMap((response) => response.payload.parent?.history ?? []);
    expect(new Set(decisions.map((entry: any) => entry.decision))).toEqual(new Set(["split into parts"]));
    expect(decisions.flatMap((entry: any) => entry.children.map((child: any) => child.title))).toEqual(titles);
    expect(responses.flatMap((response) => response.payload.history.map((entry: any) => entry.decision))).toEqual(lines);
    expect(responses[0]!.payload).toMatchObject({ id: current.id, title: current.title, parent: { id: parent.id, title: "toolchain" } });
    for (const response of responses.slice(1)) expect(response.payload).not.toHaveProperty("id");
    const withParent = responses.slice(1).filter((response) => response.payload.parent);
    for (const response of withParent) expect(Object.keys(response.payload.parent)).toEqual(["history"]);
    expect(withParent.length).toBeGreaterThan(0);
    expect(responses.at(-1)!.payload).not.toHaveProperty("parent");
  } finally {
    await client.close();
  }
});

it("history の1件が予算を超える handoff を持つと、get_current_task はその欄を partial の切れで予算分ずつ返し、切れの欄をつなぐと handoff が逐語で戻る(ADR 0195 決定4)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "toolchain");
  await t.clock.advance(HOUR); // parent picked up
  const decomposeClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await decomposeClient.callTool({
    name: "decompose",
    arguments: { reason: "split in two", children: ["first", "second"].map((title) => ({ title, purpose: "p", completion_criteria: "c" })) },
  });
  await decomposeClient.close();
  await t.clock.advance(HOUR); // 子の1件目が slot に入る
  // setup のみ: slot の子でない方を、1件で予算を超える handoff つきで終わったことにする
  const handoff = `${"潮".repeat(14_000)} end`;
  const children = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.parent_id === parent.id);
  const current = children.find((child) => child.status === "in_progress");
  const sibling = children.find((child) => child.id !== current.id);
  t.db.prepare("UPDATE tasks SET status = 'done', handoff_doc = ? WHERE id = ?").run(handoff, sibling.id);

  const client = await mcpClient(t.mcpBaseUrl, current.id);
  try {
    const responses = await readFollowingNext(client, "get_current_task");

    for (const response of responses) expect(response.bytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const pieces = responses.filter((response) => response.payload.partial);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.payload.partial).toMatchObject({ field: "children.0.handoff_doc", field_bytes: Buffer.byteLength(handoff) });
    expect(pieces.map((piece) => piece.payload.parent.history[0].children[0].handoff_doc).join("")).toBe(handoff);
  } finally {
    await client.close();
  }
});
