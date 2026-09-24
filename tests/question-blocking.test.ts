import { afterEach, expect, it } from "vitest";
import { quarantineCliAuthForProvider } from "../src/cli-auth.js";
import { createBehaviorCandidate } from "../src/memory.js";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

// question 行の `blocking` は、その question が塞いでいる親の id(塞がなければ null)。
// 判定は ADR 0049 の awaitedChildSql 1か所 — 付帯子の提案 question は親を塞がない
// (ADR 0120 決定3, issue #935)。WebUI の単体ビューも読むので一覧と単体の両方に載る。

let t: Tidepool;
afterEach(() => t?.stop());

async function blockingOf(questionId: string) {
  const row = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((x) => x.id === questionId);
  const single = (await api(t.baseUrl, "GET", `/api/tasks/${questionId}`)).json;
  expect(single.blocking).toEqual(row.blocking);
  return row.blocking;
}

it("付帯子の提案 question は親を持っても blocking が null", async () => {
  t = await bootTidepool();
  const { entry_id } = createBehaviorCandidate(
    t.db,
    {
      scope: null,
      path: "habits/commits",
      title: "Keep migrations in their own commit",
      text: "Keep migrations in their own commit, always.",
      addressee: "deckhand",
      source: { commit: "0a46a46" },
      author: { activity: "rca", name: "auditor" },
    },
    "worker",
    t.clock.now(),
  );
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((x) => x.meta_review_subject === "memory");
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const res: any = await client.callTool({
    name: "propose_memory_change",
    arguments: { op: "approve", candidate_id: entry_id, rationale: "Three RCAs asked for the same split." },
  });
  await client.close();
  const { question_id } = JSON.parse(res.content[0].text);

  expect(await blockingOf(question_id)).toBeNull();
});

it("escalate の question は親の id を blocking に持つ", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  await client.callTool({
    name: "escalate",
    arguments: { context: "ordinary escalation", questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }] },
  });
  await client.close();
  const question = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find(
    (x) => x.type === "question" && x.parent_id === parent.id,
  );

  expect(await blockingOf(question.id)).toBe(parent.id);
});

it("親を持たない question は blocking が null", async () => {
  t = await bootTidepool();
  quarantineCliAuthForProvider(t.db, "openai", t.clock.now());
  const question = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find(
    (x) => x.type === "question" && x.parent_id === null,
  );

  expect(await blockingOf(question.id)).toBeNull();
});
