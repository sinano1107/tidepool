import { afterEach, expect, it, vi } from "vitest";
import {
  api,
  bootTidepool,
  checkoutOf,
  commitWork,
  completeIntegrationReviews,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  registerQuestion,
  registerWork,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

const fullHandoff = {
  outcome: "done as specified",
  deliverables: "notes.txt on the task branch",
  decision_refs: "none",
  dead_ends: "none",
  resume_context: "none needed",
  known_issues: "none",
};

it("work タスクの complete_task 成立後、タスクブランチから PR が作成される", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "build the thing");
  await t.clock.advance(HOUR);
  commitWork(checkoutOf(t.db, task.id), "result.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  await completeIntegrationReviews(t, task.id);

  expect(t.github.requests).toHaveLength(1);
  expect(t.github.requests[0]).toMatchObject({
    path: ws.path,
    branch: `task/${task.id}`,
    base: "main",
    title: "build the thing",
  });
});

it("PR 本文がハンドオフドキュメントの6項目を反映している", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "write the report");
  await t.clock.advance(HOUR);
  commitWork(checkoutOf(t.db, task.id), "report.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await client.close();

  await completeIntegrationReviews(t, task.id);

  const body = t.github.requests[0]?.body ?? "";
  expect(body).toContain("Outcome vs completion criteria");
  expect(body).toContain(fullHandoff.outcome);
  expect(body).toContain("Deliverable locations");
  expect(body).toContain(fullHandoff.deliverables);
  expect(body).toContain("Key decision-log references");
  expect(body).toContain(fullHandoff.decision_refs);
  expect(body).toContain("Dead ends tried");
  expect(body).toContain(fullHandoff.dead_ends);
  expect(body).toContain("Context needed to resume");
  expect(body).toContain(fullHandoff.resume_context);
  expect(body).toContain("Known issues not worth a task");
  expect(body).toContain(fullHandoff.known_issues);
});

it("PR 作成が失敗しても complete_task 自体は成立し、ツリーはクリーンなまま", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);

  commitWork(checkoutOf(t.db, task.id), "notes.txt", "shipped\n");
  t.github.scriptFailure(new Error("GitHub API is down"));
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const done = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(done.status).toBe("done");
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "show", `task/${task.id}:notes.txt`)).toBe("shipped");
});

it("review タスクの complete_task では PR が作られない", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "review the sensor choice",
      purpose: "unblock the hardware order",
      completion_criteria: "the choice is confirmed",
    })
  ).json;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({ name: "complete_task", arguments: { handoff: { outcome: "no findings" } } });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  expect(t.github.requests).toHaveLength(0);
});

// 旧: 名前の場所の .git を壊して WIP コミットを失敗させた —— 完了の門が名前の場所へ tip を引くので、今は門で拒まれる
it("解放が名前の場所の側で失敗して workspace が quarantine された場合は PR が作られない(ADR 0356 決定2・4)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t, "doomed work");
  await t.clock.advance(HOUR);

  commitWork(checkoutOf(t.db, task.id), "junk.txt", "finished\n");
  // session の間に名前の場所の ref が盤面の口の外で動く —— 解放の比較が quarantine に落とす
  git(ws.path, "tag", "out-of-band");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false); // 完了自体は成立している

  const done = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(done.status).toBe("done");
  await client.close();

  // WIP が乗っていない(乗せられなかった)ブランチに向けて PR は作られない
  expect(t.github.requests).toHaveLength(0);
});

it("question タスクの完了(回答)では PR が作られない", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = registerQuestion(t, {
    title: "which approach?",
    purpose: "pick a direction",
    completion_criteria: "a human answer is recorded",
    question: [{ title: "which approach?", options: ["a", "b"], recommendation: "a" }],
  });

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${task.id}/answer`, {
    answers: ["a"],
  });
  expect(answered.status).toBe(200);

  expect(t.github.requests).toHaveLength(0);
});
