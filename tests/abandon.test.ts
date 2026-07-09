import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WorkspaceConfig } from "../src/workspace.js";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
let wsPath: string | undefined;
afterEach(async () => {
  await t?.stop();
  if (wsPath) await rm(wsPath, { recursive: true, force: true });
  wsPath = undefined;
});

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir },
  )
    .toString()
    .trim();
}

async function makeWorkspace(): Promise<WorkspaceConfig> {
  const path = await mkdtemp(join(tmpdir(), "tidepool-ws-"));
  wsPath = path;
  git(path, "init", "-b", "main");
  writeFileSync(join(path, "README.md"), "workspace\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "initial");
  return { name: "sandbox", path };
}

const MIN = 60 * 1000;
const WORK_LIMIT = 90 * MIN;

it("abandon の回答で計画ごと破棄される: 失敗タスクと兄弟が cancelled になり、親が先頭復帰して再ピックアップされる", async () => {
  const grace = 30 * MIN;
  const ws = await makeWorkspace();
  t = await bootTidepool({
    workspace: ws,
    watchdog: { timeLimits: { work: WORK_LIMIT }, grace },
  });

  const plan = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "plan",
      purpose: "plan purpose",
      completion_criteria: "plan criteria",
    })
  ).json;
  await t.clock.advance(HOUR); // plan picked up
  const client = await mcpClient(t.baseUrl, plan.id);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "split into two children based on the same decision",
      children: [
        { title: "will fail", purpose: "purpose", completion_criteria: "criteria" },
        { title: "sibling", purpose: "purpose", completion_criteria: "criteria" },
      ],
    },
  });
  await client.close();

  const board0 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const failing = board0.find((x: any) => x.title === "will fail");
  const sibling = board0.find((x: any) => x.title === "sibling");

  await t.clock.advance(HOUR); // "will fail" picked up
  writeFileSync(join(ws.path, "draft.txt"), "stuck work\n");
  await t.clock.advance(90 * MIN); // SIGTERM
  await t.clock.advance(grace); // SIGKILL — failure question registered

  const board1 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board1.find((x: any) => x.type === "question");

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "abandon" });

  const board2 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board2.find((x: any) => x.id === failing.id).status).toBe("cancelled");
  expect(board2.find((x: any) => x.id === sibling.id).status).toBe("cancelled");
  expect(board2.find((x: any) => x.id === question.id).status).toBe("done");

  const failEvents = (await api(t.baseUrl, "GET", `/api/tasks/${failing.id}/events`)).json;
  const cancelled = failEvents.find((e: any) => e.kind === "task_cancelled");
  expect(cancelled).toBeDefined();
  expect(cancelled.payload.origin_question_id).toBe(question.id);

  // the plan (parent) returns to the queue head — blocked derivation clears
  // once its children are all done/cancelled — and the free slot picks it
  // up at once (same "answer = human steering = head" rule as retry)
  const planAfter = board2.find((x: any) => x.id === plan.id);
  expect(planAfter.status).toBe("in_progress");
  expect(t.worker.started.map((x: any) => x.title)).toEqual(["plan", "will fail", "plan"]);
});

const fullHandoff = {
  outcome: "done before the sibling failed",
  deliverables: "n/a",
  decision_refs: "n/a",
  dead_ends: "n/a",
  resume_context: "n/a",
  known_issues: "n/a",
};

it("abandon のカスケードは done の兄弟には触れない(記録は劣化しない)", async () => {
  const grace = 30 * MIN;
  const ws = await makeWorkspace();
  t = await bootTidepool({
    workspace: ws,
    watchdog: { timeLimits: { work: WORK_LIMIT }, grace },
  });

  const plan = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "plan2",
      purpose: "plan purpose",
      completion_criteria: "plan criteria",
    })
  ).json;
  await t.clock.advance(HOUR); // plan picked up
  const decomposeClient = await mcpClient(t.baseUrl, plan.id);
  await decomposeClient.callTool({
    name: "decompose",
    arguments: {
      reason: "split into three children based on the same decision",
      children: [
        { title: "finishes early", purpose: "purpose", completion_criteria: "criteria" },
        { title: "will fail 2", purpose: "purpose", completion_criteria: "criteria" },
        { title: "sibling 2", purpose: "purpose", completion_criteria: "criteria" },
      ],
    },
  });
  await decomposeClient.close();

  const board0 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const finished = board0.find((x: any) => x.title === "finishes early");
  const failing = board0.find((x: any) => x.title === "will fail 2");
  const sibling = board0.find((x: any) => x.title === "sibling 2");

  await t.clock.advance(HOUR); // "finishes early" picked up (lowest sort_key)
  const completeClient = await mcpClient(t.baseUrl, finished.id);
  await completeClient.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  await completeClient.close();
  expect((await api(t.baseUrl, "GET", `/api/tasks/${finished.id}`)).json.status).toBe("done");

  await t.clock.advance(HOUR); // "will fail 2" picked up next
  writeFileSync(join(ws.path, "draft2.txt"), "stuck work\n");
  await t.clock.advance(90 * MIN); // SIGTERM
  await t.clock.advance(grace); // SIGKILL — failure question registered

  const board1 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board1.find(
    (x: any) => x.type === "question" && x.question_options?.includes("abandon"),
  );

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "abandon" });

  const board2 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // the cascade only ever touches unfinished descendants — a task that
  // already completed keeps its record exactly as it was
  expect(board2.find((x: any) => x.id === finished.id).status).toBe("done");
  expect(board2.find((x: any) => x.id === failing.id).status).toBe("cancelled");
  expect(board2.find((x: any) => x.id === sibling.id).status).toBe("cancelled");

  const finishedEvents = (await api(t.baseUrl, "GET", `/api/tasks/${finished.id}/events`)).json;
  expect(finishedEvents.some((e: any) => e.kind === "task_cancelled")).toBe(false);
});
