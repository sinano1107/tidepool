import { afterEach, expect, it } from "vitest";
import { getEvent } from "../src/events.js";
import { createBehaviorCandidate, listMemoryEntries } from "../src/memory.js";
import { countUnsettledAttachedChildren } from "../src/tasks.js";
import { api, bootTidepool, completeViaMcp, HOUR, mcpClient, type Tidepool } from "./harness.js";

/** 提案 question の扉(issue #620 / ADR 0120 決定3・4): meta-review の提案 verb、付帯子としての question、回答での適用、
 *  pin の陳腐化。承認の transaction と再生はドメイン層(tests/memory.test.ts)が言う。 */
let t: Tidepool;
afterEach(() => t?.stop());

function candidate(tp: Tidepool, title: string): number {
  return createBehaviorCandidate(
    tp.db,
    {
      scope: null,
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
const entry = (id: number) => listMemoryEntries(t.db, {}).find((e) => e.id === id)!;

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

it("提案 question が open でも meta-review は完了でき、着地の門は付帯子として数える", async () => {
  const { review, ids, client, propose } = await boardWithMetaReview();
  try {
    const questionId = await propose(ids[0]!);

    expect((await completeViaMcp(t, review.id, false)).isError).not.toBe(true);
    expect(await task(review.id)).toMatchObject({ status: "done" });
    expect(await task(questionId)).toMatchObject({ status: "todo" });
    expect(countUnsettledAttachedChildren(t.db, review.id)).toBe(1);
  } finally {
    await client.close();
  }
});

it("approve の回答で candidate が approved(版 = memory_entry_approved の id)になり、選択肢外の回答は拒否される", async () => {
  const { ids, client, propose } = await boardWithMetaReview();
  try {
    const questionId = await propose(ids[0]!);

    expect((await answer(questionId, "approve it")).status).toBe(409);
    expect(entry(ids[0]!)).toMatchObject({ state: "candidate" });

    expect((await answer(questionId, "approve")).status).toBe(200);
    const approved = entry(ids[0]!);
    expect(approved).toMatchObject({ state: "approved", invalidation_reason: null });
    expect(getEvent(t.db, approved.version!)?.payload).toEqual({ kind: "memory_entry_approved", entry_id: ids[0], question_id: questionId, replaced: [] });
  } finally {
    await client.close();
  }
});

it("pin が古い approve は回答ごと拒否され何も残らない —— 別の question で先に承認された candidate は、見せた状態と違う", async () => {
  const { ids, client, propose } = await boardWithMetaReview();
  try {
    const first = await propose(ids[0]!);
    const second = await propose(ids[0]!);
    expect((await answer(first, "approve")).status).toBe(200);
    const approved = entry(ids[0]!);

    expect((await answer(second, "approve")).status).toBe(409);

    expect(await task(second)).toMatchObject({ status: "todo", question_answer: null });
    expect((await events(second)).map((e) => e.kind)).toEqual(["task_registered"]);
    expect(entry(ids[0]!)).toEqual(approved);
  } finally {
    await client.close();
  }
});

it("reject の回答で candidate は後継なしの rejected で無効化され、答えた question 自身は陳腐化で決着しない", async () => {
  const { ids, client, propose } = await boardWithMetaReview();
  try {
    const questionId = await propose(ids[0]!);

    expect((await answer(questionId, "reject")).status).toBe(200);

    expect(entry(ids[0]!)).toMatchObject({ state: "candidate", invalidation_reason: "rejected", successor_id: null });
    expect((await events(questionId)).map((e) => e.kind)).toEqual(["task_registered", "question_answered"]);
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
