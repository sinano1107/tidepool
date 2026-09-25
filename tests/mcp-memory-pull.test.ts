import { afterEach, expect, it } from "vitest";
import { approveMemoryProposal, createBehaviorCandidate, defineMemoryBranch, recordKnowledge } from "../src/memory.js";
import { logDecision } from "../src/tasks.js";
import { bootTidepool, HOUR, mcpClient, memoryEntries, registerWork, type Tidepool } from "./harness.js";

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
  const decision = logDecision(t.db, task, "kept tests on Node 22", t.worker.id, t.clock.now());
  const behavior = createBehaviorCandidate(
    t.db,
    { scope: "charts", path: "build", title: "Pin the runtime", text: "Pin the runtime version.", addressee: null, source: { event_id: decision }, author: { activity: "rca", name: "auditor" } },
    "board",
    t.clock.now(),
  ).entry_id;
  approveMemoryProposal(t.db, { kind: "memory", op: "approve", candidate_id: behavior, replaces: [] }, "question-1", "webui", t.clock.now());
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
      truncated: false,
      event_id: expect.any(Number),
    });
    expect(await call("browse_memory", { prefix: "build/tests", page: 1 })).toEqual({
      children: [],
      entries: [{ id, title: "Tests need Node 22" }],
      truncated: false,
      event_id: expect.any(Number),
    });
    expect(await call("search_memory", { query: "Node" })).toEqual({
      results: [{ id, title: "Tests need Node 22", path: "build/tests" }],
      truncated: false,
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
      event_id: expect.any(Number),
    });
    expect((await call("read_memory", { ids: [behavior] })).entries[0].case).toHaveProperty("decision", "kept tests on Node 22");
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
