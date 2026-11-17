import { afterEach, expect, it } from "vitest";
import { DomainError } from "../src/domain-error.js";
import type { EventOrigin } from "../src/events.js";
import { UnknownWorkspaceError } from "../src/workspace.js";
import { api, bootTidepool, managementMcpClient, mcpClient, registerWork, type Tidepool } from "./harness.js";

// `open_workbench` の人間面の写像だけ(ADR 0107): 経路と管理MCP の tool があり、拒否を既存の status と tool error へ写し、worker MCP には無い。
// 判定と執行は tests/intake-workbench.test.ts が domain 層で述べる。

let t: Tidepool;
afterEach(() => t?.stop());

/** 名前ごとに応答か拒否を返す偽の `open_workbench`。呼ばれた (名前, origin) を控える。 */
function fakeOpenWorkbench() {
  const calls: Array<[string, EventOrigin]> = [];
  const openWorkbench = ({ name }: { name: string }, origin: EventOrigin) => {
    calls.push([name, origin]);
    if (name === "nowhere") throw new UnknownWorkspaceError(name);
    if (name === "remote") throw new DomainError("workspace remote is remote-backed, so main is changed on origin.");
    return `opened the workbench for ${name}`;
  };
  return { calls, openWorkbench };
}

it("POST /api/workspaces/:name/workbench は応答の文を返し、登録されていない名前は 404、拒否は 409", async () => {
  const fake = fakeOpenWorkbench();
  t = await bootTidepool({ workspaceAdmin: { openWorkbench: fake.openWorkbench } });

  const ok = await api(t.baseUrl, "POST", "/api/workspaces/sandbox/workbench", {});
  const unknown = await api(t.baseUrl, "POST", "/api/workspaces/nowhere/workbench", {});
  const refused = await api(t.baseUrl, "POST", "/api/workspaces/remote/workbench", {});

  expect([ok.status, ok.json]).toEqual([200, { message: "opened the workbench for sandbox" }]);
  expect(unknown.status).toBe(404);
  expect([refused.status, refused.json]).toEqual([409, { error: "workspace remote is remote-backed, so main is changed on origin." }]);
  expect(fake.calls).toEqual([
    ["sandbox", "webui"],
    ["nowhere", "webui"],
    ["remote", "webui"],
  ]);
});

it("管理MCP の open_workbench は応答の文を返し、拒否は tool error になり、worker MCP には無い", async () => {
  const fake = fakeOpenWorkbench();
  t = await bootTidepool({ workspaceAdmin: { openWorkbench: fake.openWorkbench } });
  const task = await registerWork(t, "a worker session");
  const worker = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    expect((await worker.listTools()).tools.map((tool) => tool.name)).not.toContain("open_workbench");
  } finally {
    await worker.close();
  }
  const client = await managementMcpClient(t.baseUrl);
  try {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "open_workbench")?.description).toContain("protected branch of a purely-local workspace");

    const ok: any = await client.callTool({ name: "open_workbench", arguments: { name: "sandbox" } });
    const unknown: any = await client.callTool({ name: "open_workbench", arguments: { name: "nowhere" } });
    const refused: any = await client.callTool({ name: "open_workbench", arguments: { name: "remote" } });

    expect(ok.isError ?? false).toBe(false);
    expect(JSON.parse(ok.content[0].text)).toEqual({ message: "opened the workbench for sandbox" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toBe(new UnknownWorkspaceError("nowhere").message);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe("workspace remote is remote-backed, so main is changed on origin.");
    expect(fake.calls.map(([, origin]) => origin)).toEqual(["mcp", "mcp", "mcp"]);
  } finally {
    await client.close();
  }
});
