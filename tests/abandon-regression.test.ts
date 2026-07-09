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

it("failure question で「再実行」を選んでも、計画の残りは cancel されず既存の再実行挙動(#9)のまま", async () => {
  const grace = 30 * MIN;
  const ws = await makeWorkspace();
  t = await bootTidepool({
    workspace: ws,
    watchdog: { timeLimits: { work: WORK_LIMIT }, grace },
  });

  const plan = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "plan3",
      purpose: "plan purpose",
      completion_criteria: "plan criteria",
    })
  ).json;
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, plan.id);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "split into two children based on the same decision",
      children: [
        { title: "will fail 3", purpose: "purpose", completion_criteria: "criteria" },
        { title: "sibling 3", purpose: "purpose", completion_criteria: "criteria" },
      ],
    },
  });
  await client.close();

  const board0 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const failing = board0.find((x: any) => x.title === "will fail 3");
  const sibling = board0.find((x: any) => x.title === "sibling 3");

  await t.clock.advance(HOUR); // "will fail 3" picked up
  writeFileSync(join(ws.path, "draft3.txt"), "stuck work\n");
  await t.clock.advance(90 * MIN); // SIGTERM
  await t.clock.advance(grace); // SIGKILL — failure question registered

  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question",
  );
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "retry" });

  const board1 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // nothing was cancelled anywhere on the board
  expect(board1.some((x: any) => x.status === "cancelled")).toBe(false);
  expect(board1.find((x: any) => x.id === failing.id).status).toBe("in_progress");
  // the sibling, held while the question was open, is free again
  expect(board1.find((x: any) => x.id === sibling.id).status).toBe("todo");
});

it("cancel_option を持たない question に「abandon」という文字列を回答しても cancel は起きない", async () => {
  t = await bootTidepool();
  const parent = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "plain parent",
      purpose: "purpose",
      completion_criteria: "criteria",
    })
  ).json;
  await t.clock.advance(HOUR); // parent picked up
  const decomposeClient = await mcpClient(t.baseUrl, parent.id);
  await decomposeClient.callTool({
    name: "decompose",
    arguments: {
      reason: "split into two children based on the same decision",
      children: [
        { title: "escalates", purpose: "purpose", completion_criteria: "criteria" },
        { title: "plain sibling", purpose: "purpose", completion_criteria: "criteria" },
      ],
    },
  });
  await decomposeClient.close();

  const board0 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const escalating = board0.find((x: any) => x.title === "escalates");
  const sibling = board0.find((x: any) => x.title === "plain sibling");

  await t.clock.advance(HOUR); // "escalates" picked up
  const escalateClient = await mcpClient(t.baseUrl, escalating.id);
  const res: any = await escalateClient.callTool({
    name: "escalate",
    arguments: {
      title: "which way?",
      context: "ordinary agent escalation, not a watchdog failure",
      options: ["retry", "abandon"],
      recommendation: "retry",
    },
  });
  expect(res.isError ?? false).toBe(false);
  await escalateClient.close();

  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question" && x.parent_id === escalating.id,
  );
  expect(question.question_options).toEqual(["retry", "abandon"]);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "abandon" });

  const board1 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // no cancel_option was declared on this question, so "abandon" is just an
  // ordinary answer — the escalating task unblocks normally, nothing cancels
  expect(board1.some((x: any) => x.status === "cancelled")).toBe(false);
  expect(board1.find((x: any) => x.id === escalating.id).status).toBe("in_progress");
  expect(board1.find((x: any) => x.id === sibling.id).status).toBe("todo");
});
