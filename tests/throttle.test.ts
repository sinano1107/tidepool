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

const MIN = 60 * 1000;

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
  const path = await mkdtemp(join(tmpdir(), "tidepool-throttle-ws-"));
  wsPath = path;
  git(path, "init", "-b", "main");
  writeFileSync(join(path, "README.md"), "workspace\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "initial");
  return { name: "sandbox", path };
}

async function registerWork(t: Tidepool) {
  return (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "long haul",
      purpose: "runs while the account is throttled",
      completion_criteria: "n/a",
    })
  ).json;
}

it("rejected 検知で新規タスクの pickup が resets_at まで止まり、resets_at を過ぎると再開する", async () => {
  t = await bootTidepool();
  const task = await registerWork(t);

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.reportThrottle({ state: "rejected", resetsAt });

  await t.clock.advance(HOUR); // would normally pick up the queue head, but throttled
  expect(t.worker.started).toEqual([]);

  await t.clock.advance(HOUR); // now well past resets_at; the next poll picks it up
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

const fullHandoff = {
  outcome: "done",
  deliverables: "n/a",
  decision_refs: "n/a",
  dead_ends: "n/a",
  resume_context: "n/a",
  known_issues: "n/a",
};

it("allowed_warning は新規 pickup だけ止め、実行中タスクの完走は妨げない", async () => {
  t = await bootTidepool();
  const first = await registerWork(t);
  await t.clock.advance(HOUR); // first picked up

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.reportThrottle({ state: "allowed_warning", resetsAt });

  // the in-progress task completes normally — the warning never touches it
  const client = await mcpClient(t.baseUrl, first.id);
  const done: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  expect(done.isError ?? false).toBe(false);
  await client.close();

  const second = await registerWork(t);
  await t.clock.advance(HOUR); // slot is free now, but new pickup is still under warning
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id]);

  await t.clock.advance(HOUR); // past resets_at
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id, second.id]);
});

it("resets_at を過ぎると、次の hourly poll を待たずに即座に pickup が再開する", async () => {
  t = await bootTidepool();
  const task = await registerWork(t);

  const resetsAt = new Date(t.clock.now().getTime() + 5 * MIN);
  t.worker.reportThrottle({ state: "rejected", resetsAt });

  // well short of the hourly poll, but past resets_at: the throttle watch's
  // own short tick should have already picked the task up
  await t.clock.advance(10 * MIN);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("rejected の間、todo タスクはキュービュー(/api/queue)では skipped、ボード(/api/tasks)では todo のまま", async () => {
  t = await bootTidepool();
  const task = await registerWork(t);

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.reportThrottle({ state: "rejected", resetsAt });

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.id === task.id).status).toBe("todo");

  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.find((x: any) => x.id === task.id).status).toBe("skipped");

  // once resets_at passes, the queue view goes back to plain todo
  await t.clock.advance(2 * HOUR);
  const queueAfter = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queueAfter.find((x: any) => x.id === task.id)?.status ?? "in_progress").not.toBe(
    "skipped",
  );
});

it("実行中に rejected を検知すると tree rule で WIP を退避し、タスクは todo+skipped でキュー先頭に戻り、reset 後に自分のブランチから再開する(エスカレーションは生まれない)", async () => {
  const ws = await makeWorkspace();
  t = await bootTidepool({ workspace: ws });
  const task = await registerWork(t);

  await t.clock.advance(HOUR); // picked up, checked out onto its own task branch
  writeFileSync(join(ws.path, "draft.txt"), "stuck work\n"); // uncommitted WIP mid-flight

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.reportThrottle({ state: "rejected", resetsAt });

  await t.clock.advance(MIN); // the throttle watch's own tick reacts within 60s

  // tree rule stashed the WIP and the tree is clean
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "show", `task/${task.id}:draft.txt`)).toBe("stuck work");

  // board shows plain todo (never skipped there); queue view shows skipped
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.id === task.id).status).toBe("todo");
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.find((x: any) => x.id === task.id).status).toBe("skipped");

  // no failure question / escalation was raised, unlike a watchdog kill
  expect(board.some((x: any) => x.type === "question")).toBe(false);

  // once resets_at passes, the same task restarts from its own branch
  await t.clock.advance(2 * HOUR);
  expect(t.worker.started.map((x: any) => x.id)).toEqual([task.id, task.id]);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
});
