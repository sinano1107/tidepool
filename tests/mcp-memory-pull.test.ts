import { afterEach, expect, it } from "vitest";
import { defineMemoryBranch, humanEntryInput, invalidateMemoryEntry, moveMemory, recordBehavior, recordKnowledge } from "../src/memory.js";
import { logDecision } from "../src/tasks.js";
import { bootTidepool, HOUR, mcpClient, memoryEntries, readFollowingNext, registerWork, type Tidepool } from "./harness.js";

/** worker MCP の pull 3動詞(spec #586 D / issue #591)と枝の定義(#600 E)。フィルタ・順位・event の中身は
 *  ドメイン層(tests/memory-pull.test.ts)が言うので、ここは写像だけ —— 帰属 task の
 *  workspace と agent 名で読み、応答形どおりに返し、tool 結果に event id が載る。 */
let t: Tidepool;
afterEach(() => t?.stop());

const body = (result: any) => JSON.parse(result.content[0].text);

it("browse_memory / search_memory / read_memory は attributed task の workspace で読み、応答形どおりに event id つきで返す", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts", "charts");
  const record = (scope: string, title: string) =>
    recordKnowledge(
      t.db,
      { scope, path: "build/tests", title, text: "npm test fails on Node 24.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
      "worker",
      t.clock.now(),
    ).entry_id;
  const id = record("charts", "Tests need Node 22");
  defineMemoryBranch(t.db, { scope: "charts", path: "build", text: "How charts is built.", author: { activity: "human", name: "human" } }, "webui", t.clock.now());
  record("elsewhere", "Not this workspace");
  const decision = logDecision(t.db, task, "kept tests on Node 22", t.worker.id, t.clock.now(), "worker");
  const behavior = recordBehavior(
    t.db,
    humanEntryInput(t.db, { workspace: "charts", path: "build", title: "Pin the runtime", text: "Pin the runtime version.", addressee: null, source_event_id: decision }),
    "webui",
    t.clock.now(),
  ).entry_id;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      return body(result);
    };
    expect(await call("browse_memory", {})).toEqual({
      children: [{ name: "build", definition: "How charts is built." }],
      entries: [],
      event_id: expect.any(Number),
    });
    expect(await call("browse_memory", { prefix: "build/tests" })).toEqual({
      children: [],
      entries: [{ id, title: "Tests need Node 22" }],
      event_id: expect.any(Number),
    });
    expect(await call("search_memory", { query: "Node" })).toEqual({
      results: [{ id, title: "Tests need Node 22", path: "build/tests" }],
      event_id: expect.any(Number),
    });
    expect(await call("read_memory", { ids: [id] })).toEqual({
      entries: [
        {
          id,
          title: "Tests need Node 22",
          path: "build/tests",
          text: "npm test fails on Node 24.",
          source: { kind: "commit", ref: "0a46a46" },
          source_kind: "fact",
          case: null,
        },
      ],
      dropped: [],
      event_id: expect.any(Number),
    });
    expect((await call("read_memory", { ids: [behavior] })).entries[0].case).toHaveProperty("decision", "kept tests on Node 22");
    const copy = moveMemory(t.db, { entry_id: id, scope: "charts", path: "build/node", mover: { activity: "human", name: "human" } }, "webui", t.clock.now()).entry_id;
    invalidateMemoryEntry(t.db, { entry_id: behavior, reason: "capability" }, "human", "webui", t.clock.now());
    expect(await call("read_memory", { ids: [id, behavior] })).toMatchObject({
      entries: [{ id: copy, requested_id: id }],
      dropped: [{ id: behavior, reason: "capability", successor: null }],
    });
  } finally {
    await client.close();
  }
});

it("define_memory_branch は attributed task の workspace をスコープ、worker verb + agent 名を書き手にして定義を書き、entry id と event id を返す。拒否は domain error の tool error", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts", "charts");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result = await client.callTool({ name: "define_memory_branch", arguments: { prefix: "build", definition: "How charts is built." } });
    expect(result.isError).toBeFalsy();
    const { entry_id, event_id } = body(result);
    expect(await memoryEntries(t, "?state=approved")).toMatchObject([
      { id: entry_id, version: event_id, kind: "definition", path: "build", text: "How charts is built.", scope: "charts", author: { activity: "worker_verb", name: t.worker.id } },
    ]);

    const rejected = await client.callTool({ name: "define_memory_branch", arguments: { prefix: "deploy", definition: "Two\nlines." } });
    expect(rejected.isError).toBe(true);
  } finally {
    await client.close();
  }
});

it("search_memory の description は、索引が英語だと言う(#1052)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "search_memory")?.description).toContain("Entries are searched by their English text; query in English.");
  } finally {
    await client.close();
  }
});

it("define_memory_branch の description は、盤面全体のエントリがある path とその上位は定義できず、枝の下に置くか子の枝を定義するよう言う(ADR 0178)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "define_memory_branch")?.description).toContain(
      "A path that holds whole-board entries at or under it cannot be defined for this workspace: file under the branch as it is, or define a sub-branch.",
    );
  } finally {
    await client.close();
  }
});

it("record_knowledge の description は、新しい枝を切るときは先に define_memory_branch で定義を書くよう言う", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "record_knowledge")?.description).toContain(
      "When you open a new branch, define it first with define_memory_branch",
    );
  } finally {
    await client.close();
  }
});

// 応答予算(ADR 0195 / issue #1390): 詰め方・順序・続きの memory_pulled はドメイン層が言う。ここは続き(next)が tool を通り、
// 続きの応答が読み手に届くことだけ。

it("browse_memory / search_memory / read_memory は続き(next)だけを受けて続きの応答を返し、next を追うと最初の読みの entry がすべて届く", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "index the tide charts", "charts");
  // 約2KB の本文の Knowledge が 30 件で、どの読みも予算を超える
  const ids = Array.from(
    { length: 30 },
    (_, i) =>
      recordKnowledge(
        t.db,
        { scope: "charts", path: "build/tests", title: `Note ${i} ${"y".repeat(2_000)}`, text: `${i} ${"潮".repeat(700)}`, source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
        "worker",
        t.clock.now(),
      ).entry_id,
  );
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const reads = [
      ["browse_memory", { prefix: "build/tests" }, "entries"],
      ["search_memory", { query: "Note" }, "results"],
      ["read_memory", { ids }, "entries"],
    ] as const;
    for (const [verb, args, key] of reads) {
      const responses = await readFollowingNext(client, verb, args);

      expect(responses.length, verb).toBeGreaterThan(1);
      expect(new Set(responses.flatMap((response) => response.payload[key].map((e: any) => e.id))), verb).toEqual(new Set(ids));
    }
  } finally {
    await client.close();
  }
});
