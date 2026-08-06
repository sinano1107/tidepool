import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  HOUR,
  mcpClient,
  registerQuestion,
  registerWork,
  type Tidepool,
} from "./harness.js";

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

it("escalate registers one question task carrying every question item, blocks the parent, and releases the slot", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const twoQuestions = {
    context: escalation.context,
    questions: [
      ...escalation.questions,
      {
        title: "which region?",
        detail: "latency budget favors us-east but data residency may force eu-west",
        options: ["us-east", "eu-west"],
        recommendation: "us-east",
      },
    ],
  };
  const res: any = await client.callTool({ name: "escalate", arguments: twoQuestions });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const questions = list.filter((x: any) => x.type === "question");
  // one bundle, not one child per question (the "question 子を複数生やす" design
  // rejected in the 2026-07-10 grilling — issue #30)
  expect(questions).toHaveLength(1);
  const question = questions[0];
  expect(question.parent_id).toBe(parent.id);
  expect(question.status).toBe("todo");
  expect(question.based_on_decision).toBeNull();
  expect(question.question_items).toEqual(twoQuestions.questions);

  // blocked is derived from the unfinished child, and the board says so
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("blocked");

  // slot freed: the next tick hands the slot to fresh work, skipping both the
  // blocked parent and the question (a human task, answered outside the slot)
  const next = await registerWork(t, "next");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([parent.id, next.id]);
});

it("escalate refuses an item with fewer than 2 or more than 4 options, a recommendation outside them, or a bundle outside 1-4 items", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const invalidItemOverrides = [
    { options: ["only one"], recommendation: "only one" },
    { options: ["a", "b", "c", "d", "e"], recommendation: "a" },
    { options: ["a", "b"], recommendation: "" },
    { options: ["a", "b"], recommendation: "c" },
  ];
  try {
    for (const overrides of invalidItemOverrides) {
      const res: any = await client.callTool({
        name: "escalate",
        arguments: {
          context: escalation.context,
          questions: [{ ...escalation.questions[0], ...overrides }],
        },
      });
      expect(res.isError, JSON.stringify(overrides)).toBe(true);
    }
    // the item-count cap (issue #30: up to 4, following the existing 2-4
    // options discipline)
    const tooMany: any = await client.callTool({
      name: "escalate",
      arguments: {
        context: escalation.context,
        questions: Array.from({ length: 5 }, (_, i) => ({
          title: `question ${i}`,
          options: ["a", "b"],
          recommendation: "a",
        })),
      },
    });
    expect(tooMany.isError).toBe(true);
  } finally {
    await client.close();
  }

  // nothing was registered and the parent kept the slot
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(list.filter((x: any) => x.type === "question")).toEqual([]);
  expect(list.find((x: any) => x.id === parent.id).status).toBe("in_progress");
});

/** Drive a task into the slot and escalate from it; returns the question. */
async function escalateFrom(t: Tidepool, parentId: string) {
  const client = await mcpClient(t.mcpBaseUrl, parentId);
  const res: any = await client.callTool({ name: "escalate", arguments: escalation });
  expect(res.isError ?? false).toBe(false);
  await client.close();
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  return list.find((x: any) => x.type === "question" && x.parent_id === parentId);
}

it("answering unblocks the parent to the queue head and picks it up at once when the slot is free", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);
  const other = await registerWork(t, "other"); // joins the tail, ahead of nobody

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["clerk"],
  });
  expect(res.status).toBe(200);

  const answered = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(answered.status).toBe("done");
  expect(answered.question_answer).toEqual(["clerk"]);

  // the unblocked parent went to the head and the free slot picked it up
  // without waiting for a tick — ahead of `other`
  expect(t.worker.started.map((x) => x.id)).toEqual([parent.id, parent.id]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("in_progress");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${other.id}`)).json.status).toBe("todo");
});

it("answering while the slot is busy parks the parent at the queue head until the next pickup", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);
  const other = await registerWork(t, "other");
  await t.clock.advance(HOUR); // freed slot goes to `other`
  expect(t.worker.started.map((x) => x.id)).toEqual([parent.id, other.id]);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["clerk"] });

  // no pickup while the slot is held, but the parent waits at the head
  expect(t.worker.started.map((x) => x.id)).toEqual([parent.id, other.id]);
  const todos = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (x: any) => x.status === "todo",
  );
  expect(todos.map((x: any) => x.id)).toEqual([parent.id]);
});

it("a one-tap answer matching the recommendation is recorded as acceptance in the events", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["clerk"] });

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  const answered = events.filter((e: any) => e.kind === "question_answered");
  expect(answered).toHaveLength(1);
  expect(answered[0].worker_id).toBe("human");
  // recommended_by makes per-agent acceptance rates a one-event statistic
  expect(answered[0].payload).toEqual({
    kind: "question_answered",
    answers: [{ answer: "clerk", recommendation_accepted: true }],
    recommended_by: "fake-worker",
  });
});

it("a free-text override answers the question and is recorded as non-acceptance", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["use the in-house SSO gateway instead"],
  });
  expect(res.status).toBe(200);
  expect(res.json.question_answer).toEqual(["use the in-house SSO gateway instead"]);
  expect(res.json.status).toBe("done");

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  const answered = events.find((e: any) => e.kind === "question_answered");
  expect(answered.payload.answers[0].recommendation_accepted).toBe(false);
});

it("a question answers exactly once, and only questions answer at all", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["clerk"] });
  const again = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["auth0"],
  });
  expect(again.status).toBe(409);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.question_answer).toEqual(
    ["clerk"],
  );

  const onWork = await api(t.baseUrl, "POST", `/api/tasks/${parent.id}/answer`, {
    answers: ["clerk"],
  });
  expect(onWork.status).toBe(409);
});

// the HTTP JSON API refuses type: "question" outright (issue #38) — a
// standalone question can only enter through escalate or tidepool's own
// internal registration paths (watchdog/quarantine/merge/decompose), never
// this door. See tests/register-question-rejected.test.ts for that.
it("a standalone question registered through the internal door still carries 2-4 options and a recommendation", async () => {
  t = await bootTidepool();
  const base = {
    title: "standalone question",
    purpose: "a human wants steering input",
    completion_criteria: "answered",
  };
  // no items at all, and an invalid spec, are both refused at registration —
  // same invariant as escalate's
  expect(() => registerQuestion(t, base)).toThrow();
  expect(() =>
    registerQuestion(t, {
      ...base,
      question: [{ title: "standalone question", options: ["only"], recommendation: "only" }],
    }),
  ).toThrow();

  const ok = registerQuestion(t, {
    ...base,
    question: [{ title: "standalone question", options: ["yes", "no"], recommendation: "no" }],
  });
  const stored = (await api(t.baseUrl, "GET", `/api/tasks/${ok.id}`)).json;
  expect(stored.question_items).toEqual([
    { title: "standalone question", options: ["yes", "no"], recommendation: "no" },
  ]);
});

it("answering one of two open questions leaves the parent blocked; the last answer unblocks it", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const q1 = await escalateFrom(t, parent.id);
  const q2 = registerQuestion(t, {
    title: "second question",
    purpose: "another decision on the same parent",
    completion_criteria: "answered",
    parent_id: parent.id,
    question: [{ title: "second question", options: ["yes", "no"], recommendation: "yes" }],
  });

  await api(t.baseUrl, "POST", `/api/tasks/${q1.id}/answer`, { answers: ["clerk"] });

  // still blocked on q2: no pickup, and no spurious move to the head
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("blocked");
  expect(t.worker.started.map((x) => x.id)).toEqual([parent.id]);
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${parent.id}/events`)).json;
  expect(events.filter((e: any) => e.kind === "task_moved")).toEqual([]);

  await api(t.baseUrl, "POST", `/api/tasks/${q2.id}/answer`, { answers: ["yes"] });
  expect(t.worker.started.map((x) => x.id)).toEqual([parent.id, parent.id]);
});

it("answering a multi-item escalation is atomic: a partial submission is refused and persists nothing, a full one answers every item at once", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  await client.callTool({
    name: "escalate",
    arguments: {
      context: escalation.context,
      questions: [
        ...escalation.questions,
        {
          title: "which region?",
          options: ["us-east", "eu-west"],
          recommendation: "us-east",
        },
      ],
    },
  });
  await client.close();

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");

  // one answer for a two-item question is refused, and nothing is persisted
  const partial = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["clerk"],
  });
  expect(partial.status).toBe(409);
  const stillOpen = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(stillOpen.status).toBe("todo");
  expect(stillOpen.question_answer).toBeNull();
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("blocked");

  // one answer per item, submitted together, completes the question atomically
  const full = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["clerk", "eu-west"],
  });
  expect(full.status).toBe(200);
  expect(full.json.status).toBe("done");
  expect(full.json.question_answer).toEqual(["clerk", "eu-west"]);

  // acceptance is counted per item (issue #30): the first matches its
  // recommendation, the second overrides it
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  const answered = events.find((e: any) => e.kind === "question_answered");
  expect(answered.payload).toEqual({
    kind: "question_answered",
    answers: [
      { answer: "clerk", recommendation_accepted: true },
      { answer: "eu-west", recommendation_accepted: false },
    ],
    recommended_by: "fake-worker",
  });

  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("in_progress");
});

it("answering is a human steering channel: no MCP tool exposes it", async () => {
  t = await bootTidepool();
  const client = await mcpClient(t.mcpBaseUrl);
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name);
  expect(names).toContain("escalate");
  expect(names.filter((n) => /answer|respond|reply/.test(n))).toEqual([]);
  await client.close();
});
