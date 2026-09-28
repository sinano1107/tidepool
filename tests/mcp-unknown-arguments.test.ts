import { afterEach, expect, it } from "vitest";
import { bootTidepool, HOUR, managementMcpClient, mcpClient, memoryEntries, registerWork, type Tidepool } from "./harness.js";

/** issue #1075: MCP の verb は inputSchema に無い引数を黙って捨てず、tool error で拒否する。 */
let t: Tidepool;
afterEach(() => t?.stop());

const text = (result: any): string => result.content[0].text;

it("worker MCP の書き込み verb に未知の引数を渡すと、キー名つきの tool error になり、記憶は書かれない", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts", "charts");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result = await client.callTool({
      name: "record_knowledge",
      arguments: {
        path: "build/tests",
        title: "Tests need Node 22",
        text: "npm test fails on Node 24.",
        source: { commit: "0a46a46" },
        based_on_decisoin: 1,
      },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("based_on_decisoin");
    expect(await memoryEntries(t)).toEqual([]);
  } finally {
    await client.close();
  }
});

it("worker MCP の読み取り verb に未知の引数を渡すと、絞り込まれない結果ではなく tool error になる", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts", "charts");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result = await client.callTool({ name: "browse_memory", arguments: { prefx: "build" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("prefx");
  } finally {
    await client.close();
  }
});

it("worker MCP の tools/list は、引数を持たない verb にも additionalProperties: false を載せる", async () => {
  t = await bootTidepool();

  const client = await mcpClient(t.mcpBaseUrl);
  try {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "get_current_task")?.inputSchema).toMatchObject({ additionalProperties: false });
  } finally {
    await client.close();
  }
});

it("arguments を省いた呼び出しは空の引数として受ける —— 引数を持たない verb が strict の空 object で拒否しない", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result = await client.callTool({ name: "get_current_task" });
    expect(result.isError).toBeFalsy();
  } finally {
    await client.close();
  }
});

it("管理 MCP の verb に未知の引数を渡すと、キー名つきの tool error になる", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts");

  const client = await managementMcpClient(t.baseUrl);
  try {
    const result = await client.callTool({ name: "get_task", arguments: { task_id: task.id, with_events: true } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("with_events");
  } finally {
    await client.close();
  }
});

it("管理 MCP の tools/list は additionalProperties: false を載せる", async () => {
  t = await bootTidepool();

  const client = await managementMcpClient(t.baseUrl);
  try {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "get_task")?.inputSchema).toMatchObject({ additionalProperties: false });
  } finally {
    await client.close();
  }
});
