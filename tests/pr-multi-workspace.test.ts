import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import {
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

it("prod workspace のタスクを complete すると、PR は sandbox ではなく prod の checkout に向けて作られる", async () => {
  const sandbox = await makeWorkspace(dirs, "sandbox");
  const prod = await makeWorkspace(dirs, "prod");
  const registry: Record<string, WorkspaceConfig> = { sandbox, prod };
  t = await bootTidepool({
    workspace: sandbox,
    resolveWorkspace: (name) => {
      const ws = registry[name ?? "sandbox"];
      if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
      return ws;
    },
  });

  const task = await registerWork(t, "ship in prod", "prod");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  expect(t.github.requests).toHaveLength(1);
  expect(t.github.requests[0]).toMatchObject({ path: prod.path, branch: `task/${task.id}` });
});
