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

it("盤面の外で先に merge された PR の merge question は、「merge」回答が CI ゲートより先に観測へ変換されて決着する(ADR 0079 決定3)", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const { question } = await completeUnderEscalate(t, ws.path);
  t.github.scriptMergedOutside(1);
  // merge 済み PR は CI が赤/pending でも観測決着に到達しなければならない
  t.github.scriptCiStatus("pending");

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["merge"],
  });
  // 座礁(DomainError)ではなく、決着として受理される
  expect(answered.status).toBe(200);

  expect(t.github.ciChecks).toEqual([]);
  expect(t.github.merged).toEqual([]);

  const settled = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(settled.status).toBe("done");

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  expect(events.filter((e: any) => e.kind === "pr_merge_observed")).toEqual([
    expect.objectContaining({ payload: { kind: "pr_merge_observed", pr_number: 1 } }),
  ]);
  // 観測は執行と区別して綴られる(ADR 0079 決定4)
  expect(events.filter((e: any) => e.kind === "pr_merged")).toEqual([]);
});

it("同じ question に「hold」で回答しても観測決着になり、hold は決定として記録されない(ADR 0079 決定3)", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const { question } = await completeUnderEscalate(t, ws.path);
  t.github.scriptMergedOutside(1);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["hold"],
  });
  expect(answered.status).toBe(200);

  const settled = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(settled.status).toBe("done");
  // 誰も決めていない: 保留の決定が事後に捏造されてはならない
  expect(settled.question_answer).toBeNull();

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  expect(events.filter((e: any) => e.kind === "question_answered")).toEqual([]);
  expect(events.filter((e: any) => e.kind === "pr_merge_observed")).toHaveLength(1);
});

const MINUTE = 60 * 1000;

const SCAN = 10 * 60 * 1000;

it("open な merge question の PR が盤面の外で merge されていたら、独自の遅い走査が1 tick 以内に観測決着させる(ADR 0079 決定3)", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const { question } = await completeUnderEscalate(t, ws.path);
  t.github.scriptMergedOutside(1);

  // 60秒面は一切広げない — CI poll の周期では走査は動かない
  await t.clock.advance(MINUTE);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");
  expect(t.github.mergeChecks).toEqual([]);

  await t.clock.advance(SCAN);

  const settled = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(settled.status).toBe("done");
  expect(settled.question_answer).toBeNull();
  expect(t.github.merged).toEqual([]);

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  expect(events.filter((e: any) => e.kind === "pr_merge_observed")).toEqual([
    expect.objectContaining({ payload: { kind: "pr_merge_observed", pr_number: 1 } }),
  ]);
});

it("走査中に1枚の PR が読めなくても、走査は倒れず残りの question を観測する(快適性の機構は盤面を落とせない)", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  await completeUnderEscalate(t, ws.path);
  await completeUnderEscalate(t, ws.path);
  const questions = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((x: any) =>
    x.title.startsWith("merge PR"),
  );
  expect(questions).toHaveLength(2);

  // 網が届かない PR が先頭に来る(Pi のオフライン耐性)
  t.github.scriptMergeCheckFailure(1, new Error("gh: could not reach github.com"));
  t.github.scriptMergedOutside(2);

  await t.clock.advance(SCAN);

  const byPr = async (n: number) =>
    (await api(t.baseUrl, "GET", `/api/tasks/${questions.find((q: any) => q.title.includes(`#${n}`)).id}`))
      .json;
  expect((await byPr(1)).status).toBe("todo");
  expect((await byPr(2)).status).toBe("done");
});

it("external の PR は open な merge question を残さないので、走査は GitHub に1リクエストも撃たない(ADR 0079 決定2/3)", async () => {
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
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.pr_number).toBe(1);

  // PR は盤面の外で merge される — 観測しないことが宣言どおりの姿である
  t.github.scriptMergedOutside(1);
  await t.clock.advance(SCAN);

  expect(t.github.mergeChecks).toEqual([]);
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  expect(events.filter((e: any) => e.kind === "pr_merge_observed")).toEqual([]);
});

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

it("CI 待ち行の PR が盤面の外で merge されていたら、次の poll tick で観測記録つきに行がクリアされ、リトライが止まる(ADR 0079 決定3)", async () => {
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

  t.github.scriptMergedOutside(1);
  t.github.scriptCiStatus("success");
  await t.clock.advance(MINUTE);

  expect(t.github.merged).toEqual([]);
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  expect(events.filter((e: any) => e.kind === "pr_merge_observed")).toEqual([
    expect.objectContaining({ payload: { kind: "pr_merge_observed", pr_number: 1 } }),
  ]);
  expect(events.filter((e: any) => e.kind === "pr_merged")).toEqual([]);

  // 行が消えているので、次の tick はこの PR について GitHub に一切触れない
  const before = t.github.ciChecks.length;
  await t.clock.advance(MINUTE);
  expect(t.github.ciChecks).toHaveLength(before);
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

  // risk_flag forces a completion review on both the child and the (now risky)
  // parent; the integration's landing waits for every one of them (ADR 0092).
  expect(t.github.requests).toEqual([]);
  for (const reviewed of [child.id, parent.id]) {
    const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
      (x: any) => x.type === "review" && x.parent_id === reviewed,
    );
    await api(t.baseUrl, "POST", `/api/tasks/${review.id}/move`, { after: null });
    await t.clock.advance(HOUR); // the review is picked up
    const reviewClient = await mcpClient(t.mcpBaseUrl, review.id);
    await reviewClient.callTool({ name: "complete_task", arguments: {} });
    await reviewClient.close();
  }

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
