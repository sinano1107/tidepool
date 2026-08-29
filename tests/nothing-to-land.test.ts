import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  commitWork,
  FULL_HANDOFF,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
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

async function squashTaskIntoOrigin(path: string, origin: string, taskId: string): Promise<void> {
  const merger = await mkdtemp(join(tmpdir(), "tidepool-nothing-to-land-squash-"));
  dirs.push(merger);
  git(merger, "clone", origin, ".");
  git(merger, "fetch", path, `task/${taskId}:landed`);
  git(merger, "merge", "--squash", "landed");
  git(merger, "commit", "-m", "squash task outside the board");
  git(merger, "push", "origin", "main");
}

it("promotion retry の時点で差分ゼロなら、人間にエラーを返して failure question を開いたままにする", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  t.github.scriptFailure(new Error("token expired"));
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.question_pending_pr_promotion_task_id === task.id,
  );
  git(
    workspace.path,
    "update-ref",
    "refs/remotes/origin/main",
    `refs/heads/task/${task.id}`,
  );
  t.github.scriptFailure(null);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["retry"],
  });

  expect(answered).toMatchObject({
    status: 409,
    json: { error: 'task branch has nothing to land on "refs/remotes/origin/main"' },
  });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({
    status: "todo",
    question_answer: null,
  });
  expect(t.github.requests).toHaveLength(1);
});

it("purely-local の root work が差分ゼロで完了すると、merge question を立てず着地対象なしを記録する", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "inspect without changing files");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const completed: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();

  expect(completed.isError ?? false).toBe(false);
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).not.toContainEqual(
    expect.objectContaining({ type: "question" }),
  );
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json).toContainEqual(
    expect.objectContaining({
      worker_id: "tidepool",
      origin: "board",
      kind: "nothing_to_land",
      payload: { kind: "nothing_to_land", base: "main" },
    }),
  );
});

it("remote-backed の root work が差分ゼロで完了すると、PR を開かず着地対象なしを記録する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "verify the existing result");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const completed: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();

  expect(completed.isError ?? false).toBe(false);
  expect(t.github.requests).toEqual([]);
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).not.toContainEqual(
    expect.objectContaining({ type: "question" }),
  );
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json).toContainEqual(
    expect.objectContaining({
      worker_id: "tidepool",
      origin: "board",
      kind: "nothing_to_land",
      payload: { kind: "nothing_to_land", base: "refs/remotes/origin/main" },
    }),
  );
});

it("同じ内容が squash で保護ブランチへ着地済みなら、履歴が分岐していても PR を開かず着地対象なしを記録する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "content-landed");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "finish work already landed by content");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "same result\n");
  await squashTaskIntoOrigin(workspace.path, workspace.repo!, task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const completed: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();

  expect(completed.isError ?? false).toBe(false);
  expect(t.github.requests).toEqual([]);
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).not.toContainEqual(
    expect.objectContaining({ type: "question" }),
  );
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json).toContainEqual(
    expect.objectContaining({
      worker_id: "tidepool",
      origin: "board",
      kind: "nothing_to_land",
      payload: {
        kind: "nothing_to_land",
        base: "refs/remotes/origin/main",
      },
    }),
  );
});
