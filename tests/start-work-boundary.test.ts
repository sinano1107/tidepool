import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, makeWorkspace, managementMcpClient, mcpClient, registerWork, type Tidepool } from "./harness.js";

// `start_work` の人間面の写像だけ(ADR 0107): 経路と管理MCP の tool があり、拒否を既存の status と tool error へ写し、worker MCP には無い。
// task の読みはタスクブランチの有無と着手済みを運ぶ。判定と執行は tests/human-work.test.ts が domain 層で述べる。

let t: Tidepool;
afterEach(() => t?.stop());

it("POST /api/tasks/:id/start-work は作業台の在り処を返し、task の読みが has_task_branch と started を運ぶ —— 無い task は 404、拒否は 409", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace("start-work-route") });
  const human = await registerWork(t, "write it myself", undefined, "human");
  const agent = await registerWork(t, "an agent's task", undefined, "reef-crab");
  const before = (await api(t.baseUrl, "GET", `/api/tasks/${human.id}`)).json;

  const ok = await api(t.baseUrl, "POST", `/api/tasks/${human.id}/start-work`, {});
  const missing = await api(t.baseUrl, "POST", "/api/tasks/nope/start-work", {});
  const refused = await api(t.baseUrl, "POST", `/api/tasks/${agent.id}/start-work`, {});

  expect([before.has_task_branch, before.started]).toEqual([false, false]);
  expect(ok.status).toBe(200);
  expect(ok.json.path).toContain("@workbench");
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${human.id}`)).json;
  expect([after.has_task_branch, after.started]).toEqual([true, true]);
  expect(missing.status).toBe(404);
  expect(refused.status).toBe(409);
});

it("管理MCP の start_work は作業台の在り処を返し、拒否は tool error になり、worker MCP には無い", async () => {
  t = await bootTidepool();
  const human = await registerWork(t, "write it myself", undefined, "human");
  const worker = await mcpClient(t.mcpBaseUrl, human.id);
  try {
    expect((await worker.listTools()).tools.map((tool) => tool.name)).not.toContain("start_work");
  } finally {
    await worker.close();
  }
  const client = await managementMcpClient(t.baseUrl);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("start_work");

    // 盤面に workspace が無い —— 場所を導けない拒否(文は domain 層の釘)が tool error になる
    const refused: any = await client.callTool({ name: "start_work", arguments: { task_id: human.id } });

    expect(refused.isError).toBe(true);
  } finally {
    await client.close();
  }
});
