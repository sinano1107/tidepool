import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { defineMemoryBranch, listMemoryEntries, recordKnowledge } from "../src/memory.js";
import { DEFAULT_AUDITOR_NAME } from "../src/tasks.js";
import { UnknownWorkspaceError } from "../src/workspace.js";
import { api, bootTidepool, HOUR, makeWorkspace, mcpClient, registerWork, type Tidepool } from "./harness.js";

/** 主題 memory の meta-review 専用 verb(issue #619 / ADR 0122)。検査と一覧の中身はドメイン層
 *  (tests/memory-meta-review-writes.test.ts / tests/memory-meta-review-reads.test.ts / tests/precedent-store.test.ts)が
 *  言うので、ここは写像だけ —— 接続の task で登録が変わり、引数の scope を registry と照合し、書き手が meta_review になる。 */
let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const body = (result: any) => JSON.parse(result.content[0].text);

const WORKER_MEMORY = ["record_knowledge", "define_memory_branch", "browse_memory", "search_memory", "read_memory"];
const META_REVIEW_MEMORY = [
  "list_memory_candidates",
  "list_memory_behaviors",
  "list_precedents",
  "list_memory_entries",
  "define_memory",
  "fold_memory",
  "move_memory",
  "invalidate_memory",
];

/** registry に sandbox だけがある盤面と、slot に入った memory meta-review(材料の Knowledge を1件書いて poll させる)。 */
async function boardWithMetaReview() {
  const sandbox = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: sandbox,
    resolveWorkspace: (name) => {
      if ((name ?? "sandbox") !== "sandbox") throw new UnknownWorkspaceError(name!);
      return sandbox;
    },
  });
  const material = recordKnowledge(
    t.db,
    { scope: "sandbox", path: "build", title: "Tests need Node 22", text: "Tests need Node 22.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    t.clock.now(),
  ).entry_id;
  await t.clock.advance(HOUR);
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const review = tasks.find((task) => task.meta_review_subject === "memory");
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, body: result.isError ? (result.content as any)[0].text : body(result) };
  };
  return { review, client, call, material };
}

it("主題 memory の task の接続には専用 verb が登録され worker の memory verb は無く、普通の task の接続はその逆。memory 系でない worker verb は両方に残る", async () => {
  const { client } = await boardWithMetaReview();
  const work = await registerWork(t, "index the tide charts");
  const workClient = await mcpClient(t.mcpBaseUrl, work.id);
  try {
    const names = async (c: typeof client) => (await c.listTools()).tools.map((tool) => tool.name);
    const metaReview = await names(client);
    const worker = await names(workClient);
    expect(metaReview).toEqual(expect.arrayContaining([...META_REVIEW_MEMORY, "get_current_task", "list_agents", "complete_task", "log_decision", "decompose", "escalate"]));
    expect(metaReview.filter((name) => WORKER_MEMORY.includes(name))).toEqual([]);
    expect(worker).toEqual(expect.arrayContaining([...WORKER_MEMORY, "get_current_task", "list_agents", "complete_task", "log_decision", "decompose", "escalate"]));
    expect(worker.filter((name) => META_REVIEW_MEMORY.includes(name))).toEqual([]);
  } finally {
    await client.close();
    await workClient.close();
  }
});

it("主題外の task から専用 verb を呼ぶと tool error で、何も書かれない", async () => {
  t = await bootTidepool();
  const work = await registerWork(t, "index the tide charts");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, work.id);
  try {
    const result = await client.callTool({ name: "define_memory", arguments: { scope: null, path: "build", definition: "How it builds." } });
    expect(result.isError).toBe(true);
    expect(listMemoryEntries(t.db, {})).toEqual([]);
  } finally {
    await client.close();
  }
});

it("直接適用4つは引数の scope(null = 盤面全体 / registry の workspace 名)に meta_review を書き手として書き、registry に無い名前は tool error", async () => {
  const { client, call, material } = await boardWithMetaReview();
  const author = { activity: "meta_review", name: DEFAULT_AUDITOR_NAME };
  try {
    const boardWide = await call("define_memory", { scope: null, path: "build", definition: "How every workspace builds." });
    const revised = await call("define_memory", { scope: "sandbox", path: "build", definition: "How sandbox builds.", supersedes: boardWide.body.entry_id });
    expect(await call("define_memory", { scope: "charts", path: "build", definition: "How charts builds." })).toMatchObject({ isError: true });

    const { event_id: decision } = (await call("log_decision", { line: "the build note belongs board-wide" })).body;
    const folded = await call("fold_memory", { scope: null, path: "toolchain", title: "Node 22", text: "Use Node 22.", replaces: [material], based_on_decision: decision });
    const moved = await call("move_memory", { entry_id: folded.body.entry_id, scope: "sandbox", path: "toolchain/node" });
    expect(await call("move_memory", { entry_id: moved.body.entry_id, scope: "charts", path: "toolchain" })).toMatchObject({ isError: true });
    const invalidated = await call("invalidate_memory", { entry_id: revised.body.entry_id, reason: "requirement_change" });
    expect(invalidated).toMatchObject({ isError: false, body: { event_id: expect.any(Number) } });
    expect(await call("invalidate_memory", { entry_id: moved.body.entry_id, reason: "path_moved", successor_id: material })).toMatchObject({ isError: true });

    expect(listMemoryEntries(t.db, {}).map((e) => [e.id, e.kind, e.scope, e.path, e.author, e.invalidation_reason, e.successor_id])).toEqual([
      [material, "knowledge", "sandbox", "build", { activity: "worker_verb", name: "deckhand" }, "superseded", folded.body.entry_id],
      [boardWide.body.entry_id, "definition", null, "build", author, "superseded", revised.body.entry_id],
      [revised.body.entry_id, "definition", "sandbox", "build", author, "requirement_change", null],
      [folded.body.entry_id, "knowledge", null, "toolchain", author, "path_moved", moved.body.entry_id],
      [moved.body.entry_id, "knowledge", "sandbox", "toolchain/node", author, null, null],
    ]);
  } finally {
    await client.close();
  }
});

it("list_memory_entries は scope(名前 / null = 盤面全体 / 省略 = すべて)・種別・状態で絞った一覧を影に入った定義と無効化済みごと返し、読み口4つは event id を載せる", async () => {
  const { client, call, material } = await boardWithMetaReview();
  const now = t.clock.now();
  const human = { activity: "human" as const, name: "human" };
  const boardWide = defineMemoryBranch(t.db, { scope: null, path: "build", text: "How every workspace builds.", author: human }, "webui", now).entry_id;
  const shadowing = defineMemoryBranch(t.db, { scope: "sandbox", path: "build", text: "How sandbox builds.", author: human }, "webui", now).entry_id;
  try {
    const ids = async (args: Record<string, unknown>) => (await call("list_memory_entries", args)).body.entries.map((e: any) => e.id);
    expect(await ids({})).toEqual([material, boardWide, shadowing]);
    expect(await ids({ scope: null })).toEqual([boardWide]);
    expect(await ids({ scope: "sandbox", kind: "definition", state: "approved", page: 1 })).toEqual([shadowing]);
    await call("invalidate_memory", { entry_id: material, reason: "environment" });
    expect(await ids({ state: "invalidated" })).toEqual([material]);

    for (const verb of ["list_memory_entries", "list_memory_candidates", "list_memory_behaviors", "list_precedents"]) {
      expect(await call(verb)).toMatchObject({ isError: false, body: { truncated: false, event_id: expect.any(Number) } });
    }
    expect((await call("list_memory_candidates", { include_invalidated: true, page: 1 })).isError).toBe(false);
    expect((await call("list_precedents", { since_watermark: 0, page: 1 })).isError).toBe(false);
  } finally {
    await client.close();
  }
});
