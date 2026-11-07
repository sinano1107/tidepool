import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addTaskChange,
  bootTidepool,
  checkoutOf,
  completeIntegrationReviews,
  defaultingTo,
  FULL_HANDOFF as fullHandoff,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

describe("issue #27: workspace ごとの保護ブランチ設定", () => {
  it("branch: master な workspace のタスクは master 起点で fork され、master base で PR が開く", async () => {
    const { workspace: prod } = await makeRemoteBackedWorkspace("prod");
    git(prod.path, "branch", "master");
    git(prod.path, "push", "origin", "master");
    t = await bootTidepool({
      workspace: prod,
      resolveWorkspace: defaultingTo({ ...prod, branch: "master" }),
    });

    const task = await registerWork(t, "runs against master", "prod");
    await t.clock.advance(HOUR);
    addTaskChange(checkoutOf(t.db, task.id), task.id);
    // ADR 0356 決定1: タスクブランチは名前の場所の master から ref として切られ、名前の場所の HEAD は保護ブランチに居る
    expect(git(prod.path, "merge-base", "--is-ancestor", "master", `task/${task.id}`)).toBe("");
    expect(git(prod.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");

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
      path: prod.path,
      branch: `task/${task.id}`,
      base: "master",
    });
  });
});
