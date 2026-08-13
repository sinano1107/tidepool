import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import {
  addTaskChange,
  api,
  bootTidepool,
  FULL_HANDOFF,
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
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const MINUTE = 60 * 1000;

it("prod workspace の低リスクタスクの auto_if_ci_green poll は、CI チェックと merge を prod の checkout に対して行う", async () => {
  const sandbox = await makeWorkspace(dirs, "sandbox");
  const { workspace: prod } = await makeRemoteBackedWorkspace(dirs, "prod");
  const registry: Record<string, WorkspaceConfig> = { sandbox, prod };
  t = await bootTidepool({
    workspace: sandbox,
    resolveWorkspace: (name) => {
      const ws = registry[name ?? "sandbox"];
      if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
      return ws;
    },
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });

  const task = await registerWork(t, "ship in prod", "prod");
  await t.clock.advance(HOUR);
  addTaskChange(prod.path, task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  // no question — queued for the poll
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);

  t.github.scriptCiStatus("success");
  await t.clock.advance(MINUTE);

  expect(t.github.merged).toEqual([{ path: prod.path, number: 1 }]);
});
