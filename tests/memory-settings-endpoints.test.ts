import { afterEach, expect, it } from "vitest";
import { recordKnowledge } from "../src/memory.js";
import { registerTask } from "../src/tasks.js";
import { FakeTranslationClient } from "./fakes.js";
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

/** agent 由来の Knowledge を1つ(setup — 出所に使える event を registerTask で作る)。 */
function agentKnowledge(tp: Tidepool, title: string) {
  registerTask(tp.db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, tp.clock.now());
  return recordKnowledge(
    tp.db,
    { scope: "tidepool", path: "build/tests", title, text: `${title}.`, source: { event_id: 1 }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    tp.clock.now(),
  ).entry_id;
}

it("GET /api/settings/memory/entries は絞り込みを受け、原文の無い agent 由来のエントリは POST /api/translate の memory_entry で表示言語に訳せる(issue #593)", async () => {
  const translationClient = new FakeTranslationClient();
  t = await bootTidepool({ translationClient });
  const agent = agentKnowledge(t, "Tests need Node 22");
  const written = await api(t.baseUrl, "POST", "/api/settings/memory/definitions", {
    workspace: null,
    path: "build",
    text: "How things are built.",
    original_text: "ビルドの仕方",
  });
  expect(written.status).toBe(200);

  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries")).json.entries).toMatchObject([
    { id: agent, text: "Tests need Node 22.", original: null },
    { id: written.json.entry_id, original: { text: "ビルドの仕方", language: "Japanese" } },
  ]);
  const boardWide = await api(t.baseUrl, "GET", "/api/settings/memory/entries?board_wide=true&kind=definition");
  expect(boardWide.json.entries.map((e: { id: number }) => e.id)).toEqual([written.json.entry_id]);
  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?state=bogus")).status).toBe(400);

  expect((await api(t.baseUrl, "POST", "/api/translate", { type: "memory_entry", entry_id: agent })).json).toEqual({
    status: "translated",
    title: "[translated] Tests need Node 22",
    text: "[translated] Tests need Node 22.",
    cached: false,
  });
  expect((await api(t.baseUrl, "POST", "/api/translate", { type: "memory_entry", entry_id: 999 })).status).toBe(404);

  await t.stop();
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/translate", { type: "memory_entry", entry_id: agent })).status).toBe(503);
});

it("翻訳 client が無くても Knowledge の書き込みは原文つき・書き手 human で保存できる(issue #593)", async () => {
  t = await bootTidepool();
  const written = await api(t.baseUrl, "POST", "/api/settings/memory/knowledge", {
    workspace: "tidepool",
    path: "build/tests",
    title: "Use Node 22",
    text: "Run the suite on Node 22.",
    original_title: "Node 22 を使う",
    original_text: "スイートは Node 22 で走らせる",
  });
  expect(written.status).toBe(200);
  const partial = { workspace: null, path: "a", title: "t", text: "x", original_title: "原文の title だけ" };
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/knowledge", partial)).status).toBe(400);
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/knowledge", { workspace: null, path: "a", title: "t", text: "" })).status).toBe(400);
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/knowledge", { workspace: null, path: "a//b", title: "t", text: "x" })).status).toBe(400);

  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries")).json.entries).toMatchObject([
    {
      id: written.json.entry_id,
      kind: "knowledge",
      scope: "tidepool",
      text: "Run the suite on Node 22.",
      original: { title: "Node 22 を使う", text: "スイートは Node 22 で走らせる", language: "Japanese" },
      author: { activity: "human", name: "human" },
    },
  ]);
});

it("POST /api/settings/memory/definitions は1行の定義を書き、supersedes で同じ枝を書き直す(issue #593)", async () => {
  t = await bootTidepool();
  const first = await api(t.baseUrl, "POST", "/api/settings/memory/definitions", { workspace: "tidepool", path: "build", text: "Builds." });
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/definitions", { workspace: "tidepool", path: "build", text: "One.\nTwo." })).status).toBe(400);
  const revised = await api(t.baseUrl, "POST", "/api/settings/memory/definitions", {
    workspace: "tidepool",
    path: "build",
    text: "Builds and tests.",
    supersedes: first.json.entry_id,
  });
  expect(revised.status).toBe(200);
  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?state=approved")).json.entries).toMatchObject([
    { id: revised.json.entry_id, kind: "definition", text: "Builds and tests.", author: { activity: "human", name: "human" } },
  ]);
});

it("POST /api/settings/memory/entries/:id/invalidate は理由コードと後継 id で無効化し、不正は 400(issue #593)", async () => {
  t = await bootTidepool();
  const old = agentKnowledge(t, "Old");
  const successor = agentKnowledge(t, "New");
  expect((await api(t.baseUrl, "POST", `/api/settings/memory/entries/${old}/invalidate`, { reason: "superseded" })).status).toBe(400);
  expect((await api(t.baseUrl, "POST", `/api/settings/memory/entries/${old}/invalidate`, { reason: "wrong" })).status).toBe(400);
  const invalidated = await api(t.baseUrl, "POST", `/api/settings/memory/entries/${old}/invalidate`, { reason: "superseded", successor_id: successor });
  expect(invalidated.status).toBe(200);
  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?state=invalidated")).json.entries).toMatchObject([
    { id: old, invalidation_reason: "superseded", successor_id: successor },
  ]);
});

it("管理MCP で Knowledge を書き、枝を定義し、一覧で読み、無効化し、rebuild できる —— approve の verb は無い(issue #593)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as any;
    return { isError: result.isError === true, json: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
  };
  try {
    const knowledge = await call("record_knowledge", {
      workspace: "tidepool",
      path: "build/tests",
      title: "Use Node 22",
      text: "Run the suite on Node 22.",
      original_title: "Node 22 を使う",
      original_text: "スイートは Node 22 で走らせる",
    });
    expect((await call("record_knowledge", { workspace: null, path: "a", title: "t", text: "x", original_text: "原文の text だけ" })).isError).toBe(true);
    const branch = await call("define_memory_branch", { workspace: null, path: "build", text: "How things are built." });
    expect((await call("define_memory_branch", { workspace: null, path: "build", text: "Again." })).isError).toBe(true);

    expect((await call("list_memory_entries", { kind: "knowledge" })).json).toMatchObject([
      {
        id: knowledge.json.entry_id,
        original: { title: "Node 22 を使う", text: "スイートは Node 22 で走らせる", language: "Japanese" },
        author: { activity: "human", name: "human" },
      },
    ]);
    expect((await call("invalidate_memory_entry", { entry_id: branch.json.entry_id, reason: "requirement_change" })).isError).toBe(false);
    expect((await call("list_memory_entries", {})).json).toMatchObject([{ id: knowledge.json.entry_id }, { id: branch.json.entry_id, invalidation_reason: "requirement_change" }]);
    expect((await call("list_memory_entries", { board_wide: true, state: "invalidated" })).json.map((e: { id: number }) => e.id)).toEqual([
      branch.json.entry_id,
    ]);

    expect((await call("rebuild_memory_index", {})).isError).toBe(false);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).filter((name) => name.includes("approve"))).toEqual([]);
  } finally {
    await client.close();
  }
});
