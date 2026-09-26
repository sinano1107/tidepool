import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import {
  addTaskChange,
  api,
  bootTidepool,
  completeIntegrationReviews,
  FULL_HANDOFF,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

it("prod workspace のタスクの merge 回答は、CI チェックと merge を prod の checkout に対して行う", async () => {
  const sandbox = await makeWorkspace("sandbox");
  const { workspace: prod } = await makeRemoteBackedWorkspace("prod");
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
  addTaskChange(prod.path, task.id);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, task.id);

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
