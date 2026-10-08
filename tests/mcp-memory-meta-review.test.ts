import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_AUDITOR_NAME } from "../src/defaults.js";
import { createBehaviorCandidate, defineMemoryBranch, proposeMemoryChange, recordKnowledge, WORKER_MEMORY_VERBS } from "../src/memory.js";
import { MEMORY_META_REVIEW_VERBS } from "../src/meta-review.js";
import { nextDescription } from "../src/response-budget.js";
import { registerTask } from "../src/tasks.js";
import { UnknownWorkspaceError } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  HUMAN_WEBUI,
  makeWorkspace,
  managementMcpClient,
  mcpClient,
  memoryEntries,
  RESPONSE_BUDGET_BYTES,
  readFollowingNext,
  registerWork,
  type Tidepool,
} from "./harness.js";
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

it("define_memory は重ねた木の門と畳み方・改名を言い、list_memory_entries は影に触れず path の意味を言い、list_memory_branches は枝の一覧を言い、memory meta-review の purpose は枝の一覧と path の読み方と、複数の workspace が同じ path を定義したときの畳み方と改名を言う(ADR 0178 / #1209)", async () => {
  const { review, client } = await boardWithMetaReview();
  try {
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((tool) => tool.name === name)?.description;
    expect(description("define_memory")).toContain(
      "A workspace definition is refused at a path that holds whole-board entries at or under it, and a whole-board entry is refused at or under a path a workspace defines. " +
        "To clear the way, write a whole-board definition at the workspace definition's path with supersedes, or rename the workspace branch with move_memory_branch.",
    );
    expect(description("define_memory")).not.toContain("shadow");
    expect(description("list_memory_entries")).not.toContain("shadow");
    expect(description("list_memory_entries")).toContain("path: only the entries at that branch or under it (path/…).");
    expect(description("list_memory_branches")).toBe(
      "List every branch of the board's memory in tree order: its path, the Definitions at that path (id, scope, text), and the scopes " +
        "that hold approved entries at or under it (null = the whole board). A whole-board Definition defines the branch for every scope; " +
        "a branch is undefined for a scope that holds entries under it and has neither its own Definition there nor a whole-board one. " +
        "Candidates and invalidated entries make no branch. " +
        nextDescription("list_memory_branches", "branches"),
    );
    expect(review.purpose).toContain(
      "Where a store change rewrote a Definition, read the entries under its branch with list_memory_entries (path). " +
        "The branch list shows every branch with the Definitions at its path and the scopes that hold entries under it. " +
        "For a Definition, ask whether it holds true whatever leaf sits under its branch.",
    );
    expect(review.purpose).toContain(
      "When two or more workspaces define the same path, read the definitions: fold them into one whole-board definition when they mean the same " +
        "(define_memory with scope null and supersedes), and rename one branch when they do not (move_memory_branch).",
    );
  } finally {
    await client.close();
  }
});

it("read_memory_entries は主題 memory の接続に出て管理MCP には出ず、呼ぶと行と missing を返す —— 説明は読める範囲・case・鎖のたどり・missing を言い、purpose と propose_memory_change の注釈の説明はこの verb で case を読むと言う(ADR 0122 追記 #1225)", async () => {
  const { review, client, call, material } = await boardWithMetaReview();
  const management = await managementMcpClient(t.baseUrl);
  try {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "read_memory_entries")?.description).toBe(
      "Read memory entries by id, across every scope, addressee and state: the row list_memory_entries returns, plus case for a Behavior " +
        "or Exemplar — the example it was drafted from (the decision, the steering objections raised against it, and that session's handoff " +
        "and result, or a whole session's decisions in order with the handoff and result); null when there is none. An id whose entry was " +
        "moved or restored returns the entry it now lives as, with requested_id set to the id you asked for. Any other invalidated entry comes " +
        "back as it is, text included, with its invalidation_reason and successor_id. Ids that do not exist are listed in missing. " +
        "Entries come in id order. " +
        "When the entries do not fit in one response, the response carries `next` and `remaining` (how many entries are not returned yet): " +
        "call read_memory_entries again with only `next` to read the rest, and repeat until a response carries no `next` — then the list is complete. " +
        "`missing` comes on the first response only. " +
        "An item too large for one response comes alone in pieces marked `partial` (`id`, the item's id or the key `next` resumes from; `field`, " +
        "empty when the item is itself a string; and `field_bytes`, the field's full size in UTF-8 bytes): join that field across the pieces to get it verbatim. " +
        'If the list changes under the read, the call fails with "the list changed since the first read_memory_entries call: call read_memory_entries again without next to read it from the start"; read again from the start.',
    );
    expect((await management.listTools()).tools.map((tool) => tool.name)).not.toContain("read_memory_entries");
    expect(await call("read_memory_entries", { ids: [material, 9999] })).toMatchObject({
      isError: false,
      body: { entries: [{ id: material, case: null }], missing: [9999], event_id: expect.any(Number) },
    });
    expect(review.purpose).toContain("A Precedent with cause memory names the wrong entries it followed (entries): read them with read_memory_entries, then drop");
    expect(review.purpose).toContain("Read the case of a candidate or an Exemplar — the example it was drafted from — with read_memory_entries.");
    const propose = tools.find((tool) => tool.name === "propose_memory_change")!.inputSchema as any;
    expect(propose.properties.text.properties.annotations.description).toContain("read the case with read_memory_entries");
  } finally {
    await client.close();
    await management.close();
  }
});

it("search_memory_entries は主題 memory の接続に出て、主題 routing の接続と管理MCP には出ず、呼ぶとポインタと event id を返す —— 説明は範囲・query と like・ポインタだけ・Definition を探さないことを言う(ADR 0180 決定3)", async () => {
  const { client, call, material } = await boardWithMetaReview();
  const management = await managementMcpClient(t.baseUrl);
  const routing = registerTask(
    t.db,
    { type: "review", title: "Routing meta-review", purpose: "p", completion_criteria: "c", meta_review_subject: "routing" },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
  const routingClient = await mcpClient(t.mcpBaseUrl, routing.id);
  try {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "search_memory_entries")?.description).toBe(
      "Search the board's memory across every scope and addressee: Knowledge, Behaviors and Exemplars that are live (approved or candidate) " +
        "or were dropped without a successor, with the reason. Pass query (free text; terms are OR-ed and ranked) or like (an entry id: searches " +
        "with that entry's own title and text, excluding the entry itself). Returns pointers only — read the text with read_memory_entries. " +
        "Definitions are not searched: the branch list carries them. Results come in rank order. " +
        "When the results do not fit in one response, the response carries `next` and `remaining` (how many results are not returned yet): " +
        "call search_memory_entries again with only `next` to read the rest, and repeat until a response carries no `next` — then the list is complete. " +
        "An item too large for one response comes alone in pieces marked `partial` (`id`, the item's id or the key `next` resumes from; `field`, " +
        "empty when the item is itself a string; and `field_bytes`, the field's full size in UTF-8 bytes): join that field across the pieces to get it verbatim. " +
        'If the list changes under the read, the call fails with "the list changed since the first search_memory_entries call: call search_memory_entries again without next to read it from the start"; read again from the start.',
    );
    for (const other of [management, routingClient]) {
      expect((await other.listTools()).tools.map((tool) => tool.name)).not.toContain("search_memory_entries");
    }
    const searched = await call("search_memory_entries", { query: "Node" });
    expect(searched).toMatchObject({
      isError: false,
      body: { results: [{ id: material, invalidation_reason: null }], event_id: expect.any(Number) },
    });
    expect(searched.body).not.toHaveProperty("next");
    expect(await call("search_memory_entries", { like: material })).toMatchObject({ isError: false, body: { results: [] } });
  } finally {
    await client.close();
    await management.close();
    await routingClient.close();
  }
});

it("memory meta-review の purpose は材料の節とその5つの部分を名指し、店の変更の各行を like で重複と照らして落とされたエントリの理由を読むと言い、completion_criteria は変わらない(ADR 0180)", async () => {
  const { review, client } = await boardWithMetaReview();
  try {
    expect(review.purpose).toContain(
      "This cycle's material is in your prompt, in the Memory meta-review material section: the store changes since the previous memory " +
        "meta-review, every live candidate, the decisions objected to since then, the memory proposals answered or settled since then, and the branch list.",
    );
    expect(review.purpose).toContain("search_memory_entries with like");
    expect(review.purpose).toContain("read why it was dropped (its invalidation_reason, and for a rejected candidate the human's comment in list_memory_proposals)");
    expect(review.purpose).toContain("list_memory_entries (path)");
    expect(review.purpose).not.toContain("First read the past memory proposals");
    expect(review.completion_criteria).toBe(
      "every candidate and store change since the previous meta-review is either proposed, retired, folded, moved, applied (Knowledge / Definitions), or deliberately left as is",
    );
  } finally {
    await client.close();
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
    const moved = await call("move_memory", { entry_id: folded.body.entry_id, scope: null, path: "toolchain/node" });
    expect(await call("invalidate_memory", { entry_id: boardWide.body.entry_id, reason: "requirement_change" })).toMatchObject({
      isError: false,
      body: { event_id: expect.any(Number) },
    });

    expect((await memoryEntries(t)).map((e) => [e.id, e.scope, e.author, e.invalidation_reason])).toEqual([
      [material, "sandbox", { activity: "worker_verb", name: "deckhand" }, "superseded"],
      [sandbox.body.entry_id, "sandbox", author, "superseded"],
      [boardWide.body.entry_id, null, author, "requirement_change"],
      [folded.body.entry_id, null, author, "path_moved"],
      [moved.body.entry_id, null, author, null],
    ]);
  } finally {
    await client.close();
  }
});

it("move_memory_branch は枝を to_scope の to_path へ移して件数と行き先を返し、registry に無い行き先の scope は名前つきの tool error(ADR 0176 決定1 / ADR 0173 決定2 / ADR 0195)", async () => {
  const { client, call } = await boardWithMetaReview();
  try {
    await call("define_memory", { scope: "sandbox", path: "build", definition: "How sandbox builds." });

    expect(await call("move_memory_branch", { scope: "sandbox", path: "build", to_scope: "charts", to_path: "toolchain" })).toEqual({ isError: true, body: "unknown workspace: charts" });
    const moved = await call("move_memory_branch", { scope: "sandbox", path: "build", to_scope: null, to_path: "toolchain" });

    // 移るのは material と定義の2件
    expect(moved).toEqual({ isError: false, body: { moved: 2, folded: 0, to_scope: null, to_path: "toolchain" } });
  } finally {
    await client.close();
  }
});

it("move_memory_branch の merge は domain に届き、移される定義を行き先の定義へ畳んで folded を返す(ADR 0177 決定7)", async () => {
  const { client, call } = await boardWithMetaReview();
  try {
    await call("define_memory", { scope: "sandbox", path: "build", definition: "How sandbox builds." });
    await call("define_memory", { scope: "sandbox", path: "toolchain", definition: "What toolchain sandbox uses." });

    // material は移り、build の定義は toolchain の定義へ畳まれる
    expect(await call("move_memory_branch", { scope: "sandbox", path: "build", to_scope: "sandbox", to_path: "toolchain", merge: true })).toEqual({
      isError: false,
      body: { moved: 1, folded: 1, to_scope: "sandbox", to_path: "toolchain" },
    });
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

it("define_memory の supersedes は list で、同じ path の複数の Definition(複数の workspace)を1回で1つの新しい定義に畳み、空配列とスカラーは tool error で何も書かれない(ADR 0161 決定2)", async () => {
  const { client, call, material } = await boardWithMetaReview();
  try {
    const build = await call("define_memory", { scope: "sandbox", path: "build", definition: "How sandbox builds." });
    // setup のみ: registry に無い workspace の定義(門は registry を見ない)
    const other = defineMemoryBranch(t.db, { scope: "lagoon", path: "build", text: "How lagoon builds.", author: { activity: "human", name: "human" } }, "webui", t.clock.now()).entry_id;

    const combined = await call("define_memory", {
      scope: null,
      path: "build",
      definition: "How every workspace, sandbox included, builds.",
      supersedes: [build.body.entry_id, other],
    });
    expect(combined.isError).toBe(false);

    const rows = async () => (await memoryEntries(t)).map((e) => [e.id, e.invalidation_reason, e.successor_id]);
    const consolidated = [
      [material, null, null],
      [build.body.entry_id, "superseded", combined.body.entry_id],
      [other, "superseded", combined.body.entry_id],
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

it("read_memory_entries と件数で切っていた読み口は続き(next)だけを受けて続きの応答を返し、next を追うと最初の読みの行がすべて届く(写像。詰め方・順序・続きの memory_pulled はドメイン層、ADR 0195)", async () => {
  const { review, client, material } = await boardWithMetaReview();
  const candidates = Array.from(
    { length: 20 },
    (_, i) =>
      createBehaviorCandidate(
        t.db,
        { scope: null, path: "habits", title: `tide ${i} ${"y".repeat(2_000)}`, text: "z".repeat(2_000), addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
        "worker",
        t.clock.now(),
      ).entry_id,
  );
  const proposed: string[] = [];
  for (const candidate_id of candidates) {
    const { question_id } = proposeMemoryChange(t.db, review.id, { op: "approve", candidate_id, rationale: "r" }, "auditor", t.clock.now());
    expect((await api(t.baseUrl, "POST", `/api/tasks/${question_id}/answer`, { answers: ["reject"], comment: "c".repeat(2_000) })).status).toBe(200);
    proposed.push(question_id);
  }
  try {
    const reads: Array<[string, Record<string, unknown>, string, string, unknown[]]> = [
      ["read_memory_entries", { ids: candidates }, "entries", "id", candidates],
      ["list_memory_candidates", { include_invalidated: true }, "entries", "id", candidates],
      ["list_memory_entries", {}, "entries", "id", [material, ...candidates]],
      ["list_memory_proposals", {}, "proposals", "question_id", proposed],
      ["search_memory_entries", { query: "tide" }, "results", "id", candidates],
    ];
    for (const [verb, args, key, id, expected] of reads) {
      const responses = await readFollowingNext(client, verb, args);

      expect(responses.length, verb).toBeGreaterThan(1);
      expect(new Set(responses.flatMap((response) => response.payload[key].map((row: any) => row[id]))), verb).toEqual(new Set(expected));
    }
  } finally {
    await client.close();
  }
});

it("list_memory_branches は予算を超える木を続き(next)で返し、各応答は予算内で床に落ちず(床の目印が付けば本文が JSON でなくなり readFollowingNext が落ちる)、next を追うと全枝が届く(写像。詰め方・memory_pulled はドメイン層、ADR 0195)", async () => {
  const { client } = await boardWithMetaReview();
  const paths = Array.from({ length: 60 }, (_, i) => `tide/b${String(i).padStart(2, "0")}`);
  for (const path of paths) defineMemoryBranch(t.db, { scope: null, path, text: "y".repeat(1_000), author: { activity: "human", name: "human" } }, "webui", t.clock.now());
  try {
    const responses = await readFollowingNext(client, "list_memory_branches");

    expect(responses.length).toBeGreaterThan(1);
    for (const response of responses) expect(response.bytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    expect(responses.flatMap((r) => r.payload.branches.map((row: any) => row.path))).toEqual(["build", "tide", ...paths]);
  } finally {
    await client.close();
  }
});

it("list_memory_entries は scope の名前 / null(盤面全体)/ 省略(すべて)を区別して渡して path も渡し、読み口5つは event id を載せる", async () => {
  const { client, call, material } = await boardWithMetaReview();
  const now = t.clock.now();
  const human = { activity: "human" as const, name: "human" };
  const boardWide = defineMemoryBranch(t.db, { scope: null, path: "deploy", text: "How every workspace deploys.", author: human }, "webui", now).entry_id;
  const sandboxDefinition = defineMemoryBranch(t.db, { scope: "sandbox", path: "build", text: "How sandbox builds.", author: human }, "webui", now).entry_id;
  try {
    const ids = async (args: Record<string, unknown>) => (await call("list_memory_entries", args)).body.entries.map((e: any) => e.id);
    expect(await ids({})).toEqual([material, boardWide, sandboxDefinition]);
    expect(await ids({ scope: null })).toEqual([boardWide]);
    expect(await ids({ scope: "sandbox", kind: "definition" })).toEqual([sandboxDefinition]);
    expect(await ids({ path: "deploy" })).toEqual([boardWide]);

    for (const verb of ["list_memory_entries", "list_memory_candidates", "list_memory_proposals", "list_precedents"]) {
      const listed = await call(verb);
      expect(listed).toMatchObject({ isError: false, body: { event_id: expect.any(Number) } });
      expect(listed.body).not.toHaveProperty("next");
    }
    expect(await call("list_memory_branches")).toMatchObject({ isError: false, body: { branches: expect.any(Array), event_id: expect.any(Number) } });
    expect((await call("list_memory_candidates", { include_invalidated: true })).isError).toBe(false);
    expect((await call("list_precedents", { since_watermark: 0 })).isError).toBe(false);
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
