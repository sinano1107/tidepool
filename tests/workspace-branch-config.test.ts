import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import {
  bootTidepool,
  FULL_HANDOFF as fullHandoff,
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
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("issue #27: workspace ごとの保護ブランチ設定", () => {
  it("branch: master な workspace のタスクは master 起点で fork され、master base で PR が開く", async () => {
    const prod = await makeWorkspace(dirs, "prod");
    git(prod.path, "branch", "master");
    const registry: Record<string, WorkspaceConfig> = {
      prod: { ...prod, branch: "master" },
    };
    t = await bootTidepool({
      workspace: prod,
      resolveWorkspace: (name) => {
        const ws = registry[name ?? "prod"];
        if (!ws) throw new UnknownWorkspaceError(name ?? "prod");
        return ws;
      },
    });

    const task = await registerWork(t, "runs against master", "prod");
    await t.clock.advance(HOUR);
    expect(git(prod.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);

    const client = await mcpClient(t.mcpBaseUrl, task.id);
    const res: any = await client.callTool({
      name: "complete_task",
      arguments: { handoff: fullHandoff },
    });
    expect(res.isError ?? false).toBe(false);
    await client.close();

    expect(t.github.requests).toHaveLength(1);
    expect(t.github.requests[0]).toMatchObject({
      path: prod.path,
      branch: `task/${task.id}`,
      base: "master",
    });
  });
});
