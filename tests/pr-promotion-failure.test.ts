import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it("a failed PR promotion leaves the work done and asks Tidepool whether to retry or abandon promotion", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  t.github.scriptFailure(new Error("token expired"));
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const completed: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();

  expect(completed.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board.find((x: any) => x.type === "question");
  expect(question).toMatchObject({
    assignee: null,
    question_items: [
      {
        options: ["retry", "abandon promotion"],
        recommendation: "retry",
      },
    ],
  });
});

it("retrying a failed PR promotion opens the PR before settling the failure question", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  t.github.scriptFailure(new Error("token expired"));
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question",
  );
  t.github.scriptFailure(null);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["retry"],
  });

  expect(answered.status).toBe(200);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({
    status: "done",
    question_answer: ["retry"],
  });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.pr_number).toBe(1);
  expect(t.github.requests).toHaveLength(2);
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).toContainEqual(
    expect.objectContaining({ question_pending_merge_pr: 1 }),
  );
});

it("a failed retry rejects the answer with the promotion error and keeps the question open", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  t.github.scriptFailure(new Error("token expired"));
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question",
  );

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["retry"],
  });

  expect(answered).toMatchObject({ status: 409, json: { error: "token expired" } });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({
    status: "todo",
    question_answer: null,
  });
  expect(t.github.requests).toHaveLength(2);
});

it("abandoning PR promotion settles the failure question without changing completed work", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  t.github.scriptFailure(new Error("token expired"));
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question",
  );

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["abandon promotion"],
  });

  expect(answered.status).toBe(200);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({
    status: "done",
    question_answer: ["abandon promotion"],
  });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json).toMatchObject({
    status: "done",
    pr_number: null,
  });
  expect(t.github.requests).toHaveLength(1);
  // the give-up itself is a recorded decision (issue #66): the completed task
  // carries work that never reached a PR, and the log is the only trace why
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  const decision = events.find((e: any) => e.kind === "decision_logged");
  expect(decision.payload.line).toContain(task.id);
});

it("a settled failure question cannot be re-answered into a retry", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  t.github.scriptFailure(new Error("token expired"));
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question",
  );
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["abandon promotion"],
  });
  t.github.scriptFailure(null);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["retry"],
  });

  // the abandon decision is final: the late retry must be rejected before its
  // side effect, not after — no PR gets created, no merge question appears
  expect(answered.status).toBe(409);
  expect(t.github.requests).toHaveLength(1);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.pr_number).toBeNull();
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).not.toContainEqual(
    expect.objectContaining({ question_pending_merge_pr: 1 }),
  );
});
