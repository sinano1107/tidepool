import { afterEach, expect, it, vi } from "vitest";
import { createBehaviorCandidate, defineMemoryBranch, recordKnowledge, WORKER_MEMORY_VERBS } from "../src/memory.js";
import { MEMORY_META_REVIEW_VERBS } from "../src/meta-review.js";
import { DEFAULT_AUDITOR_NAME } from "../src/tasks.js";
import { UnknownWorkspaceError } from "../src/workspace.js";
import { api, bootTidepool, GIT_FIXTURE_TEST_TIMEOUT, HOUR, makeWorkspace, mcpClient, memoryEntries, registerWork, type Tidepool } from "./harness.js";
import { makeRegistryAgentCheck } from "./registry-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** 主題 memory の meta-review 専用 verb(issue #619 / ADR 0122)。検査と一覧の中身はドメイン層
 *  (tests/memory-meta-review-writes.test.ts / tests/memory-meta-review-reads.test.ts / tests/precedent-store.test.ts)が
 *  言うので、ここは写像だけ —— 接続の task で登録が変わり、引数の scope を registry と照合し、書き手が meta_review になる。 */
let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

const body = (result: any) => JSON.parse(result.content[0].text);

const WORKER_MEMORY: string[] = [...WORKER_MEMORY_VERBS];
const META_REVIEW_MEMORY: string[] = [...MEMORY_META_REVIEW_VERBS];

/** registry に sandbox だけがある盤面と、slot に入った memory meta-review(材料の Knowledge を1件書いて poll させる)。 */
async function boardWithMetaReview(agentRegistered?: (name: string) => boolean) {
  const sandbox = await makeWorkspace("sandbox");
  t = await bootTidepool({
    workspace: sandbox,
    agentRegistered,
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

it("主題 memory の task の接続の tool 一覧は、普通の task の一覧から worker の memory verb を除き専用 verb を足したもの(Codex の enabled_tools と同じ定数)", async () => {
  const { client } = await boardWithMetaReview();
  const work = await registerWork(t, "index the tide charts");
  const workClient = await mcpClient(t.mcpBaseUrl, work.id);
  try {
    const names = async (c: typeof client) => (await c.listTools()).tools.map((tool) => tool.name);
    const metaReview = await names(client);
    const worker = await names(workClient);
    expect(worker).toEqual(expect.arrayContaining([...WORKER_MEMORY, "get_current_task", "log_decision", "complete_task"]));
    expect(worker.filter((name) => META_REVIEW_MEMORY.includes(name))).toEqual([]);
    expect(metaReview.sort()).toEqual([...worker.filter((name) => !WORKER_MEMORY.includes(name)), ...META_REVIEW_MEMORY].sort());
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
    expect(await memoryEntries(t)).toEqual([]);
  } finally {
    await client.close();
  }
});

it("直接適用4つは引数の scope(null = 盤面全体 / registry の workspace 名)に meta_review を書き手として書き、registry に無い名前は tool error", async () => {
  const { client, call, material } = await boardWithMetaReview();
  const author = { activity: "meta_review", name: DEFAULT_AUDITOR_NAME };
  try {
    const sandbox = await call("define_memory", { scope: "sandbox", path: "build", definition: "How sandbox builds." });
    const boardWide = await call("define_memory", { scope: null, path: "build", definition: "How every workspace builds.", supersedes: [sandbox.body.entry_id] });
    expect(await call("define_memory", { scope: "sandbox", path: "build", definition: "How sandbox builds now.", supersedes: [boardWide.body.entry_id] })).toMatchObject({ isError: true });
    expect(await call("define_memory", { scope: "charts", path: "build", definition: "How charts builds." })).toMatchObject({ isError: true });

    const { event_id: decision } = (await call("log_decision", { line: "the build note belongs board-wide" })).body;
    const folded = await call("fold_memory", { scope: null, path: "toolchain", title: "Node 22", text: "Use Node 22.", replaces: [material], based_on_decision: decision });
    const moved = await call("move_memory", { entry_id: folded.body.entry_id, scope: "sandbox", path: "toolchain/node" });
    expect(await call("invalidate_memory", { entry_id: boardWide.body.entry_id, reason: "requirement_change" })).toMatchObject({
      isError: false,
      body: { event_id: expect.any(Number) },
    });

    expect((await memoryEntries(t)).map((e) => [e.id, e.scope, e.author, e.invalidation_reason])).toEqual([
      [material, "sandbox", { activity: "worker_verb", name: "deckhand" }, "superseded"],
      [sandbox.body.entry_id, "sandbox", author, "superseded"],
      [boardWide.body.entry_id, null, author, "requirement_change"],
      [folded.body.entry_id, null, author, "path_moved"],
      [moved.body.entry_id, "sandbox", author, null],
    ]);
  } finally {
    await client.close();
  }
});

it("fold_memory の successor_id は既にある後継に畳んで無効化の event id を返し、invalidate_memory は superseded も後継 id も tool error で断る(ADR 0161 決定2)", async () => {
  const { client, call, material } = await boardWithMetaReview();
  const kept = recordKnowledge(
    t.db,
    { scope: "sandbox", path: "build", title: "Node 22 only", text: "Tests run on Node 22 only.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    t.clock.now(),
  ).entry_id;
  try {
    for (const args of [{ reason: "superseded", successor_id: kept }, { reason: "capability", successor_id: kept }]) {
      expect(await call("invalidate_memory", { entry_id: material, ...args })).toMatchObject({ isError: true });
    }

    const folded = await call("fold_memory", { successor_id: kept, replaces: [material] });

    expect(folded).toMatchObject({ isError: false, body: { entry_id: kept, event_ids: [expect.any(Number)] } });
  } finally {
    await client.close();
  }
});

it("define_memory の supersedes は list で、同じ scope の複数の Definition を1回で1つの新しい定義に畳み、空配列とスカラーは tool error で何も書かれない(ADR 0161 決定2)", async () => {
  const { client, call, material } = await boardWithMetaReview();
  try {
    const build = await call("define_memory", { scope: "sandbox", path: "build", definition: "How sandbox builds." });
    const toolchain = await call("define_memory", { scope: "sandbox", path: "toolchain", definition: "What toolchain sandbox uses." });

    const combined = await call("define_memory", {
      scope: "sandbox",
      path: "build-and-toolchain",
      definition: "How sandbox builds and what it uses.",
      supersedes: [build.body.entry_id, toolchain.body.entry_id],
    });
    expect(combined.isError).toBe(false);

    const rows = async () => (await memoryEntries(t)).map((e) => [e.id, e.invalidation_reason, e.successor_id]);
    const consolidated = [
      [material, null, null],
      [build.body.entry_id, "superseded", combined.body.entry_id],
      [toolchain.body.entry_id, "superseded", combined.body.entry_id],
      [combined.body.entry_id, null, null],
    ];
    expect(await rows()).toEqual(consolidated);

    expect(await call("define_memory", { scope: "sandbox", path: "empty", definition: "x", supersedes: [] })).toMatchObject({ isError: true });
    expect(await call("define_memory", { scope: "sandbox", path: "scalar", definition: "x", supersedes: build.body.entry_id })).toMatchObject({ isError: true });
    expect(await rows()).toEqual(consolidated);
  } finally {
    await client.close();
  }
});

it("invalidate_memory は cause の memory を理由コードに取らず tool error で、エントリは残る(ADR 0166 決定7)", async () => {
  const { client, call, material } = await boardWithMetaReview();
  try {
    expect(await call("invalidate_memory", { entry_id: material, reason: "memory" })).toMatchObject({ isError: true });
    expect((await memoryEntries(t)).map((e) => e.invalidation_reason)).toEqual([null]);
  } finally {
    await client.close();
  }
});

it("list_memory_entries は scope の名前 / null(盤面全体)/ 省略(すべて)を区別して渡し、読み口5つは event id を載せる", async () => {
  const { client, call, material } = await boardWithMetaReview();
  const now = t.clock.now();
  const human = { activity: "human" as const, name: "human" };
  const boardWide = defineMemoryBranch(t.db, { scope: null, path: "build", text: "How every workspace builds.", author: human }, "webui", now).entry_id;
  const shadowing = defineMemoryBranch(t.db, { scope: "sandbox", path: "build", text: "How sandbox builds.", author: human }, "webui", now).entry_id;
  try {
    const ids = async (args: Record<string, unknown>) => (await call("list_memory_entries", args)).body.entries.map((e: any) => e.id);
    expect(await ids({})).toEqual([material, boardWide, shadowing]);
    expect(await ids({ scope: null })).toEqual([boardWide]);
    expect(await ids({ scope: "sandbox", kind: "definition", page: 1 })).toEqual([shadowing]);

    for (const verb of ["list_memory_entries", "list_memory_candidates", "list_memory_behaviors", "list_memory_proposals", "list_precedents"]) {
      expect(await call(verb)).toMatchObject({ isError: false, body: { truncated: false, event_id: expect.any(Number) } });
    }
    expect((await call("list_memory_candidates", { include_invalidated: true, page: 1 })).isError).toBe(false);
    expect((await call("list_precedents", { since_watermark: 0, page: 1 })).isError).toBe(false);
  } finally {
    await client.close();
  }
});

it("consolidate の新 candidate の宛先が registry に無ければ名前つきの tool error で question は立たず、registry にある宛先・null・組み込みの auditor なら立つ(ADR 0173 決定1・2)", async () => {
  const { client, call } = await boardWithMetaReview(await makeRegistryAgentCheck());
  const candidate = { scope: "sandbox", path: "habits", title: "Split migrations", text: "Split migrations.", addressee: "deckhand" };
  try {
    const { event_id: decision } = (await call("log_decision", { line: "one rule is enough" })).body;
    // 1回ごとに置換対象の candidate を新しく作る —— open な提案 question が名指す entry は次の提案に使えない
    const consolidate = (addressee: string | null) => {
      const replaced = createBehaviorCandidate(t.db, { ...candidate, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", t.clock.now()).entry_id;
      return call("propose_memory_change", { op: "consolidate", text: { ...candidate, addressee }, replaces: [replaced], based_on_decision: decision, rationale: "Same rule." });
    };

    expect(await consolidate("deckhnad")).toEqual({ isError: true, body: "unknown agent: deckhnad" });
    for (const addressee of ["deckhand", null, DEFAULT_AUDITOR_NAME]) {
      expect(await consolidate(addressee)).toMatchObject({ isError: false, body: { question_id: expect.any(String) } });
    }
  } finally {
    await client.close();
  }
});
