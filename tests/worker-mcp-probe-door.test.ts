import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { bootTidepool, type Tidepool } from "./harness.js";

// ADR 0331 決定8: Worker MCP の probe の帰属の扉。盤面が probe ごとに発行する使い捨ての id を `?probe=` で受け、
// 開いている間だけ initialize を通す。verb は1本も出さない

let t: Tidepool;
afterEach(() => t?.stop());

async function connect(query: Record<string, string>): Promise<Client> {
  const url = new URL(`${t.mcpBaseUrl}/mcp`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const client = new Client({ name: "tidepool-probe-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

it("発行中の probe の id では initialize が通り、tools/list は空", async () => {
  t = await bootTidepool({ probeIds: new Set(["probe-1"]) });
  const client = await connect({ probe: "probe-1" });
  try {
    expect((await client.listTools()).tools).toEqual([]);
  } finally {
    await client.close();
  }
});

it("発行中の probe の id で verb を呼ぶと拒まれる", async () => {
  t = await bootTidepool({ probeIds: new Set(["probe-1"]) });
  const client = await connect({ probe: "probe-1" });
  try {
    await expect(client.callTool({ name: "get_current_task", arguments: {} })).rejects.toThrow();
  } finally {
    await client.close();
  }
});

it("probe の終了(id の無効化)の後は同じ id の initialize も拒まれる —— 古い process が扉を通らない", async () => {
  const probeIds = new Set(["probe-1"]);
  t = await bootTidepool({ probeIds });
  const open = await connect({ probe: "probe-1" });
  await open.close();
  probeIds.delete("probe-1");
  await expect(connect({ probe: "probe-1" })).rejects.toThrow("not attributed to an open Worker MCP probe");
});

it("扉の拒否は 403 でない —— Claude CLI は 403 の server 名を needs-auth としてホストに記録し、以後の worker が繋がらない", async () => {
  t = await bootTidepool({ probeIds: new Set() });
  const res = await fetch(`${t.mcpBaseUrl}/mcp?probe=never-issued`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  expect(res.status).toBe(404);
});

it("発行していない id と、?task= と ?probe= の併用は initialize から拒まれる", async () => {
  t = await bootTidepool({ probeIds: new Set(["probe-1"]) });
  await expect(connect({ probe: "never-issued" })).rejects.toThrow("not attributed to an open Worker MCP probe");
  await expect(connect({ task: "some-task", probe: "probe-1" })).rejects.toThrow("not attributed to an open Worker MCP probe");
});
