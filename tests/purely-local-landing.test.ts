import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  commitWork,
  FULL_HANDOFF,
  git,
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
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("purely-local の root work 完了は PR を試みず、代わりに着地 question を1本立てる", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const completed: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();

  expect(completed.isError ?? false).toBe(false);
  expect(t.github.requests).toEqual([]);
  const questions = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (candidate: any) => candidate.type === "question",
  );
  expect(questions).toHaveLength(1);
  expect(questions[0]).toMatchObject({
    purpose: expect.stringContaining("has no GitHub merge surface"),
    question_items: [{ options: ["merge", "hold"], recommendation: "merge" }],
  });
  expect(questions[0].title).not.toContain("PR promotion failed");
});

it("purely-local では auto_if_ci_green を無人 merge に使わず、観測不能の理由を question に書く", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace,
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });
  const task = await registerWork(t, "ship automatically");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "automatic.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.type === "question",
  );
  expect(question.purpose).toContain(
    "CI cannot be observed and auto_if_ci_green cannot auto-merge",
  );
  expect(t.github.requests).toEqual([]);
  await t.clock.advance(60 * 1000);
  expect(t.github.merged).toEqual([]);
});

it("着地 question に merge と答えると保護ブランチを task branch へ fast-forward する", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "land the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  expect(git(workspace.path, "rev-list", "--count", `main..task/${task.id}`)).toBe("1");
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.type === "question",
  );

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["merge"],
  });

  expect(answered.status).toBe(200);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${task.id}`)).toBe("0");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({
    status: "done",
    question_answer: ["merge"],
  });
});

it("保護ブランチが帯域外で進んで fast-forward できないと workspace を quarantine し、着地 question を開いたままにする", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "land without overwriting main");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const landingQuestion = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.question_pending_local_merge_task_id === task.id,
  );
  writeFileSync(join(workspace.path, "out-of-band.txt"), "moved by hand\n");
  git(workspace.path, "add", "out-of-band.txt");
  git(workspace.path, "commit", "-m", "out-of-band protected branch move");

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${landingQuestion.id}/answer`, {
    answers: ["merge"],
  });

  expect(answered.status).toBe(409);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((candidate: any) => candidate.id === landingQuestion.id).status).toBe("todo");
  expect(
    board.find(
      (candidate: any) =>
        candidate.type === "question" && candidate.question_quarantine_workspace === "sandbox",
    ),
  ).toBeDefined();
});

it("着地 question に hold と答えると保護ブランチを動かさず決着し、再提示しない", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "keep the result on its task branch");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "held.txt", "held result\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.question_pending_local_merge_task_id === task.id,
  );

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["hold"],
  });

  expect(answered.status).toBe(200);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${task.id}`)).toBe("1");
  await t.clock.advance(HOUR);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({
    status: "done",
    question_answer: ["hold"],
  });
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(
    board.filter(
      (candidate: any) =>
        candidate.status === "todo" &&
        candidate.question_pending_local_merge_task_id === task.id,
    ),
  ).toEqual([]);
});
