import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import {
  api,
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

it("workspace が quarantine された間、その workspace の todo タスクはキュービューでは skipped、ボードでは todo のまま表示される", async () => {
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

  const inProd = await registerWork(t, "runs in prod", "prod");
  await t.clock.advance(HOUR);

  // break prod's tree rule so completing it quarantines "prod"
  writeFileSync(join(prod.path, "junk.txt"), "uncommittable\n");
  await rm(join(prod.path, ".git"), { recursive: true, force: true });
  const client = await mcpClient(t.baseUrl, inProd.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  const stuckInProd = await registerWork(t, "stuck in prod", "prod");
  const runsInSandbox = await registerWork(t, "keeps flowing in sandbox", "sandbox");
  await t.clock.advance(HOUR);

  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.find((x: any) => x.id === stuckInProd.id).status).toBe("skipped");
  expect(queue.find((x: any) => x.id === runsInSandbox.id).status).not.toBe("skipped");

  // the board itself keeps showing plain todo — skipped is queue-view-only
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.id === stuckInProd.id).status).toBe("todo");
});
