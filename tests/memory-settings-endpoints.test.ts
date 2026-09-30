import { afterEach, expect, it } from "vitest";
import { DEFAULT_AUDITOR_NAME } from "../src/defaults.js";
import { defineMemoryBranch, previewCase, recordKnowledge } from "../src/memory.js";
import { logDecision, registerTask } from "../src/tasks.js";
import { FakeTranslationClient } from "./fakes.js";
import { api, bootTidepool, managementMcpClient, registryOf, type Tidepool } from "./harness.js";
import { makeRegistryAgentCheck } from "./registry-fixture.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** 人間の面の一覧を2つとも読む(GET /api/settings/memory/entries と管理MCP の list_memory_entries)。 */
async function listFromBothSurfaces(tp: Tidepool, query: Record<string, string>) {
  const http = (await api(tp.baseUrl, "GET", `/api/settings/memory/entries?${new URLSearchParams(query)}`)).json.entries;
  const client = await managementMcpClient(tp.baseUrl);
  try {
    return [http, (await toolCaller(client)("list_memory_entries", query)).json];
  } finally {
    await client.close();
  }
}

/** 管理MCP の tool を呼び、tool error か JSON の結果を返す。 */
function toolCaller(client: Awaited<ReturnType<typeof managementMcpClient>>) {
  return async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as any;
    return { isError: result.isError === true, json: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
  };
}

it("POST /api/settings/memory で書いた注入上限は GET で読め、周期の欄は無く、正の整数でない値と空の変更は 400(issue #592 / #924)", async () => {
  t = await bootTidepool();
  expect(await api(t.baseUrl, "POST", "/api/settings/memory", { injection_token_cap: 800 })).toMatchObject({
    status: 200,
    json: { injection_token_cap: 800 },
  });
  for (const bad of [0, 1.5, "900"]) {
    expect((await api(t.baseUrl, "POST", "/api/settings/memory", { injection_token_cap: bad })).status).toBe(400);
  }
  expect((await api(t.baseUrl, "POST", "/api/settings/memory", {})).status).toBe(400);
  expect((await api(t.baseUrl, "GET", "/api/settings/memory")).json).toEqual({ injection_token_cap: 800 });
});

it("管理MCP の change_memory_settings で書いた注入上限は read_memory_settings で読め(周期の欄は無い)、不正値と空の変更は拒む(issue #592 / #924)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const changed = (await client.callTool({ name: "change_memory_settings", arguments: { injection_token_cap: 1200 } })) as any;
    expect(JSON.parse(changed.content[0].text)).toEqual({ injection_token_cap: 1200 });
    const rejected = (await client.callTool({ name: "change_memory_settings", arguments: { injection_token_cap: -5 } })) as any;
    expect(rejected.isError).toBe(true);
    const empty = (await client.callTool({ name: "change_memory_settings", arguments: {} })) as any;
    expect(empty.isError).toBe(true);
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

it("POST /api/settings/memory/definitions は1行の定義を書き、supersedes の list で同じ枝を書き直す(issue #593 / ADR 0162 決定1)", async () => {
  t = await bootTidepool();
  const first = await api(t.baseUrl, "POST", "/api/settings/memory/definitions", { workspace: "tidepool", path: "build", text: "Builds." });
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/definitions", { workspace: "tidepool", path: "build", text: "One.\nTwo." })).status).toBe(400);
  const revised = await api(t.baseUrl, "POST", "/api/settings/memory/definitions", {
    workspace: "tidepool",
    path: "build",
    text: "Builds and tests.",
    supersedes: [first.json.entry_id],
  });
  expect(revised.status).toBe(200);
  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?state=approved")).json.entries).toMatchObject([
    { id: revised.json.entry_id, kind: "definition", text: "Builds and tests.", author: { activity: "human", name: "human" } },
  ]);
});

it("POST /api/settings/memory/entries/:id/invalidate は後継なしの理由コードで無効化し、superseded・path_moved(畳みと移動の口が持つ)・後継 id・不正な理由は 400(issue #593 / ADR 0161 決定4)", async () => {
  t = await bootTidepool();
  const old = agentKnowledge(t, "Old");
  const successor = agentKnowledge(t, "New");
  const invalidate = async (body: Record<string, unknown>) => (await api(t.baseUrl, "POST", `/api/settings/memory/entries/${old}/invalidate`, body)).status;
  for (const body of [{ reason: "superseded", successor_id: successor }, { reason: "path_moved", successor_id: successor }, { reason: "capability", successor_id: successor }, { reason: "wrong" }]) {
    expect(await invalidate(body)).toBe(400);
  }
  expect(await invalidate({ reason: "capability" })).toBe(200);
  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?state=invalidated")).json.entries).toMatchObject([
    { id: old, invalidation_reason: "capability", successor_id: null },
  ]);
});

it("POST /api/settings/memory/fold は replaces を既にある後継へ畳む domain に渡して無効化の event id を返し、種別の線を跨ぐ畳みは 400(ADR 0162 決定1)", async () => {
  t = await bootTidepool();
  const [a, b, kept] = [agentKnowledge(t, "A"), agentKnowledge(t, "B"), agentKnowledge(t, "Kept")];
  const branch = await api(t.baseUrl, "POST", "/api/settings/memory/definitions", { workspace: "tidepool", path: "build", text: "Builds." });

  expect((await api(t.baseUrl, "POST", "/api/settings/memory/fold", { replaces: [a], successor_id: branch.json.entry_id })).status).toBe(400);
  const folded = await api(t.baseUrl, "POST", "/api/settings/memory/fold", { replaces: [a, b], successor_id: kept });

  expect(folded).toMatchObject({ status: 200, json: { entry_id: kept, event_ids: [expect.any(Number), expect.any(Number)] } });
  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?state=invalidated")).json.entries).toMatchObject([
    { id: a, invalidation_reason: "superseded", successor_id: kept },
    { id: b, invalidation_reason: "superseded", successor_id: kept },
  ]);
});

it("管理MCP で Knowledge を書き(supersedes の list は domain に渡る)、枝を定義し、一覧で読み、既にある後継へ畳み、無効化し(superseded・path_moved・後継 id は断る)、rebuild できる —— approve の verb は無い(issue #593 / ADR 0162 決定1)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  const call = toolCaller(client);
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
    const draft = await call("record_knowledge", { workspace: "tidepool", path: "build/tests", title: "Node 22", text: "Node 22." });
    const revised = await call("record_knowledge", { workspace: "tidepool", path: "build/tests", title: "Node 22 only", text: "Node 22 only.", supersedes: [draft.json.entry_id] });
    expect((await call("record_knowledge", { workspace: null, path: "a", title: "t", text: "x", supersedes: [draft.json.entry_id] })).isError).toBe(true);
    const branch = await call("define_memory_branch", { workspace: null, path: "build", text: "How things are built." });
    expect((await call("define_memory_branch", { workspace: null, path: "build", text: "Again." })).isError).toBe(true);

    expect(await call("fold_memory_entries", { replaces: [revised.json.entry_id], successor_id: knowledge.json.entry_id })).toMatchObject({
      isError: false,
      json: { entry_id: knowledge.json.entry_id, event_ids: [expect.any(Number)] },
    });
    expect((await call("fold_memory_entries", { replaces: [knowledge.json.entry_id], successor_id: branch.json.entry_id })).isError).toBe(true);
    expect((await call("list_memory_entries", { kind: "knowledge" })).json).toMatchObject([
      {
        id: knowledge.json.entry_id,
        original: { title: "Node 22 を使う", text: "スイートは Node 22 で走らせる", language: "Japanese" },
        author: { activity: "human", name: "human" },
      },
      { id: draft.json.entry_id, invalidation_reason: "superseded", successor_id: revised.json.entry_id },
      { id: revised.json.entry_id, invalidation_reason: "superseded", successor_id: knowledge.json.entry_id },
    ]);
    for (const args of [
      { reason: "path_moved", successor_id: knowledge.json.entry_id },
      { reason: "superseded", successor_id: knowledge.json.entry_id },
      { reason: "capability", successor_id: knowledge.json.entry_id },
    ]) {
      expect((await call("invalidate_memory_entry", { entry_id: branch.json.entry_id, ...args })).isError).toBe(true);
    }
    expect((await call("invalidate_memory_entry", { entry_id: branch.json.entry_id, reason: "requirement_change" })).isError).toBe(false);
    expect((await call("list_memory_entries", { state: "invalidated" })).json.map((e: { id: number }) => e.id)).toEqual([
      draft.json.entry_id,
      revised.json.entry_id,
      branch.json.entry_id,
    ]);
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

it("POST /api/settings/memory/behaviors と管理MCP の record_behavior は Behavior を書いて supersedes の list を domain に渡し、domain error は 400 / tool error(ADR 0152 / ADR 0162 決定1)", async () => {
  t = await bootTidepool();
  const behavior = { workspace: "tidepool", path: "habits/commits", title: "Split migrations", text: "Commit schema changes on their own.", addressee: "deckhand" };
  const written = await api(t.baseUrl, "POST", "/api/settings/memory/behaviors", behavior);
  expect(written.status).toBe(200);
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/behaviors", { ...behavior, supersedes: [999] })).status).toBe(400);
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/behaviors", { ...behavior, addressee: undefined })).status).toBe(400);

  const client = await managementMcpClient(t.baseUrl);
  try {
    const edited = (await client.callTool({ name: "record_behavior", arguments: { ...behavior, addressee: null, supersedes: [written.json.entry_id] } })) as any;
    expect(edited.isError).toBeFalsy();
    // 既に superseded になった先をもう一度指すと拒否される —— supersedes が domain に届いている
    const rejected = (await client.callTool({ name: "record_behavior", arguments: { ...behavior, supersedes: [written.json.entry_id] } })) as any;
    expect(rejected.isError).toBe(true);
  } finally {
    await client.close();
  }
});

it("Exemplar の write(POST /api/settings/memory/exemplars・管理MCP の record_exemplar、supersedes の list も)と case preview(GET /api/settings/memory/cases/:event_id・preview_case)は domain の結果を返し、domain error は 400 / tool error(ADR 0153 / ADR 0162 決定1)", async () => {
  t = await bootTidepool();
  const task = registerTask(t.db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, t.clock.now());
  const decision = logDecision(t.db, task, "split the migration into two commits", "deckhand", t.clock.now());
  const exemplar = {
    workspace: "tidepool",
    path: "habits/migrations",
    title: "Split the migration",
    addressee: null,
    source_event_id: decision,
    annotations: [{ anchor: { field: "decision", quote: "two commits" }, polarity: "imitate", text: "Split schema changes from data changes." }],
  };
  const preview = previewCase(t.db, decision);

  const written = await api(t.baseUrl, "POST", "/api/settings/memory/exemplars", exemplar);
  expect(written).toMatchObject({ status: 200, json: { entry_id: expect.any(Number) } });
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/exemplars", { ...exemplar, source_event_id: 1 })).status).toBe(400);
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/exemplars", { ...exemplar, source_event_id: undefined })).status).toBe(400);
  expect(await api(t.baseUrl, "GET", `/api/settings/memory/cases/${decision}`)).toMatchObject({ status: 200, json: preview });
  expect((await api(t.baseUrl, "GET", "/api/settings/memory/cases/1")).status).toBe(400);

  const client = await managementMcpClient(t.baseUrl);
  try {
    const { source_event_id: _, ...unsourced } = exemplar;
    const recorded = (await client.callTool({ name: "record_exemplar", arguments: { ...unsourced, supersedes: [written.json.entry_id] } })) as any;
    expect(recorded.isError).toBeFalsy();
    const mismatched = { ...exemplar, annotations: [{ ...exemplar.annotations[0], anchor: { field: "decision", quote: "three commits" } }] };
    expect(((await client.callTool({ name: "record_exemplar", arguments: mismatched })) as any).isError).toBe(true);
    const previewed = (await client.callTool({ name: "preview_case", arguments: { event_id: decision } })) as any;
    expect(JSON.parse(previewed.content[0].text)).toEqual(preview);
    expect(((await client.callTool({ name: "preview_case", arguments: { event_id: 1 } })) as any).isError).toBe(true);
  } finally {
    await client.close();
  }
  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?kind=exemplar")).json.entries).toMatchObject([
    { id: written.json.entry_id, invalidation_reason: "superseded" },
    { id: expect.any(Number), source: { kind: "event", ref: decision } },
  ]);
});

it("エントリ1件と枝ごとの移動(POST /api/settings/memory/entries/:id/move・/api/settings/memory/branches/move、管理MCP の move_memory_entry・move_memory_branch)は domain に渡り、枝ごとは旧 id → 複製の id を返し、domain error は 400 / tool error(ADR 0162 決定4)", async () => {
  t = await bootTidepool();
  const one = agentKnowledge(t, "One");
  const other = agentKnowledge(t, "Other");
  const moved = await api(t.baseUrl, "POST", `/api/settings/memory/entries/${one}/move`, { workspace: null, path: "toolchain" });
  expect(moved).toMatchObject({ status: 200, json: { entry_id: expect.any(Number) } });
  expect((await api(t.baseUrl, "POST", `/api/settings/memory/entries/${one}/move`, { workspace: null, path: "elsewhere" })).status).toBe(400);
  const branch = { workspace: "tidepool", path: "build", to_workspace: "charts", to_path: "ci" };
  const branchMoved = await api(t.baseUrl, "POST", "/api/settings/memory/branches/move", branch);
  expect(branchMoved).toMatchObject({ status: 200, json: { moved: [{ entry_id: other, successor_id: expect.any(Number) }] } });
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/branches/move", branch)).status).toBe(400);

  const client = await managementMcpClient(t.baseUrl);
  const call = toolCaller(client);
  try {
    const entry = await call("move_memory_entry", { entry_id: moved.json.entry_id, workspace: "tidepool", path: "toolchain" });
    expect(entry).toMatchObject({ isError: false, json: { entry_id: expect.any(Number) } });
    expect((await call("move_memory_entry", { entry_id: moved.json.entry_id, workspace: null, path: "elsewhere" })).isError).toBe(true);
    const copied = branchMoved.json.moved[0].successor_id;
    const again = await call("move_memory_branch", { workspace: "charts", path: "ci", to_workspace: null, to_path: "build" });
    expect(again).toMatchObject({ isError: false, json: { moved: [{ entry_id: copied, successor_id: expect.any(Number) }] } });
    expect((await call("move_memory_branch", { workspace: "charts", path: "ci", to_workspace: null, to_path: "build" })).isError).toBe(true);
  } finally {
    await client.close();
  }
  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?state=approved")).json.entries.map((e: { scope: string | null; path: string }) => [e.scope, e.path])).toEqual([
    ["tidepool", "toolchain"],
    [null, "build/tests"],
  ]);
});

it("枝ごとの移動の merge は POST /api/settings/memory/branches/move と管理MCP の move_memory_branch から domain に届き、folded を返す(ADR 0177 決定8)", async () => {
  t = await bootTidepool();
  const define = (path: string) =>
    defineMemoryBranch(t.db, { scope: "tidepool", path, text: `What ${path} holds.`, author: { activity: "worker_verb", name: "deckhand" } }, "worker", t.clock.now()).entry_id;
  const [build, ci, toolchain] = ["build", "ci", "toolchain"].map(define);

  const http = await api(t.baseUrl, "POST", "/api/settings/memory/branches/move", { workspace: "tidepool", path: "build", to_workspace: "tidepool", to_path: "toolchain", merge: true });
  expect(http).toMatchObject({ status: 200, json: { moved: [], folded: [{ entry_id: build, successor_id: toolchain }] } });

  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(await toolCaller(client)("move_memory_branch", { workspace: "tidepool", path: "ci", to_workspace: "tidepool", to_path: "toolchain", merge: true })).toMatchObject({
      isError: false,
      json: { moved: [], folded: [{ entry_id: ci, successor_id: toolchain }] },
    });
  } finally {
    await client.close();
  }
});

it("POST /api/settings/memory/entries/:id/restore は無効化済みのエントリを domain に渡して複製の id を返し、domain error(生きたエントリ)は 400(ADR 0163)", async () => {
  t = await bootTidepool();
  const old = agentKnowledge(t, "Old");
  await api(t.baseUrl, "POST", `/api/settings/memory/entries/${old}/invalidate`, { reason: "capability" });

  const restored = await api(t.baseUrl, "POST", `/api/settings/memory/entries/${old}/restore`, {});
  expect(restored).toMatchObject({ status: 200, json: { entry_id: expect.any(Number) } });
  expect((await api(t.baseUrl, "POST", `/api/settings/memory/entries/${restored.json.entry_id}/restore`, {})).status).toBe(400);
  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?state=approved")).json.entries).toMatchObject([
    { id: restored.json.entry_id },
  ]);
});

it("管理MCP の restore_memory_entry は無効化済みのエントリを domain に渡して複製の id を返し、domain error(生きたエントリ)は tool error(ADR 0163)", async () => {
  t = await bootTidepool();
  const old = agentKnowledge(t, "Old");
  const client = await managementMcpClient(t.baseUrl);
  const call = toolCaller(client);
  try {
    await call("invalidate_memory_entry", { entry_id: old, reason: "capability" });
    const restored = await call("restore_memory_entry", { entry_id: old });
    expect(restored).toMatchObject({ isError: false, json: { entry_id: expect.any(Number) } });
    expect((await call("restore_memory_entry", { entry_id: restored.json.entry_id })).isError).toBe(true);
    expect((await call("list_memory_entries", { state: "approved" })).json).toMatchObject([{ id: restored.json.entry_id, title: "Old" }]);
  } finally {
    await client.close();
  }
});

it("宛先の agent や scope の workspace が registry から消えると、両方の人間の面の一覧はその行にだけ孤立の印(addressee / scope / both)を付け、無効化済みの行にも付ける(ADR 0173 決定5)", async () => {
  const agents = new Set(["deckhand", "anemone"]);
  const workspaces = new Set(["tidepool", "reef"]);
  t = await bootTidepool(registryOf(agents, workspaces));
  const behavior = async (workspace: string | null, addressee: string | null) =>
    (await api(t.baseUrl, "POST", "/api/settings/memory/behaviors", { workspace, path: "habits", title: "t", text: "x", addressee })).json.entry_id;
  const gone = await behavior("tidepool", "deckhand");
  const moved = await behavior("reef", "anemone");
  const both = await behavior("reef", "deckhand");
  const live = await behavior("tidepool", "anemone");
  const everyone = await behavior(null, null);
  await api(t.baseUrl, "POST", `/api/settings/memory/entries/${both}/invalidate`, { reason: "capability" });

  agents.delete("deckhand");
  workspaces.delete("reef");

  for (const entries of await listFromBothSurfaces(t, { kind: "behavior" })) {
    expect(entries.map((e: { id: number; orphaned: unknown }) => [e.id, e.orphaned])).toEqual([
      [gone, "addressee"],
      [moved, "scope"],
      [both, "both"],
      [live, null],
      [everyone, null],
    ]);
  }
});

it("registry の無い盤面では、両方の人間の面の一覧に孤立の印の欄そのものが無い(ADR 0173 決定5)", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/settings/memory/behaviors", { workspace: "tidepool", path: "habits", title: "t", text: "x", addressee: "deckhand" });

  for (const entries of await listFromBothSurfaces(t, {})) {
    expect(entries).toHaveLength(1);
    expect("orphaned" in entries[0]).toBe(false);
  }
});

/** 直書き4つを両方の人間の面(settings の HTTP と管理MCP)で撃ち、[HTTP, 管理MCP] の拒否の文言(通れば null)を返す。
 *  置き場の path は撃つたびに変える(定義は枝ごとに1つ)。Exemplar の出所は decision を1つ作って使う。 */
function directWriter(tp: Tidepool) {
  const task = registerTask(tp.db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, tp.clock.now());
  const decision = logDecision(tp.db, task, "split the migration", "deckhand", tp.clock.now());
  const routes = {
    knowledge: ["knowledge", "record_knowledge", { title: "t", text: "x" }],
    definition: ["definitions", "define_memory_branch", { text: "x" }],
    behavior: ["behaviors", "record_behavior", { title: "t", text: "x", addressee: null }],
    exemplar: ["exemplars", "record_exemplar", { title: "t", addressee: null, source_event_id: decision, annotations: [{ anchor: "whole", polarity: "imitate", text: "Split it." }] }],
  } as const;
  let n = 0;
  return async (kind: keyof typeof routes, ref: { workspace: string | null; addressee?: string | null }) => {
    const [route, tool, body] = routes[kind];
    const http = await api(tp.baseUrl, "POST", `/api/settings/memory/${route}`, { ...body, ...ref, path: `habits/${n++}` });
    const client = await managementMcpClient(tp.baseUrl);
    try {
      const mcp = await toolCaller(client)(tool, { ...body, ...ref, path: `habits/${n++}` });
      return [http.status === 200 ? null : http.json.error, mcp.isError ? mcp.json : null];
    } finally {
      await client.close();
    }
  };
}

it("直書き4つは両方の人間の面で registry に無い宛先・workspace を名前つきで拒み、null と registry にある名前は通す(ADR 0173 決定1)", async () => {
  t = await bootTidepool(registryOf(new Set(["deckhand"]), new Set(["tidepool"])));
  const write = directWriter(t);

  for (const kind of ["behavior", "exemplar"] as const) {
    expect(await write(kind, { workspace: "tidepool", addressee: "deckhnad" })).toEqual(["unknown agent: deckhnad", "unknown agent: deckhnad"]);
    expect(await write(kind, { workspace: "tidepool", addressee: "deckhand" })).toEqual([null, null]);
  }
  for (const kind of ["knowledge", "definition", "behavior", "exemplar"] as const) {
    expect(await write(kind, { workspace: "tidepol" })).toEqual(["unknown workspace: tidepol", "unknown workspace: tidepol"]);
    expect(await write(kind, { workspace: null })).toEqual([null, null]);
  }
});

it("registry の無い盤面では、直書き4つはどの宛先・workspace の名前も両方の人間の面で通す(ADR 0173 決定1)", async () => {
  t = await bootTidepool();
  const write = directWriter(t);

  for (const kind of ["behavior", "exemplar"] as const) {
    expect(await write(kind, { workspace: "tidepol", addressee: "deckhnad" })).toEqual([null, null]);
  }
  for (const kind of ["knowledge", "definition"] as const) {
    expect(await write(kind, { workspace: "tidepol" })).toEqual([null, null]);
  }
});

it("人間の移動(エントリ1件・枝ごと)は両方の面で registry に無い行き先の workspace を名前つきで拒み、移動元の workspace が消えた枝は生きた行き先へ移せる(ADR 0173 決定2)", async () => {
  const workspaces = new Set(["tidepool", "reef"]);
  t = await bootTidepool(registryOf(new Set(), workspaces));
  const entry = agentKnowledge(t, "One");
  const client = await managementMcpClient(t.baseUrl);
  const call = toolCaller(client);
  try {
    expect((await api(t.baseUrl, "POST", `/api/settings/memory/entries/${entry}/move`, { workspace: "reeef", path: "x" })).json.error).toBe("unknown workspace: reeef");
    expect((await call("move_memory_entry", { entry_id: entry, workspace: "reeef", path: "x" })).json).toBe("unknown workspace: reeef");
    const toTypo = { workspace: "tidepool", path: "build", to_workspace: "reeef", to_path: "ci" };
    expect((await api(t.baseUrl, "POST", "/api/settings/memory/branches/move", toTypo)).json.error).toBe("unknown workspace: reeef");
    expect((await call("move_memory_branch", toTypo)).json).toBe("unknown workspace: reeef");

    workspaces.delete("tidepool");
    expect((await call("move_memory_branch", { ...toTypo, to_workspace: "reef" })).isError).toBe(false);
    workspaces.delete("reef");
    const home = await api(t.baseUrl, "POST", "/api/settings/memory/branches/move", { workspace: "reef", path: "ci", to_workspace: null, to_path: "build" });
    expect(home.status).toBe(200);
  } finally {
    await client.close();
  }

  // registry の無い盤面は行き先の名前を照合しない
  await t.stop();
  t = await bootTidepool();
  const [one, other] = [agentKnowledge(t, "One"), agentKnowledge(t, "Other")];
  expect((await api(t.baseUrl, "POST", `/api/settings/memory/entries/${one}/move`, { workspace: "reeef", path: "x" })).status).toBe(200);
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/branches/move", { workspace: "tidepool", path: "build", to_workspace: "reeef", to_path: "ci" })).json).toEqual({
    moved: [{ entry_id: other, successor_id: expect.any(Number) }],
    folded: [],
  });
});

it("宛先の agent が消えた孤立は復元できるが、同じ宛先のままの編集は両方の面で拒まれ、生きた宛先への付け替えは通る(ADR 0173 決定3)", async () => {
  const agents = new Set(["deckhand", "anemone"]);
  t = await bootTidepool(registryOf(agents, new Set(["tidepool"])));
  const behavior = { workspace: "tidepool", path: "habits", title: "t", text: "x", addressee: "deckhand" };
  const old = (await api(t.baseUrl, "POST", "/api/settings/memory/behaviors", behavior)).json.entry_id;
  await api(t.baseUrl, "POST", `/api/settings/memory/entries/${old}/invalidate`, { reason: "capability" });
  agents.delete("deckhand");

  const restored = await api(t.baseUrl, "POST", `/api/settings/memory/entries/${old}/restore`, {});
  expect(restored).toMatchObject({ status: 200, json: { entry_id: expect.any(Number) } });
  const edit = { ...behavior, text: "y", supersedes: [restored.json.entry_id] };
  expect((await api(t.baseUrl, "POST", "/api/settings/memory/behaviors", edit)).json.error).toBe("unknown agent: deckhand");
  const client = await managementMcpClient(t.baseUrl);
  const call = toolCaller(client);
  try {
    expect((await call("record_behavior", edit)).json).toBe("unknown agent: deckhand");
    expect((await call("record_behavior", { ...edit, addressee: "anemone" })).isError).toBe(false);
  } finally {
    await client.close();
  }
});

it("組み込みの auditor は registry の合成エントリとして宛先に通る(ADR 0173 決定1)", async () => {
  t = await bootTidepool({ agentRegistered: await makeRegistryAgentCheck() });
  const write = directWriter(t);

  for (const kind of ["behavior", "exemplar"] as const) {
    expect(await write(kind, { workspace: null, addressee: DEFAULT_AUDITOR_NAME })).toEqual([null, null]);
    expect(await write(kind, { workspace: null, addressee: "ghost" })).toEqual(["unknown agent: ghost", "unknown agent: ghost"]);
  }
});
