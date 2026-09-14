import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, managementMcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("POST /api/settings/memory で書いた注入上限は GET で読め、正の整数でなければ 400(issue #592)", async () => {
  t = await bootTidepool();
  expect(await api(t.baseUrl, "POST", "/api/settings/memory", { injection_token_cap: 800 })).toMatchObject({
    status: 200,
    json: { injection_token_cap: 800 },
  });
  for (const bad of [0, 1.5, "900"]) {
    expect((await api(t.baseUrl, "POST", "/api/settings/memory", { injection_token_cap: bad })).status).toBe(400);
  }
  expect((await api(t.baseUrl, "GET", "/api/settings/memory")).json).toEqual({ injection_token_cap: 800 });
});

it("管理MCP の change_memory_settings で書いた注入上限は read_memory_settings で読め、不正値は拒む(issue #592)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const changed = (await client.callTool({ name: "change_memory_settings", arguments: { injection_token_cap: 1200 } })) as any;
    expect(changed.isError).not.toBe(true);
    const rejected = (await client.callTool({ name: "change_memory_settings", arguments: { injection_token_cap: -5 } })) as any;
    expect(rejected.isError).toBe(true);
    const read = (await client.callTool({ name: "read_memory_settings", arguments: {} })) as any;
    expect(JSON.parse(read.content[0].text)).toEqual({ injection_token_cap: 1200 });
  } finally {
    await client.close();
  }
});
