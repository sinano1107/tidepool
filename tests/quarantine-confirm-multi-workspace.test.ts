import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  commitWork,
  FULL_HANDOFF,
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

it("非既定 workspace(prod)の quarantine は、ツリーがクリーンな状態で回答すれば解除され、prod の pickup が再開する", async () => {
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

  // break prod's tree rule so completing it quarantines only "prod"
  commitWork(prod.path, "junk.txt", "uncommittable\n");
  await rm(join(prod.path, ".git"), { recursive: true, force: true });
  const client = await mcpClient(t.mcpBaseUrl, inProd.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board.find((x: any) => x.type === "question" && x.title.includes("prod"));
  expect(question).toBeDefined();

  // a task queued behind the quarantined prod workspace is stuck
  const stuckInProd = await registerWork(t, "stuck", "prod");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x: any) => x.id)).not.toContain(stuckInProd.id);

  // repair prod for real
  git(prod.path, "init", "-b", "main");
  git(prod.path, "add", "-A");
  git(prod.path, "commit", "-m", "manual repair");

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(res.status).toBe(200);
  expect(res.json.status).toBe("done");

  // pickup resumes at once (no need to advance the clock)
  expect(t.worker.started.map((x: any) => x.id)).toContain(stuckInProd.id);
});
