import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  addTaskChange,
  api,
  bootTidepool,
  FULL_HANDOFF as fullHandoff,
  HOUR,
  makeRemoteBackedWorkspace,
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

it("completing a work task under the escalate merge dial registers a merge-decision question referencing the opened PR", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(ws.path, task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  expect(t.github.requests).toHaveLength(1);

  const done = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(done.pr_number).toBe(1);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board.find((x: any) => x.type === "question" && x.parent_id === null);
  expect(question).toBeDefined();
  expect(question.question_items[0].options).toEqual(["merge", "hold"]);
  expect(question.question_items[0].recommendation).toBe("merge");
});

it("completing a work task under the external merge dial opens the PR and stops there — no question, nothing queued for the unattended poll (ADR 0079)", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "external" },
  });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(ws.path, task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  expect(t.github.requests).toHaveLength(1);
  const done = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(done.pr_number).toBe(1);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);

  // the merge lives on GitHub's own PR surface: no unattended merge is queued
  // either, so the poll must stay idle rather than merge behind the human
  t.github.scriptCiStatus("success");
  await t.clock.advance(60 * 1000);
  expect(t.github.merged).toEqual([]);
});

it("completing a work task under a code-built profile carrying no dial opens the PR without any merge-decision question (the reviewer floor's shape — registry profiles must declare one)", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(ws.path, task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  expect(t.github.requests).toHaveLength(1);
  const done = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(done.pr_number).toBe(1);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
});

async function completeUnderEscalate(t: Tidepool, path: string) {
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(path, task.id);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board.find((x: any) => x.type === "question");
  return { task, question };
}

it("answering a merge-decision question with \"merge\" while CI is green performs the actual merge", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const { question } = await completeUnderEscalate(t, ws.path);
  t.github.scriptCiStatus("success");

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["merge"],
  });
  expect(answered.status).toBe(200);

  expect(t.github.merged).toEqual([{ path: ws.path, number: 1 }]);

  const answeredQuestion = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(answeredQuestion.status).toBe("done");
  expect(answeredQuestion.question_answer).toEqual(["merge"]);
});

it("answering \"merge\" while CI is not green is rejected, and the question stays open to retry", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const { question } = await completeUnderEscalate(t, ws.path);
  t.github.scriptCiStatus("pending");

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["merge"],
  });
  expect(answered.status).toBe(409);

  expect(t.github.merged).toEqual([]);

  const stillOpen = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(stillOpen.status).toBe("todo");
});

it("a malformed POST (answer count mismatch) to an open merge question is rejected before any CI check or merge (issue #111)", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const { question } = await completeUnderEscalate(t, ws.path);
  t.github.scriptCiStatus("success");

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["merge", "x"],
  });
  expect(answered.status).toBe(409);

  // before issue #111 this ran the live CI check and the real merge before
  // answerQuestion's own length validation ever threw — leaving GitHub
  // actually merged while the board recorded nothing
  expect(t.github.ciChecks).toEqual([]);
  expect(t.github.merged).toEqual([]);

  const stillOpen = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(stillOpen.status).toBe("todo");
});

it("answering \"hold\" resolves the question without checking CI or merging", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const { question } = await completeUnderEscalate(t, ws.path);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["hold"],
  });
  expect(answered.status).toBe(200);

  expect(t.github.ciChecks).toEqual([]);
  expect(t.github.merged).toEqual([]);
});

const MINUTE = 60 * 1000;

it("a low-risk task under auto_if_ci_green queues for auto-merge instead of asking, then merges once the poll sees CI green", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(ws.path, task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  // no question yet — it's queued for the poll, not asked
  let board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
  expect(t.github.merged).toEqual([]);

  t.github.scriptCiStatus("pending");
  await t.clock.advance(MINUTE);
  expect(t.github.merged).toEqual([]);
  board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);

  t.github.scriptCiStatus("success");
  await t.clock.advance(MINUTE);
  expect(t.github.merged).toEqual([{ path: ws.path, number: 1 }]);

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  expect(events.filter((e: any) => e.kind === "pr_merged")).toEqual([
    expect.objectContaining({ payload: { kind: "pr_merged", pr_number: 1 } }),
  ]);
});

it("a CI failure during the auto_if_ci_green poll converts the queued auto-merge into an escalation question instead of merging", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  addTaskChange(ws.path, task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  t.github.scriptCiStatus("failure");
  await t.clock.advance(MINUTE);

  expect(t.github.merged).toEqual([]);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board.find((x: any) => x.type === "question");
  expect(question).toBeDefined();
  expect(question.question_items[0].options).toEqual(["merge", "hold"]);
  expect(question.question_items[0].recommendation).toBe("hold");
});

it("a risky decomposed child merges back, then its root integration PR asks for approval instead of auto-merge", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up

  const parentClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await parentClient.callTool({
    name: "decompose",
    arguments: {
      reason: "this piece touches prod data",
      children: [
        {
          title: "risky child",
          purpose: "touch prod data",
          completion_criteria: "prod data is updated",
          risk_flag: true,
        },
      ],
    },
  });
  await parentClient.close();

  const riskQuestion = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question" && x.parent_id === parent.id,
  );
  await api(t.baseUrl, "POST", `/api/tasks/${riskQuestion.id}/answer`, { answers: ["approve"] });

  await t.clock.advance(HOUR); // risky child picked up
  const child = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.title === "risky child",
  );
  addTaskChange(ws.path, child.id);
  const childClient = await mcpClient(t.mcpBaseUrl, child.id);
  await childClient.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await childClient.close();

  // The child returns to the parent's integration branch without its own PR.
  expect(t.github.requests).toEqual([]);

  await t.clock.advance(HOUR); // parent resumes for integration
  const resumedParent = await mcpClient(t.mcpBaseUrl, parent.id);
  await resumedParent.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await resumedParent.close();

  // The approved child's risk propagated to the parent, so the one integration
  // PR asks right away and is never queued for the unattended poll.
  expect(t.github.requests).toHaveLength(1);
  expect(t.github.requests[0]?.branch).toBe(`task/${parent.id}`);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const mergeQuestion = board.find(
    (x: any) => x.type === "question" && x.title.startsWith("merge PR"),
  );
  expect(mergeQuestion).toBeDefined();
  expect(mergeQuestion.question_items[0].options).toEqual(["merge", "hold"]);

  await t.clock.advance(MINUTE); // the auto-merge poll ticks; nothing was queued
  expect(t.github.merged).toEqual([]);
});

it("a settled merge-decision question cannot be re-answered into a merge", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const { question } = await completeUnderEscalate(t, ws.path);
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["hold"],
  });
  t.github.scriptCiStatus("success");

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["merge"],
  });

  // the hold decision is final: the late "merge" must be rejected before its
  // side effect, not after — no CI check runs, no merge happens
  expect(answered.status).toBe(409);
  expect(t.github.ciChecks).toEqual([]);
  expect(t.github.merged).toEqual([]);
});
