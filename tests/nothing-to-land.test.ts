import { afterEach, expect, it, vi } from "vitest";
import {
  api,
  bootTidepool,
  commitWork,
  completeIntegrationReviews,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  registerWork,
  squashTaskIntoOrigin,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;

afterEach(async () => {
  await t?.stop();
});

it("purely-local の root work が差分ゼロで完了すると、merge question を立てず着地対象なしを記録する", async () => {
  const workspace = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "inspect without changing files");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const completed: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();
  await completeIntegrationReviews(t, task.id);

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
  const { workspace } = await makeRemoteBackedWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "verify the existing result");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const completed: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();
  await completeIntegrationReviews(t, task.id);

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
  const { workspace } = await makeRemoteBackedWorkspace("content-landed");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "finish work already landed by content");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "same result\n");
  await squashTaskIntoOrigin(workspace, task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const completed: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();
  await completeIntegrationReviews(t, task.id);

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
