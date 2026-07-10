import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const escalation = {
  title: "which auth provider?",
  context: "two viable providers with a cost/lock-in tradeoff; out of my authority",
  options: ["auth0", "clerk", "keycloak"],
  recommendation: "clerk",
};

it("escalate registers a question child, blocks the parent, and releases the slot", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot
  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({ name: "escalate", arguments: escalation });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");
  expect(question.parent_id).toBe(parent.id);
  expect(question.status).toBe("todo");
  expect(question.question_options).toEqual(["auth0", "clerk", "keycloak"]);
  expect(question.question_recommendation).toBe("clerk");

  // blocked is derived from the unfinished child, and the board says so
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("blocked");

  // slot freed: the next tick hands the slot to fresh work, skipping both the
  // blocked parent and the question (a human task, answered outside the slot)
  const next = await registerWork(t, "next");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([parent.id, next.id]);
});

it("escalate refuses fewer than 2 or more than 4 options, or a recommendation outside them", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, parent.id);
  const invalid = [
    { options: ["only one"], recommendation: "only one" },
    { options: ["a", "b", "c", "d", "e"], recommendation: "a" },
    { options: ["a", "b"], recommendation: "" },
    { options: ["a", "b"], recommendation: "c" },
  ];
  try {
    for (const overrides of invalid) {
      const res: any = await client.callTool({
        name: "escalate",
        arguments: { ...escalation, ...overrides },
      });
      expect(res.isError, JSON.stringify(overrides)).toBe(true);
    }
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
  const client = await mcpClient(t.baseUrl, parentId);
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
    answer: "clerk",
  });
  expect(res.status).toBe(200);

  const answered = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(answered.status).toBe("done");
  expect(answered.question_answer).toBe("clerk");

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

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "clerk" });

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

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "clerk" });

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  const answered = events.filter((e: any) => e.kind === "question_answered");
  expect(answered).toHaveLength(1);
  expect(answered[0].worker_id).toBe("human");
  // recommended_by makes per-agent acceptance rates a one-event statistic
  expect(answered[0].payload).toEqual({
    kind: "question_answered",
    answer: "clerk",
    recommendation_accepted: true,
    recommended_by: "fake-worker",
  });
});

it("a free-text override answers the question and is recorded as non-acceptance", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: "use the in-house SSO gateway instead",
  });
  expect(res.status).toBe(200);
  expect(res.json.question_answer).toBe("use the in-house SSO gateway instead");
  expect(res.json.status).toBe("done");

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  const answered = events.find((e: any) => e.kind === "question_answered");
  expect(answered.payload.recommendation_accepted).toBe(false);
});

it("a question answers exactly once, and only questions answer at all", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await escalateFrom(t, parent.id);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "clerk" });
  const again = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: "auth0",
  });
  expect(again.status).toBe(409);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.question_answer).toBe(
    "clerk",
  );

  const onWork = await api(t.baseUrl, "POST", `/api/tasks/${parent.id}/answer`, {
    answer: "clerk",
  });
  expect(onWork.status).toBe(409);
});

it("every question carries 2-4 options and a recommendation, whichever door it enters by", async () => {
  t = await bootTidepool();
  const base = {
    type: "question",
    title: "standalone question",
    purpose: "a human wants steering input",
    completion_criteria: "answered",
  };
  // no options at all, and an invalid spec, are both refused at registration
  const bare = await api(t.baseUrl, "POST", "/api/tasks", base);
  expect(bare.status).toBe(400);
  const oneOption = await api(t.baseUrl, "POST", "/api/tasks", {
    ...base,
    question: { options: ["only"], recommendation: "only" },
  });
  expect(oneOption.status).toBe(400);

  const ok = await api(t.baseUrl, "POST", "/api/tasks", {
    ...base,
    question: { options: ["yes", "no"], recommendation: "no" },
  });
  expect(ok.status).toBe(201);
  const stored = (await api(t.baseUrl, "GET", `/api/tasks/${ok.json.id}`)).json;
  expect(stored.question_options).toEqual(["yes", "no"]);
  expect(stored.question_recommendation).toBe("no");
});

it("answering one of two open questions leaves the parent blocked; the last answer unblocks it", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const q1 = await escalateFrom(t, parent.id);
  const q2 = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "question",
      title: "second question",
      purpose: "another decision on the same parent",
      completion_criteria: "answered",
      parent_id: parent.id,
      question: { options: ["yes", "no"], recommendation: "yes" },
    })
  ).json;

  await api(t.baseUrl, "POST", `/api/tasks/${q1.id}/answer`, { answer: "clerk" });

  // still blocked on q2: no pickup, and no spurious move to the head
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("blocked");
  expect(t.worker.started.map((x) => x.id)).toEqual([parent.id]);
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${parent.id}/events`)).json;
  expect(events.filter((e: any) => e.kind === "task_moved")).toEqual([]);

  await api(t.baseUrl, "POST", `/api/tasks/${q2.id}/answer`, { answer: "yes" });
  expect(t.worker.started.map((x) => x.id)).toEqual([parent.id, parent.id]);
});

it("answering is a human steering channel: no MCP tool exposes it", async () => {
  t = await bootTidepool();
  const client = await mcpClient(t.baseUrl);
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name);
  expect(names).toContain("escalate");
  expect(names.filter((n) => /answer|respond|reply/.test(n))).toEqual([]);
  await client.close();
});
