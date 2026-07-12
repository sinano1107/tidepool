import { rm } from "node:fs/promises";
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

it("prod workspace のタスクの merge 回答は、CI チェックと merge を prod の checkout に対して行う", async () => {
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
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });

  const task = await registerWork(t, "ship in prod", "prod");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board.find((x: any) => x.type === "question");
  expect(question).toBeDefined();

  t.github.scriptCiStatus("success");
  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["merge"],
  });
  expect(res.status).toBe(200);

  expect(t.github.ciChecks).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: prod.path })]),
  );
  expect(t.github.merged).toEqual([{ path: prod.path, number: 1 }]);
});
