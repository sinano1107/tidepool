import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { submitAnswer } from "../src/human-verbs.js";
import { answerQuestion, getTask, type RegisterTaskInput, registerTask } from "../src/tasks.js";
import { unusedLanding } from "./fakes.js";
import { api, bootTidepool, HOUR, HUMAN_WEBUI, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const escalation = {
  context: "two viable providers with a cost/lock-in tradeoff; out of my authority",
  questions: [
    {
      title: "which auth provider?",
      options: ["auth0", "clerk", "keycloak"],
      recommendation: "clerk",
    },
  ],
};

async function escalateFrom(t: Tidepool, parentId: string) {
  const client = await mcpClient(t.mcpBaseUrl, parentId);
  const res: any = await client.callTool({ name: "escalate", arguments: escalation });
  expect(res.isError ?? false).toBe(false);
  await client.close();
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  return list.find((x: any) => x.type === "question" && x.parent_id === parentId);
}

it("comment 付きの回答が question_answered イベントに記録される(issue #40)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["auth0"],
    comment: "clerk はロックインが強すぎる、auth0 で",
  });

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  const answered = events.find((e: any) => e.kind === "question_answered");
  expect(answered.payload.comment).toBe("clerk はロックインが強すぎる、auth0 で");
});

it("comment なしの回答は従来どおり通り、question_answered イベントに comment キー自体が現れない(issue #40)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["clerk"],
  });
  expect(res.status).toBe(200);

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  const answered = events.find((e: any) => e.kind === "question_answered");
  expect(answered.payload).not.toHaveProperty("comment");
});

it("復帰した親の get_current_task に、reject 理由の comment が answer と一緒に含まれる(issue #40)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["auth0"],
    comment: "clerk はロックインが強すぎる、auth0 で",
  });

  // answering with a free slot resumes the parent at once
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.history).toEqual([
      {
        child_outside_the_decomposition: {
          title: escalation.questions[0]!.title,
          purpose: escalation.context,
          completion_criteria: "a human answer is recorded",
          status: "done",
          items: escalation.questions,
          answer: ["auth0"],
          comment: "clerk はロックインが強すぎる、auth0 で",
        },
      },
    ]);
  } finally {
    await client.close();
  }
});

it("comment が空白だけの承認 question の reject は HTTP で 409 になり question は open のまま、理由つきなら通り復帰した親の history に answer と comment が並ぶ(ADR 0179 決定2)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: { reason: "needs sign-off", children: [{ title: "migrate the prod table", purpose: "p", completion_criteria: "c", risk_flag: true }] },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find((x: any) => x.question_pending_child?.title === "migrate the prod table");

  expect((await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["reject"], comment: " " })).status).toBe(409);

  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({ status: "todo", question_answer: null });

  // 理由つきなら通り、復帰した親の history に answer と comment が並ぶ
  expect((await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["reject"], comment: "別の子にしなくていい" })).status).toBe(200);
  const resumed = await mcpClient(t.mcpBaseUrl, parent.id);
  try {
    const result: any = await resumed.callTool({ name: "get_current_task", arguments: {} });
    expect(JSON.parse(result.content[0].text).history).toMatchObject([
      { decision: "needs sign-off", children: [{ status: "done", answer: ["reject"], comment: "別の子にしなくていい" }] },
    ]);
  } finally {
    await resumed.close();
  }
});

// 理由必須の門(ADR 0179 決定1〜4)は domain 層の answerQuestion に置く —— どの扉から来ても同じ。
const at = new Date("2026-10-01T00:00:00.000Z");
const QUESTIONS = {
  memory: { options: ["approve", "reject", "defer"], proposal: { kind: "memory", op: "approve", candidate_id: 1, replaces: [] } },
  routing: { options: ["approve", "reject"], proposal: { kind: "routing", op: "promote", pin: { promoted: false } } },
  registry: {
    options: ["approve", "reject"],
    proposal: { kind: "registry", op: "agent_tier", agent: "reef-crab", to: 1, pin: { tier: 2, rows: [] }, evidence: [1] }, // 段は id(種の economy / standard)
  },
  approval: { options: ["approve", "reject"], pending_child: { title: "B", purpose: "p", completion_criteria: "c" } },
  escalation: { options: ["a", "b"] },
  failure: { options: ["retry", "abandon"], cancel_option: "abandon" },
  merge: { options: ["merge", "hold"], pending_merge_pr: 7 },
  promotion: { options: ["retry", "abandon promotion"], pending_pr_promotion_task_id: "t-1" },
} satisfies Record<string, Partial<RegisterTaskInput> & { options: string[] }>;

function domainQuestion(kind: keyof typeof QUESTIONS) {
  const db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const { options, ...fields } = QUESTIONS[kind];
  const question = registerTask(
    db,
    {
      type: "question",
      title: "q",
      purpose: "p",
      completion_criteria: "a human answer is recorded",
      parent_id: parent.id,
      question: [{ title: "t", options, recommendation: options[0]! }],
      ...fields,
    },
    at,
    ...HUMAN_WEBUI,
  );
  return { db, question };
}

it.each([
  ["memory", "reject"],
  ["memory", "defer"],
  ["routing", "reject"],
  ["registry", "reject"],
  ["approval", "reject"],
] as const)("%s の question への %s は comment が空・空白だけなら domain error で断り、comment があれば通る(ADR 0179 決定1・2・4)", (kind, answer) => {
  const { db, question } = domainQuestion(kind);
  for (const comment of [undefined, "", " \n "]) expect(() => answerQuestion(db, question, [answer], at, undefined, comment, undefined, "webui")).toThrow(DomainError);
  expect(getTask(db, question.id)).toMatchObject({ status: "todo", question_answer: null });
  expect(answerQuestion(db, question, [answer], at, undefined, "why", undefined, "webui").status).toBe("done");
});

it.each([
  ["memory", "approve"],
  ["routing", "approve"],
  ["registry", "approve"],
  ["approval", "approve"],
  ["escalation", "b"],
  ["failure", "abandon"],
  ["merge", "hold"],
  ["promotion", "abandon promotion"],
] as const)("%s の question への %s は comment なしで通る(ADR 0179 決定3)", (kind, answer) => {
  const { db, question } = domainQuestion(kind);
  expect(answerQuestion(db, question, [answer], at, undefined, undefined, undefined, "webui").status).toBe("done");
});

// 空・空白の comment を畳むのは submitAnswer —— HTTP と管理 MCP の両方の扉が通る application seam(門が answerQuestion にあるのとは別の層)。
it.each([["空文字", ""], ["空白だけ", "   "]])("任意の回答の comment が%sなら comment なしに畳まれ、列は null・event に comment キーが載らない(issue #1310)", async (_name, comment) => {
  const { db, question } = domainQuestion("escalation");
  await submitAnswer({ db, pollNow: () => {}, landing: unusedLanding }, question, ["a"], comment, () => at, "webui");
  expect(getTask(db, question.id)?.question_answer_comment).toBeNull();
  const answered = listEvents(db, question.id).find((e) => e.kind === "question_answered");
  expect(answered?.payload).not.toHaveProperty("comment");
});

it("前後に空白を含む空白でない comment は削らずそのまま保存される(issue #1310)", async () => {
  const { db, question } = domainQuestion("escalation");
  await submitAnswer({ db, pollNow: () => {}, landing: unusedLanding }, question, ["a"], " 理由 ", () => at, "webui");
  expect(getTask(db, question.id)?.question_answer_comment).toBe(" 理由 ");
  const answered = listEvents(db, question.id).find((e) => e.kind === "question_answered");
  expect(answered?.payload).toMatchObject({ comment: " 理由 " });
});

it("HTTP の回答に comment: \"\" を送っても 400 にならず、任意の回答なら受理される(issue #1310)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["clerk"], comment: "" });
  expect(res.status).toBe(200);
});
