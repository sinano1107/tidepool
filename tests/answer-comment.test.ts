import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

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
    expect(payload.children).toEqual([
      {
        title: escalation.questions[0]!.title,
        status: "done",
        items: escalation.questions,
        answer: ["auth0"],
        comment: "clerk はロックインが強すぎる、auth0 で",
      },
    ]);
  } finally {
    await client.close();
  }
});
