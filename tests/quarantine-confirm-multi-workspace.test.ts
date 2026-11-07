import { afterEach, expect, it, vi } from "vitest";
import {
  api,
  bootTidepool,
  commitWork,
  defaultingTo,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
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

it("非既定 workspace(prod)の quarantine は、ツリーがクリーンな状態で回答すれば解除され、prod の pickup が再開する", async () => {
  const sandbox = await makeWorkspace("sandbox");
  const prod = await makeWorkspace("prod");
  t = await bootTidepool({
    workspace: sandbox,
    resolveWorkspace: defaultingTo(sandbox, prod),
  });

  const inProd = await registerWork(t, "runs in prod", "prod");
  await t.clock.advance(HOUR);

  // break prod's release so completing it quarantines only "prod": an out-of-band commit on prod's main moves a ref the
  // board did not write (ADR 0351). 旧: prod の .git を消した —— 完了の門が tip を引けず完了を拒むようになった(ADR 0356 決定3)
  commitWork(prod.path, "junk.txt", "out of band\n");
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

  // repair prod for real: the out-of-band commit stays, and acceptance retakes the baseline (ADR 0351 決定4)
  expect(git(prod.path, "status", "--porcelain")).toBe("");

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["repaired by hand"],
  });
  expect(res.status).toBe(200);
  expect(res.json.status).toBe("done");

  // pickup resumes at once (no need to advance the clock)
  expect(t.worker.started.at(-1)).toMatchObject({ type: "review", parent_id: inProd.id, workspace: "prod" });
});
