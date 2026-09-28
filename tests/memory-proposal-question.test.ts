import { afterEach, expect, it } from "vitest";
import { appendEvent } from "../src/events.js";
import { approveMemoryProposal, createBehaviorCandidate } from "../src/memory.js";
import { api, bootTidepool, bundledObjection, completeViaMcp, HOUR, managementMcpClient, mcpClient, memoryEntries, type Tidepool } from "./harness.js";

/** 提案 question の扉(issue #620・#621 / ADR 0120 決定3・4): meta-review の提案 verb、付帯子としての question、回答での適用、
 *  pin の陳腐化。承認の transaction と再生はドメイン層(tests/memory.test.ts)が言う。 */
let t: Tidepool;
afterEach(() => t?.stop());

function candidate(tp: Tidepool, title: string, scope: string | null = null, source: { commit: string } | { event_id: number } = { commit: "0a46a46" }): number {
  return createBehaviorCandidate(
    tp.db,
    {
      scope,
      path: "habits/commits",
      title,
      text: `${title}, always.`,
      addressee: "deckhand",
      source,
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
const answer = (id: string, option: string, extra: { amendment?: Record<string, unknown>; comment?: string } = {}) =>
  api(t.baseUrl, "POST", `/api/tasks/${id}/answer`, { answers: [option], ...extra });
const because = { comment: "Too broad for every task." };
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

it("propose_memory_change の拒否は tool error として返る(何を断るかは domain 層 —— tests/memory-meta-review-writes.test.ts が言う)", async () => {
  const { ids, client, call, propose } = await boardWithMetaReview();
  try {
    await propose(ids[0]!);

    expect(await call("propose_memory_change", { op: "approve", candidate_id: ids[0], rationale: "again" })).toMatchObject({
      error: expect.any(String),
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

    for (const option of ["approve", "reject"]) expect((await answer(questionId, option, because)).status).toBe(409);

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

    expect((await answer(questionId, "reject", because)).status).toBe(200);

    expect(await entry(ids[0]!)).toMatchObject({ invalidation_reason: "rejected" });
    expect((await events(questionId)).map((e) => e.kind)).toEqual(["task_registered", "question_answered"]);
    // 無効化は回答の印を持ち、周期が過ぎても次の memory meta-review を登録しない(ADR 0151)
    expect((await completeViaMcp(t, review.id, false)).isError).not.toBe(true);
    expect((await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: 1 })).status).toBe(200);
    await t.clock.advance(2 * 24 * HOUR); // 周期(1日)を越える
    expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.meta_review_subject === "memory")).toEqual([]);
  } finally {
    await client.close();
  }
});

it("defer の回答は comment が無ければ 409 で question を開いたまま残し、comment つきなら店に触れずに question を閉じて list_memory_proposals に並ぶ —— 次の memory meta-review の材料にはならず、門が開いたので材料が出れば登録される(ADR 0165)", async () => {
  const { review, ids, client, call, propose } = await boardWithMetaReview();
  try {
    const questionId = await propose(ids[0]!);
    const before = await memoryEntries(t);

    expect((await answer(questionId, "defer")).status).toBe(409);
    expect(await task(questionId)).toMatchObject({ status: "todo", question_answer: null });

    const undecided = "Not sure the split holds for data-only migrations.";
    expect((await answer(questionId, "defer", { comment: undecided })).status).toBe(200);

    expect(await task(questionId)).toMatchObject({ status: "done", question_answer: ["defer"], question_answer_comment: undecided });
    expect((await events(questionId)).map((e) => [e.kind, e.payload.answers?.[0]?.answer, e.payload.comment])).toEqual([
      ["task_registered", undefined, undefined],
      ["question_answered", "defer", undecided],
    ]);
    expect(await memoryEntries(t)).toEqual(before);
    expect((await call("list_memory_proposals", {})).proposals).toMatchObject([{ question_id: questionId, answer: "defer", comment: undecided }]);

    expect((await completeViaMcp(t, review.id, false)).isError).not.toBe(true);
    expect((await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: 1 })).status).toBe(200);
    await t.clock.advance(2 * 24 * HOUR); // 周期(1日)を越えるが、defer は材料でない(ADR 0151)
    const memoryReviews = async () => ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.meta_review_subject === "memory");
    expect(await memoryReviews()).toEqual([]);
    candidate(t, "Keep data migrations separate");
    await t.clock.advance(HOUR);
    expect(await memoryReviews()).toMatchObject([{ status: "in_progress" }]);
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
      (await call("fold_memory", { successor_id: successor, replaces: [superseded] })).event_ids[0],
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

async function consolidate(board: Awaited<ReturnType<typeof boardWithMetaReview>>, replaces: number[]) {
  const decision = (await board.call("log_decision", { line: "the split rules say the same thing" })).event_id;
  return board.call("propose_memory_change", {
    op: "consolidate",
    text: { scope: null, path: "habits/commits", title: "One concern per commit", text: "Keep each commit to one concern.", addressee: null },
    replaces,
    based_on_decision: decision,
    rationale: "Two workspaces grew the same rule.",
  });
}

it("consolidate の提案は meta_review 名義の新 candidate を作り、その id と replaces の pin を焼き、detail に置換対象の id と本文 → 新本文・宛先・path・scope を載せる", async () => {
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
    });
    const { detail } = question.question_items[0];
    for (const shown of [`#${approved} (scope: tidepool, addressee: deckhand)`, "Split migrations, always.", `#${board.ids[0]}`, "Keep migrations in their own commit, always.", "Keep each commit to one concern.", "every agent", "habits/commits", "whole board"]) {
      expect(detail).toContain(shown);
    }
  } finally {
    await board.client.close();
  }
});

/** RCA の帰責 event を出所に共有する2つの candidate を consolidate の kind exemplar で統合する提案 question を立てる。 */
async function proposeExemplar(board: Awaited<ReturnType<typeof boardWithMetaReview>>): Promise<string> {
  const objected = (await board.call("log_decision", { line: "split the migration into two commits" })).event_id;
  // setup のみ: RCA の帰責 event(起草の出所)
  const attributed = appendEvent(t.db, {
    taskId: board.review.id,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: objected, objection_event_ids: [bundledObjection(t.db, board.review.id, objected, t.clock.now())], cause: "preference", evidence: "e", entries: null, round: "after_rca" },
    at: t.clock.now(),
  });
  const replaces = [candidate(t, "Split migrations", null, { event_id: attributed }), candidate(t, "Two commits", null, { event_id: attributed })];
  const annotations = [
    { anchor: { field: "decision", quote: "two commits" }, polarity: "imitate", text: "Split schema changes from data changes." },
    { anchor: "whole", polarity: "avoid", text: "Do not mix in unrelated refactors." },
  ];
  const { question_id } = await board.call("propose_memory_change", {
    op: "consolidate",
    text: { scope: null, path: "habits/migrations", title: "Split the migration", addressee: null, kind: "exemplar", annotations },
    replaces,
    based_on_decision: (await board.call("log_decision", { line: "too particular for a rule" })).event_id,
    rationale: "Too particular for a rule.",
  });
  return question_id;
}

it("consolidate の kind exemplar は注釈つきの Exemplar candidate を作り、detail に注釈と case を載せ、list_memory_candidates は kind exemplar で それを引く(issue #954)", async () => {
  const board = await boardWithMetaReview();
  try {
    const question_id = await proposeExemplar(board);

    const question = await task(question_id);
    const candidateId = question.question_proposal.candidate_id;
    expect(await entry(candidateId)).toMatchObject({ kind: "exemplar" });
    const { detail } = question.question_items[0];
    for (const shown of [
      `new exemplar candidate #${candidateId}`,
      'imitate (decision: "two commits"): Split schema changes from data changes.',
      "avoid (whole): Do not mix in unrelated refactors.",
      "Decision: split the migration into two commits",
    ]) {
      expect(detail).toContain(shown);
    }
    expect((await board.call("list_memory_candidates", { kind: "exemplar" })).entries.map((e: any) => e.id)).toEqual([candidateId]);
  } finally {
    await board.client.close();
  }
});

it("meta-review の invalidate_memory は reason rejected で candidate を引退させる(issue #954)", async () => {
  const { ids, client, call } = await boardWithMetaReview();
  try {
    expect(await call("invalidate_memory", { entry_id: ids[0], reason: "rejected" })).toEqual({ event_id: expect.any(Number) });
    expect(await entry(ids[0]!)).toMatchObject({ invalidation_reason: "rejected" });
  } finally {
    await client.close();
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
    });
    const { detail } = question.question_items[0];
    for (const shown of [`#${target}`, "Split migrations, always.", "tidepool", "habits/commits", "deckhand", "environment"]) {
      expect(detail).toContain(shown);
    }
  } finally {
    await board.client.close();
  }
});

it("invalidate の提案の理由に cause の memory は取れず tool error で、question は立たない(ADR 0166 決定7)", async () => {
  const board = await boardWithMetaReview();
  try {
    const target = await approvedBehavior(board, "Split migrations", "tidepool");
    const before = (await api(t.baseUrl, "GET", "/api/tasks")).json.length;

    expect(await invalidate(board, target, "memory")).toMatchObject({ error: expect.any(String) });
    expect((await api(t.baseUrl, "GET", "/api/tasks")).json).toHaveLength(before);
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

    expect((await answer(rejected.id, "reject", because)).status).toBe(200);
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

    expect((await answer((await invalidate(board, target)).question_id, "reject", because)).status).toBe(200);
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

it("HTTP の回答と管理MCP の answer_question は memory の修正値を受け、修正つき approve は推奨どおりに数えず修正値を回答に残す", async () => {
  const board = await boardWithMetaReview(["Keep migrations in their own commit", "Split schema changes"]);
  const management = await managementMcpClient(t.baseUrl);
  try {
    const viaHttp = await board.propose(board.ids[0]!);
    const amendment = { text: "Keep each migration in its own commit.", addressee: null };
    expect((await answer(viaHttp, "approve", { amendment })).status).toBe(200);
    expect((await events(viaHttp)).find((e) => e.kind === "question_answered").payload).toMatchObject({
      answers: [{ answer: "approve", recommendation_accepted: false }],
      amendment,
    });

    const viaMcp = (await consolidate(board, [board.ids[1]!])).question_id;
    const answered: any = await management.callTool({ name: "answer_question", arguments: { task_id: viaMcp, answers: ["approve"], amendment: { title: "One concern" } } });
    expect(answered.isError).not.toBe(true);
    expect((await events(viaMcp)).find((e) => e.kind === "question_answered").payload).toMatchObject({
      answers: [{ answer: "approve", recommendation_accepted: false }],
      amendment: { title: "One concern" },
    });
  } finally {
    await management.close();
    await board.client.close();
  }
});

it("HTTP の回答は Exemplar の candidate への注釈の修正値を受け、回答に残す(issue #950)", async () => {
  const board = await boardWithMetaReview();
  try {
    const questionId = await proposeExemplar(board);
    const annotations = [{ anchor: { field: "decision", quote: "the migration" }, polarity: "avoid", text: "Do not bundle the migration." }];

    expect((await answer(questionId, "approve", { amendment: { annotations } })).status).toBe(200);
    expect((await events(questionId)).find((e) => e.kind === "question_answered").payload).toMatchObject({ amendment: { annotations } });
  } finally {
    await board.client.close();
  }
});

it("invalidate の提案と reject に付いた memory の修正値は回答ごと断られ、question は未回答のまま残る", async () => {
  const board = await boardWithMetaReview();
  try {
    const target = await approvedBehavior(board, "Split migrations");
    const invalidation = (await invalidate(board, target)).question_id;
    const approval = await board.propose(board.ids[0]!);

    for (const [id, option] of [[invalidation, "approve"], [approval, "reject"]] as const) {
      expect((await answer(id, option, { ...because, amendment: { text: "Something else." } })).status).toBe(409);
      expect(await task(id)).toMatchObject({ status: "todo", question_answer: null });
      expect((await events(id)).map((e) => e.kind)).toEqual(["task_registered"]);
    }
  } finally {
    await board.client.close();
  }
});

it("HTTP の回答で comment の無い memory 提案の reject は 409 で断られ、question は未回答のまま(ADR 0159 決定3)", async () => {
  const { ids, client, propose } = await boardWithMetaReview();
  try {
    const questionId = await propose(ids[0]!);

    expect((await answer(questionId, "reject")).status).toBe(409);

    expect(await task(questionId)).toMatchObject({ status: "todo", question_answer: null });
    expect((await events(questionId)).map((e) => e.kind)).toEqual(["task_registered"]);
  } finally {
    await client.close();
  }
});
