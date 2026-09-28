import { afterEach, expect, it } from "vitest";
import { previewCase, recordKnowledge } from "../src/memory.js";
import { logDecision, registerTask } from "../src/tasks.js";
import { FakeTranslationClient } from "./fakes.js";
import { api, bootTidepool, commit, HOUR, KEEP_FIXTURES, managementMcpClient, objectedForDraft, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

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

// 撃ち直しの打ち切りと Retry / Dismiss(ADR 0164 決定5 / issue #1066)

const halted = async (t: Tidepool) => (await api(t.baseUrl, "GET", "/api/settings/memory/halted-refires")).json.halted;

const taskEvents = async (t: Tidepool, taskId: string, kind: string) =>
  (await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.filter((e: any) => e.kind === kind);

/** 起草を3回撃って失敗させる(commit の1回 + 1時間後の tick 2回)。 */
async function draftHalted(title: string) {
  const s = await objectedForDraft(title, { initial: { cause: "preference", evidence: "taste" } });
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(s.t, s.task.id, title);
  await s.t.clock.advance(HOUR);
  await s.t.clock.advance(HOUR);
  const [attribution] = await taskEvents(s.t, s.task.id, "objection_attributed");
  return { ...s, attribution };
}

it("起草が撃って3回失敗すると、settings の一覧と管理MCP の一覧に同じ行が出る(2回ではまだ出ない)", async () => {
  const s = await objectedForDraft("hopeless", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "hopeless");
  await t.clock.advance(HOUR);
  expect(await halted(t)).toEqual([]);

  await t.clock.advance(HOUR);

  const [attribution] = await taskEvents(t, s.task.id, "objection_attributed");
  const [, , last] = await taskEvents(t, s.task.id, "memory_draft_failed");
  const rows = await halted(t);
  expect(rows).toEqual([
    {
      refire: "draft",
      target: attribution.id,
      entry: { id: s.entry.id, text: "skipped the fixtures" },
      task: { id: s.task.id, title: "hopeless" },
      cause: "preference",
      round: "initial",
      last_failure: { reason: "claude CLI timed out", at: last.created_at },
    },
  ]);
  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(await toolCaller(client)("list_halted_refires", {})).toEqual({ isError: false, json: { halted: rows } });
  } finally {
    await client.close();
  }
});

it("第2回の帰責が撃って3回失敗すると両方の一覧に出て、管理MCP の Dismiss で消え、以後の tick では撃たれず、Dismiss は人間の event に残る", async () => {
  const s = await objectedForDraft("flaky-rca");
  t = s.t;
  const { self, auditor } = await commit(t, s.task.id, "flaky-rca");
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));
  await api(t.baseUrl, "POST", `/api/tasks/${self.id}/cancel`, {});
  await api(t.baseUrl, "POST", `/api/tasks/${auditor.id}/cancel`, {});
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  const [, , last] = await taskEvents(t, s.task.id, "objection_attribution_failed");
  const row = {
    refire: "second_round",
    target: s.entry.id,
    entry: { id: s.entry.id, text: "skipped the fixtures" },
    task: { id: s.task.id, title: "flaky-rca" },
    cause: "uncertain",
    round: "after_rca",
    last_failure: { reason: "Board call failed: claude CLI timed out", at: last.created_at },
  };
  expect(await halted(t)).toEqual([row]);
  const client = await managementMcpClient(t.baseUrl);
  try {
    const call = toolCaller(client);
    expect(await call("list_halted_refires", {})).toEqual({ isError: false, json: { halted: [row] } });

    expect(await call("dismiss_halted_refire", { refire: "second_round", target: s.entry.id })).toEqual({ isError: false, json: { event_id: expect.any(Number) } });
    expect(await call("list_halted_refires", {})).toEqual({ isError: false, json: { halted: [] } });
  } finally {
    await client.close();
  }
  expect(await halted(t)).toEqual([]);
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the RCA decided it" });
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  expect(s.attributionClient.calls).toHaveLength(4);
  expect((await taskEvents(t, s.task.id, "refire_dismissed")).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    ["human", "mcp", { kind: "refire_dismissed", refire: "second_round", target: s.entry.id }],
  ]);
});

it("POST .../retry で打ち切りの起草はすぐ次の poll で撃たれ、失敗はもう3回まで数え直す。管理MCP の Retry で撃った起草が成功すると candidate が載って一覧から消え、以後の Retry / Dismiss は 400", async () => {
  const s = await draftHalted("retried");
  t = s.t;

  const retried = await api(t.baseUrl, "POST", `/api/settings/memory/halted-refires/draft/${s.attribution.id}/retry`);
  expect(retried).toEqual({ status: 200, json: { event_id: expect.any(Number) } });
  expect(await halted(t)).toEqual([]);
  await registerWork(t, "a pickup trigger");
  expect(s.behaviorDraftClient.calls).toHaveLength(4);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect(s.behaviorDraftClient.calls).toHaveLength(6);
  expect(await halted(t)).toEqual([expect.objectContaining({ refire: "draft", target: s.attribution.id })]);

  s.behaviorDraftClient.scriptDraft(s.entry.id, KEEP_FIXTURES);
  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(await toolCaller(client)("retry_halted_refire", { refire: "draft", target: s.attribution.id })).toEqual({ isError: false, json: { event_id: expect.any(Number) } });
  } finally {
    await client.close();
  }
  await registerWork(t, "another pickup trigger");

  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?kind=behavior")).json.entries).toEqual([
    expect.objectContaining({ state: "candidate", source: { kind: "event", ref: s.attribution.id } }),
  ]);
  expect(await halted(t)).toEqual([]);
  expect((await taskEvents(t, s.task.id, "refire_retried")).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    ["human", "webui", { kind: "refire_retried", refire: "draft", target: s.attribution.id }],
    ["human", "mcp", { kind: "refire_retried", refire: "draft", target: s.attribution.id }],
  ]);
  // 撃ち直しが成功して candidate のある起草は打ち切りでない
  for (const verb of ["retry", "dismiss"]) {
    expect((await api(t.baseUrl, "POST", `/api/settings/memory/halted-refires/draft/${s.attribution.id}/${verb}`)).status).toBe(400);
  }
});

it("打ち切りでない件への Retry / Dismiss は 400 / tool error: 3回未満の失敗・Retry 直後・Dismiss 済みへの Dismiss と Retry", async () => {
  const s = await draftHalted("refused");
  t = s.t;
  const post = async (verb: "retry" | "dismiss", key: { refire: string; target: number }) =>
    (await api(t.baseUrl, "POST", `/api/settings/memory/halted-refires/${key.refire}/${key.target}/${verb}`)).status;
  const draft = { refire: "draft", target: s.attribution.id };
  const client = await managementMcpClient(t.baseUrl);
  try {
    // 第2回を撃ったことのない entry(3回未満)。管理MCP では tool error(対応づけはこの1件で見る)
    const neverFired = { refire: "second_round", target: s.entry.id };
    expect([await post("retry", neverFired), await post("dismiss", neverFired)]).toEqual([400, 400]);
    expect((await toolCaller(client)("retry_halted_refire", neverFired)).isError).toBe(true);
  } finally {
    await client.close();
  }

  expect(await post("retry", draft)).toBe(200);
  // Retry の後はまだ1回も失敗していない
  expect([await post("retry", draft), await post("dismiss", draft)]).toEqual([400, 400]);

  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect(await post("dismiss", draft)).toBe(200);
  expect([await post("dismiss", draft), await post("retry", draft)]).toEqual([400, 400]);
});
