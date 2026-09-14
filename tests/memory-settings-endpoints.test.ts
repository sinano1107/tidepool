import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, managementMcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** 盤面スコープの操作イベントには読み口が無い(execution_settings_changed と同じ)ので行を直に読む。 */
const changes = () => t.db.prepare("SELECT task_id, worker_id, origin, payload FROM events WHERE kind = 'memory_settings_changed'").all();

it("GET / POST /api/settings/memory は注入上限を読み書きし(未設定は 2,000)、正の整数でなければ 400、変更は経路 webui の event になる(issue #592)", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "GET", "/api/settings/memory")).json).toEqual({ injection_token_cap: 2000 });

  const saved = await api(t.baseUrl, "POST", "/api/settings/memory", { injection_token_cap: 800 });
  expect(saved).toMatchObject({ status: 200, json: { injection_token_cap: 800 } });
  for (const bad of [0, 1.5, "900"]) {
    expect((await api(t.baseUrl, "POST", "/api/settings/memory", { injection_token_cap: bad })).status).toBe(400);
  }

  expect((await api(t.baseUrl, "GET", "/api/settings/memory")).json).toEqual({ injection_token_cap: 800 });
  expect(changes()).toEqual([
    { task_id: null, worker_id: "human", origin: "webui", payload: JSON.stringify({ kind: "memory_settings_changed", injection_token_cap: 800 }) },
  ]);
});

it("管理MCP の read_memory_settings / change_memory_settings は同じ上限を読み書きし、不正値は拒み、変更は経路 mcp の event になる(issue #592)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const read = async () => JSON.parse(((await client.callTool({ name: "read_memory_settings", arguments: {} })) as any).content[0].text);
    expect(await read()).toEqual({ injection_token_cap: 2000 });

    const changed = (await client.callTool({ name: "change_memory_settings", arguments: { injection_token_cap: 1200 } })) as any;
    expect(changed.isError).not.toBe(true);
    const rejected = (await client.callTool({ name: "change_memory_settings", arguments: { injection_token_cap: -5 } })) as any;
    expect(rejected.isError).toBe(true);

    expect(await read()).toEqual({ injection_token_cap: 1200 });
  } finally {
    await client.close();
  }
  expect(changes()).toMatchObject([{ task_id: null, worker_id: "human", origin: "mcp" }]);
});
