import { afterEach, expect, it } from "vitest";
import { approveMemoryProposal, createBehaviorCandidate, defineMemoryBranch, recordKnowledge } from "../src/memory.js";
import { api, bootTidepool, completeViaMcp, HOUR, mcpClient, memoryEntries, type Tidepool } from "./harness.js";

/** 提案 question の扉(issue #620・#621 / ADR 0120 決定3・4): meta-review の提案 verb、付帯子としての question、回答での適用、
 *  pin の陳腐化。承認の transaction と再生はドメイン層(tests/memory.test.ts)が言う。 */
let t: Tidepool;
afterEach(() => t?.stop());

function candidate(tp: Tidepool, title: string, scope: string | null = null): number {
  return createBehaviorCandidate(
    tp.db,
    {
      scope,
      path: "habits/commits",
      title,
      text: `${title}, always.`,
      addressee: "deckhand",
      source: { commit: "0a46a46" },
      author: { activity: "rca", name: "auditor" },
    },
    "worker",
    tp.clock.now(),
  ).entry_id;
}

/** candidate を材料に poll させ、slot に入った memory meta-review の接続を返す。 */
async function boardWithMetaReview(titles = ["Keep migrations in their own commit"]) {
  t = await bootTidepool();
  const ids = titles.map((title) => candidate(t, title));
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.meta_review_subject === "memory");
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result: any = await client.callTool({ name, arguments: args });
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  const propose = async (candidate_id: number) =>
    (await call("propose_memory_change", { op: "approve", candidate_id, rationale: "Three RCAs asked for the same split." })).question_id as string;
  return { review, ids, client, call, propose };
}

const task = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json;
const events = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[];
const answer = (id: string, option: string) => api(t.baseUrl, "POST", `/api/tasks/${id}/answer`, { answers: [option] });
const entry = async (id: number) => (await memoryEntries(t)).find((e) => e.id === id);

it("approve の提案は meta-review の子に1 item の question を立て、pin を question_proposal に焼き、detail に新本文・宛先・path・scope を載せる", async () => {
  const { review, ids, client, propose } = await boardWithMetaReview();
  try {
    const questionId = await propose(ids[0]!);

    const question = await task(questionId);
    expect(question).toMatchObject({
      type: "question",
      status: "todo",
      parent_id: review.id,
      purpose: "Three RCAs asked for the same split.",
      question_proposal: { kind: "memory", op: "approve", candidate_id: ids[0], replaces: [] },
      question_items: [{ options: ["approve", "reject"], recommendation: "approve" }],
    });
    expect(question.question_items).toHaveLength(1);
    const { detail } = question.question_items[0];
    for (const shown of ["Keep migrations in their own commit, always.", "deckhand", "habits/commits", "whole board"]) {
      expect(detail).toContain(shown);
    }
  } finally {
    await client.close();
  }
});

it("提案 question が open でも meta-review は完了できる", async () => {
  const { review, ids, client, propose } = await boardWithMetaReview();
  try {
    const questionId = await propose(ids[0]!);

    expect((await completeViaMcp(t, review.id, false)).isError).not.toBe(true);
    expect(await task(review.id)).toMatchObject({ status: "done" });
    expect(await task(questionId)).toMatchObject({ status: "todo" });
  } finally {
    await client.close();
  }
});

it("approve の回答で candidate が approved になって Behavior の pull に届き、選択肢外の回答は拒否される", async () => {
  const { ids, client, call, propose } = await boardWithMetaReview();
  try {
    const questionId = await propose(ids[0]!);

    expect((await answer(questionId, "approve it")).status).toBe(409);
    expect(await entry(ids[0]!)).toMatchObject({ state: "candidate" });

    expect((await answer(questionId, "approve")).status).toBe(200);
    expect(await entry(ids[0]!)).toMatchObject({ state: "approved", invalidation_reason: null });
    expect((await call("list_memory_behaviors", {})).entries.map((e: any) => e.id)).toEqual([ids[0]]);
  } finally {
    await client.close();
  }
});

it("同じ candidate への2本目の提案は断られる —— 1本目の承認は無効化でないので、2本目は陳腐化で決着しない", async () => {
  const { ids, client, call, propose } = await boardWithMetaReview();
  try {
    await propose(ids[0]!);

    expect(await call("propose_memory_change", { op: "approve", candidate_id: ids[0], rationale: "again" })).toMatchObject({
      error: expect.stringContaining("already in an open proposal question"),
    });
  } finally {
    await client.close();
  }
});

it("pin が古い提案への回答は approve も reject も拒否され何も残らない", async () => {
  const { ids, client, propose } = await boardWithMetaReview();
  try {
    const questionId = await propose(ids[0]!);
    approveMemoryProposal(t.db, (await task(questionId)).question_proposal, "elsewhere", "webui", t.clock.now());
    const approved = await entry(ids[0]!);

    for (const option of ["approve", "reject"]) expect((await answer(questionId, option)).status).toBe(409);

    expect(await task(questionId)).toMatchObject({ status: "todo", question_answer: null });
    expect((await events(questionId)).map((e) => e.kind)).toEqual(["task_registered"]);
    expect(await entry(ids[0]!)).toEqual(approved);
  } finally {
    await client.close();
  }
});

it("reject の回答は reject の export に届き(candidate が rejected)、答えた question 自身は陳腐化で決着せず、無効化は次の meta-review の材料にならない", async () => {
  const { review, ids, client, propose } = await boardWithMetaReview();
  try {
    const questionId = await propose(ids[0]!);

    expect((await answer(questionId, "reject")).status).toBe(200);

    expect(await entry(ids[0]!)).toMatchObject({ invalidation_reason: "rejected" });
    expect((await events(questionId)).map((e) => e.kind)).toEqual(["task_registered", "question_answered"]);
    // 無効化は回答の印を持ち、周期が過ぎても次の memory meta-review を登録しない(ADR 0151)
    expect((await completeViaMcp(t, review.id, false)).isError).not.toBe(true);
    await t.clock.advance(8 * 24 * HOUR); // 既定の周期(7日)を越える
    expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.meta_review_subject === "memory")).toEqual([]);
  } finally {
    await client.close();
  }
});

it("pin の entry が人間・meta-review・superseded のどの経路で無効化されても、open な提案 question は観測で決着し memory_proposal_stale が残る", async () => {
  const { ids, client, call, propose } = await boardWithMetaReview(["first rule", "second rule", "successor rule", "superseded rule"]);
  const [byHuman, byMetaReview, successor, superseded] = ids as [number, number, number, number];
  try {
    const questions = [await propose(byHuman), await propose(byMetaReview), await propose(superseded)];
    expect((await answer(await propose(successor), "approve")).status).toBe(200);

    const observed = [
      (await api(t.baseUrl, "POST", `/api/settings/memory/entries/${byHuman}/invalidate`, { reason: "requirement_change" })).json.event_id,
      (await call("invalidate_memory", { entry_id: byMetaReview, reason: "capability" })).event_id,
      (await call("invalidate_memory", { entry_id: superseded, reason: "superseded", successor_id: successor })).event_id,
    ];

    for (const [i, entryId] of [byHuman, byMetaReview, superseded].entries()) {
      expect(await task(questions[i]!)).toMatchObject({ status: "done", question_answer: null });
      expect((await events(questions[i]!)).map((e) => [e.kind, e.worker_id, e.payload])).toEqual([
        ["task_registered", expect.any(String), expect.anything()],
        ["memory_proposal_stale", "tidepool", { kind: "memory_proposal_stale", question_id: questions[i], entry_id: entryId, observed_event_id: observed[i] }],
      ]);
    }
  } finally {
    await client.close();
  }
});

/** 統合・無効化の提案(issue #621)。approved の Behavior は approve の提案と回答で作る。 */
async function approvedBehavior(board: Awaited<ReturnType<typeof boardWithMetaReview>>, title: string, scope: string | null = null) {
  const id = candidate(t, title, scope);
  expect((await answer(await board.propose(id), "approve")).status).toBe(200);
  return id;
}

async function consolidate(board: Awaited<ReturnType<typeof boardWithMetaReview>>, replaces: number[], based_on_decision?: number) {
  const decision = based_on_decision ?? (await board.call("log_decision", { line: "the split rules say the same thing" })).event_id;
  return board.call("propose_memory_change", {
    op: "consolidate",
    text: { scope: null, path: "habits/commits", title: "One concern per commit", text: "Keep each commit to one concern.", addressee: null },
    replaces,
    based_on_decision: decision,
    rationale: "Two workspaces grew the same rule.",
  });
}

it("consolidate の提案は meta_review 名義・decision 出所の新 candidate を作り、その id と replaces の pin を焼き、detail に置換対象の id と本文 → 新本文・宛先・path・scope を載せる", async () => {
  const board = await boardWithMetaReview();
  try {
    const approved = await approvedBehavior(board, "Split migrations", "tidepool");
    const approvedVersion = (await entry(approved)).version;

    const { question_id } = await consolidate(board, [approved, board.ids[0]!]);

    const question = await task(question_id);
    const candidateId = question.question_proposal.candidate_id;
    expect(question.question_proposal).toEqual({
      kind: "memory",
      op: "consolidate",
      candidate_id: candidateId,
      replaces: [
        { id: approved, version: approvedVersion },
        { id: board.ids[0], version: null },
      ],
    });
    expect(await entry(candidateId)).toMatchObject({
      kind: "behavior",
      state: "candidate",
      scope: null,
      addressee: null,
      author: { activity: "meta_review" },
      source: { kind: "decision" },
    });
    const { detail } = question.question_items[0];
    for (const shown of [`#${approved} (scope: tidepool, addressee: deckhand)`, "Split migrations, always.", `#${board.ids[0]}`, "Keep migrations in their own commit, always.", "Keep each commit to one concern.", "every agent", "habits/commits", "whole board"]) {
      expect(detail).toContain(shown);
    }
  } finally {
    await board.client.close();
  }
});

const invalidate = (board: Awaited<ReturnType<typeof boardWithMetaReview>>, target_id: number, reason = "environment") =>
  board.call("propose_memory_change", { op: "invalidate", target_id, reason, rationale: "The CI no longer squashes commits." });

it("invalidate の提案は target の pin と理由コードを焼き、detail に target の id・本文・scope・path・宛先と理由を載せる", async () => {
  const board = await boardWithMetaReview();
  try {
    const target = await approvedBehavior(board, "Split migrations", "tidepool");

    const { question_id } = await invalidate(board, target);

    const question = await task(question_id);
    expect(question).toMatchObject({
      parent_id: board.review.id,
      purpose: "The CI no longer squashes commits.",
      question_proposal: { kind: "memory", op: "invalidate", target: { id: target, version: (await entry(target)).version }, reason: "environment", replaces: [] },
      question_items: [{ options: ["approve", "reject"], recommendation: "approve" }],
    });
    const { detail } = question.question_items[0];
    for (const shown of [`#${target}`, "Split migrations, always.", "tidepool", "habits/commits", "deckhand", "environment"]) {
      expect(detail).toContain(shown);
    }
  } finally {
    await board.client.close();
  }
});

it("consolidate の回答は reject で新 candidate を rejected にして approved 集合を変えず、approve で approved 集合を新 entry だけにする", async () => {
  const board = await boardWithMetaReview(["Keep migrations in their own commit", "Split schema changes"]);
  try {
    const approved = await approvedBehavior(board, "Split migrations", "tidepool");
    const rejected = (await task((await consolidate(board, [approved, board.ids[0]!])).question_id));
    const behaviors = async () => (await board.call("list_memory_behaviors", {})).entries.map((e: any) => e.id);

    expect((await answer(rejected.id, "reject")).status).toBe(200);
    expect(await entry(rejected.question_proposal.candidate_id)).toMatchObject({ invalidation_reason: "rejected" });
    expect(await behaviors()).toEqual([approved]);

    const { question_id } = await consolidate(board, [approved, board.ids[0]!, board.ids[1]!]);
    const merged = (await task(question_id)).question_proposal.candidate_id;
    expect((await answer(question_id, "approve")).status).toBe(200);
    expect(await behaviors()).toEqual([merged]);
  } finally {
    await board.client.close();
  }
});

it("invalidate の回答は reject で approved 集合を変えず、approve で target を approved 集合から外す", async () => {
  const board = await boardWithMetaReview();
  try {
    const target = await approvedBehavior(board, "Split migrations");
    const behaviors = async () => (await board.call("list_memory_behaviors", {})).entries.map((e: any) => e.id);

    expect((await answer((await invalidate(board, target)).question_id, "reject")).status).toBe(200);
    expect(await behaviors()).toEqual([target]);

    expect((await answer((await invalidate(board, target, "capability")).question_id, "approve")).status).toBe(200);
    expect(await behaviors()).toEqual([]);
  } finally {
    await board.client.close();
  }
});

it("consolidate の replaces や invalidate の target が先に無効化されると、open な提案 question は観測で決着し memory_proposal_stale が残る", async () => {
  const board = await boardWithMetaReview();
  try {
    const target = await approvedBehavior(board, "Split migrations");
    const replaced = board.ids[0]!;
    const questions = [(await consolidate(board, [replaced])).question_id, (await invalidate(board, target)).question_id];

    const observed = [
      (await board.call("invalidate_memory", { entry_id: replaced, reason: "capability" })).event_id,
      (await api(t.baseUrl, "POST", `/api/settings/memory/entries/${target}/invalidate`, { reason: "requirement_change" })).json.event_id,
    ];

    for (const [i, entryId] of [replaced, target].entries()) {
      expect(await task(questions[i]!)).toMatchObject({ status: "done", question_answer: null });
      expect((await events(questions[i]!)).at(-1)).toMatchObject({
        kind: "memory_proposal_stale",
        payload: { question_id: questions[i], entry_id: entryId, observed_event_id: observed[i] },
      });
    }
  } finally {
    await board.client.close();
  }
});

it("consolidate は Knowledge / Definition / 無効化済みを replaces に含むと、based_on_decision が decision でないと断られ、candidate を残さない", async () => {
  const board = await boardWithMetaReview(["Keep migrations in their own commit", "Invalidated rule"]);
  try {
    const author = { activity: "meta_review" as const, name: "auditor" };
    const knowledge = recordKnowledge(t.db, { scope: null, path: "habits", title: "k", text: "k.", source: { commit: "0a46a46" }, author }, "worker", t.clock.now()).entry_id;
    const definition = defineMemoryBranch(t.db, { scope: null, path: "habits", text: "Working habits.", author }, "worker", t.clock.now()).entry_id;
    await board.call("invalidate_memory", { entry_id: board.ids[1], reason: "capability" });
    const before = (await api(t.baseUrl, "GET", "/api/settings/memory/entries")).json.entries;

    for (const bad of [knowledge, definition, board.ids[1]!]) {
      expect(await consolidate(board, [board.ids[0]!, bad])).toMatchObject({ error: expect.stringContaining("not a non-invalidated behavior") });
    }
    const notDecision = (await events(board.review.id))[0].id;
    expect(await consolidate(board, [board.ids[0]!], notDecision)).toMatchObject({ error: expect.stringContaining("not a logged decision") });

    expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries")).json.entries).toEqual(before);
  } finally {
    await board.client.close();
  }
});

it("invalidate は approved でない Behavior・Knowledge・無効化済みを target にすると断られる", async () => {
  const board = await boardWithMetaReview();
  try {
    const author = { activity: "meta_review" as const, name: "auditor" };
    const knowledge = recordKnowledge(t.db, { scope: null, path: "habits", title: "k", text: "k.", source: { commit: "0a46a46" }, author }, "worker", t.clock.now()).entry_id;
    const invalidated = await approvedBehavior(board, "Split migrations");
    expect((await answer((await invalidate(board, invalidated)).question_id, "approve")).status).toBe(200);

    for (const bad of [board.ids[0]!, knowledge, invalidated]) {
      expect(await invalidate(board, bad)).toMatchObject({ error: expect.stringContaining("not a non-invalidated behavior in state approved") });
    }
  } finally {
    await board.client.close();
  }
});

it("pin する entry のどれかが既に open な提案に pin されていれば、op を問わず提案の時点で断られる", async () => {
  const board = await boardWithMetaReview(["Keep migrations in their own commit", "Split schema changes"]);
  try {
    const target = await approvedBehavior(board, "Split migrations");
    await invalidate(board, target);
    const consolidation = await task((await consolidate(board, [board.ids[0]!])).question_id);
    const refused = expect.objectContaining({ error: expect.stringContaining("already in an open proposal question") });

    expect(await invalidate(board, target)).toEqual(refused);
    expect(await consolidate(board, [board.ids[1]!, target])).toEqual(refused);
    expect(await board.call("propose_memory_change", { op: "approve", candidate_id: board.ids[0], rationale: "r" })).toEqual(refused);
    expect(await consolidate(board, [board.ids[1]!, consolidation.question_proposal.candidate_id])).toEqual(refused);
  } finally {
    await board.client.close();
  }
});

it("op に属さない欄を渡すと、黙って捨てずに断られる", async () => {
  const board = await boardWithMetaReview(["Keep migrations in their own commit", "Split schema changes"]);
  try {
    expect(await board.call("propose_memory_change", { op: "approve", candidate_id: board.ids[0], replaces: [board.ids[1]], rationale: "r" })).toMatchObject({
      error: expect.stringContaining("op approve does not take replaces"),
    });
  } finally {
    await board.client.close();
  }
});
