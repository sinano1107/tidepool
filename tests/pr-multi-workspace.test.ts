import { afterEach, expect, it, vi } from "vitest";
import {
  bootTidepool,
  commitWork,
  completeIntegrationReviews,
  defaultingTo,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

it("prod workspace のタスクを complete すると、PR は sandbox ではなく prod の checkout に向けて作られる", async () => {
  const sandbox = await makeWorkspace("sandbox");
  const { workspace: prod } = await makeRemoteBackedWorkspace("prod");
  t = await bootTidepool({
    workspace: sandbox,
    resolveWorkspace: defaultingTo(sandbox, prod),
  });

  const task = await registerWork(t, "ship in prod", "prod");
  await t.clock.advance(HOUR);
  commitWork(prod.path, "release.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);

  expect(t.github.requests).toHaveLength(1);
  expect(t.github.requests[0]).toMatchObject({ path: prod.path, branch: `task/${task.id}` });
});
