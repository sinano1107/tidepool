import { afterEach, expect, it } from "vitest";
import { createAgent, deleteAgent, listAgentViews, updateAgent } from "../src/agent-create.js";
import { loadRegistry, ownEntry, type RegistrySource } from "../src/registry.js";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

let t: Tidepool;
afterEach(() => t?.stop());

const MY_FUGU_MD = `---
version: "1"
authority: standard
description: My own auditor.
icon: "🦈"
provider: anthropic
skills:
  - "@workspace"
---
You are my fugu.
`;

/** 合成 root(server-options.ts の `agentAdmin` / `agentRegisteredChecker`)と
 *  同じ束ね方で、本物の registry clone に配線した盤面。組み込みの印も削除の門も
 *  registry の読み込みから出てくるので、stub の agentAdmin では観測できない。 */
async function bootWithRegistry(files: Record<string, string> = {}): Promise<Tidepool> {
  const dir = await makeRegistry(files);
  const registry: RegistrySource = { dir, mode: "purely-local" };
  const deps = { registry };
  const load = () => loadRegistry(dir, "purely-local");
  return bootTidepool({
    workerId: "deckhand",
    agentAdmin: {
      create: (input) => createAgent(input, deps),
      list: () => listAgentViews(deps),
      update: (input) => updateAgent(input, deps),
      delete: (input, refs) => deleteAgent(input, { ...deps, ...refs }),
      authorityProfiles: () => Object.keys(load().authority),
    },
    agentRegistered: (name) => ownEntry(load().agents, name) !== undefined,
  });
}

function agentRow(json: any, name: string) {
  return json.agents.find((agent: { name: string }) => agent.name === name);
}

it("agent 一覧は組み込みの fugu を built-in として、同名の registry エントリを shadows built-in として映す(ADR 0117 決定2)", async () => {
  t = await bootWithRegistry();

  const builtIn = await api(t.baseUrl, "GET", "/api/agents");
  expect(agentRow(builtIn.json, "fugu")).toMatchObject({ builtin: true, skills: ["@workspace"] });
  expect(agentRow(builtIn.json, "fugu").shadowsBuiltIn).toBeUndefined();

  t.stop();
  t = await bootWithRegistry({ "agents/fugu.md": MY_FUGU_MD });

  const shadowed = await api(t.baseUrl, "GET", "/api/agents");
  expect(agentRow(shadowed.json, "fugu")).toMatchObject({
    shadowsBuiltIn: true,
    description: "My own auditor.",
  });
  expect(agentRow(shadowed.json, "fugu").builtin).toBeUndefined();
  // 印は機械の解決を映すだけ —— 組み込みでない名前には付かない
  expect(agentRow(shadowed.json, "deckhand").shadowsBuiltIn).toBeUndefined();
});

it("fugu の作成は成功し、応答が組み込みを shadow することを告げる(ADR 0117 決定2: 静かな shadow は作らない)", async () => {
  t = await bootWithRegistry();

  const res = await api(t.baseUrl, "POST", "/api/agents", {
    name: "fugu",
    authority: "standard",
    provider: "anthropic",
    skills: ["@workspace"],
    description: "My own auditor.",
    systemPrompt: "You are my fugu.",
  });

  expect(res.status).toBe(201);
  expect(res.json).toEqual({ shadows_built_in: true });
  const listed = await api(t.baseUrl, "GET", "/api/agents");
  expect(agentRow(listed.json, "fugu")).toMatchObject({ shadowsBuiltIn: true });
});

it("shadow している fugu は、Auditor ポインタが指していても未決着タスクが参照していても削除でき、一覧は built-in に戻る(ADR 0087 決定3 の唯一の例外)", async () => {
  t = await bootWithRegistry({ "agents/fugu.md": MY_FUGU_MD });
  await registerWork(t, "assigned to fugu", undefined, undefined, "fugu");
  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "reviewed by fugu",
    purpose: "p",
    completion_criteria: "c",
    review_by: ["fugu"],
  });

  const res = await api(t.baseUrl, "DELETE", "/api/agents/fugu", { confirm: true });

  expect(res.status).toBe(200);
  const listed = await api(t.baseUrl, "GET", "/api/agents");
  expect(agentRow(listed.json, "fugu")).toMatchObject({ builtin: true });
});

it("registry ファイルの無い fugu の削除は「組み込みは消せない」で拒まれる —— not found ではない(ADR 0117 決定2)", async () => {
  t = await bootWithRegistry();

  const res = await api(t.baseUrl, "DELETE", "/api/agents/fugu", { confirm: true });

  expect(res.status).toBe(409);
  expect(res.json.blocked).toBe(true);
  expect(res.json.reasons).toEqual([{ code: "built_in" }]);
  expect(res.json.error).toContain("built-in");
});

it("組み込みの fugu への更新は拒まれる —— 編集の扉が静かに shadow のファイルを書くことはない(ADR 0117 決定2)", async () => {
  t = await bootWithRegistry();

  const res = await api(t.baseUrl, "PATCH", "/api/agents/fugu", {
    authority: "standard",
    provider: "anthropic",
    skills: ["*"],
    description: "hijacked",
    systemPrompt: "",
  });

  expect(res.status).toBe(409);
  expect(res.json.error).toContain("built-in");
  const listed = await api(t.baseUrl, "GET", "/api/agents");
  expect(agentRow(listed.json, "fugu")).toMatchObject({ builtin: true, skills: ["@workspace"] });
});

it("review_by の fugu は組み込み・shadow のどちらの状態でも登録の門を通る(ADR 0117 決定2: 名前はどこでも1つの識別子)", async () => {
  const body = {
    type: "work",
    title: "reviewed by fugu",
    purpose: "p",
    completion_criteria: "c",
    review_by: ["fugu"],
  };
  t = await bootWithRegistry();

  expect((await api(t.baseUrl, "POST", "/api/tasks", body)).status).toBe(201);

  t.stop();
  t = await bootWithRegistry({ "agents/fugu.md": MY_FUGU_MD });

  expect((await api(t.baseUrl, "POST", "/api/tasks", body)).status).toBe(201);
});
