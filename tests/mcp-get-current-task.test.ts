import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, RESPONSE_BUDGET_BYTES, readAllPages, registerWork, type Tidepool } from "./harness.js";

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

it("親の兄弟の handoff 群が予算を超えると、get_current_task は予算分ずつ返し、next を追うと親の decision の子が欠けも重複もなく順に揃う。task と親の本体は最初の応答だけに載る(ADR 0195)", async () => {
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
    const pages = await readAllPages(client, "get_current_task");

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.bytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const decisions = pages.flatMap((page) => page.payload.parent.history);
    expect(new Set(decisions.map((entry: any) => entry.decision))).toEqual(new Set(["split into parts"]));
    expect(decisions.flatMap((entry: any) => entry.children.map((child: any) => child.title))).toEqual(titles);
    expect(pages[0]!.payload).toMatchObject({ id: current.id, title: current.title, parent: { id: parent.id, title: "toolchain" } });
    for (const page of pages.slice(1)) {
      expect(page.payload).not.toHaveProperty("id");
      expect(Object.keys(page.payload.parent)).toEqual(["history"]);
    }
  } finally {
    await client.close();
  }
});
