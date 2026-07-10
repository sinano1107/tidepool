import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
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

const MIN = 60 * 1000;
const WORK_LIMIT = 90 * MIN;

it("タスク種別の絶対リミットを超えると SIGTERM が一度だけ送られる、超えるまでは送られない", async () => {
  t = await bootTidepool({ watchdog: { timeLimits: { work: WORK_LIMIT }, grace: 1000 * MIN } });
  const task = await registerWork(t, "long haul");

  await t.clock.advance(HOUR); // picked up at t = 60min
  await t.clock.advance(89 * MIN); // t = 149min, elapsed since pickup = 89min: still under 90min
  expect(t.worker.killed).toEqual([]);

  await t.clock.advance(1 * MIN); // t = 150min, elapsed = 90min: past the limit
  expect(t.worker.killed).toEqual([{ taskId: task.id, signal: "SIGTERM" }]);

  await t.clock.advance(1 * MIN); // no repeat signalling on later ticks
  expect(t.worker.killed).toEqual([{ taskId: task.id, signal: "SIGTERM" }]);
});

it("SIGTERM 後、猶予を過ぎると SIGKILL が一度だけ追加で送られる", async () => {
  const grace = 30 * MIN;
  t = await bootTidepool({ watchdog: { timeLimits: { work: WORK_LIMIT }, grace } });
  const task = await registerWork(t, "long haul");

  await t.clock.advance(HOUR); // picked up at t = 60min
  await t.clock.advance(90 * MIN); // t = 150min: SIGTERM fires (elapsed = 90min)
  expect(t.worker.killed).toEqual([{ taskId: task.id, signal: "SIGTERM" }]);

  await t.clock.advance(29 * MIN); // t = 179min: grace (30min from 150min) not yet elapsed
  expect(t.worker.killed).toEqual([{ taskId: task.id, signal: "SIGTERM" }]);

  await t.clock.advance(1 * MIN); // t = 180min: grace elapsed, SIGKILL fires
  expect(t.worker.killed).toEqual([
    { taskId: task.id, signal: "SIGTERM" },
    { taskId: task.id, signal: "SIGKILL" },
  ]);

  await t.clock.advance(10 * MIN); // no repeat SIGKILL
  expect(t.worker.killed).toEqual([
    { taskId: task.id, signal: "SIGTERM" },
    { taskId: task.id, signal: "SIGKILL" },
  ]);
});

it("SIGKILL 後、tree rule が走り、tidepool 名義で再実行選択肢付きの question が生まれ、slot が解放される", async () => {
  const grace = 30 * MIN;
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    watchdog: { timeLimits: { work: WORK_LIMIT }, grace },
  });
  const task = await registerWork(t, "long haul");

  await t.clock.advance(HOUR); // picked up at t = 60min, checked out onto its task branch
  // the killed session left work mid-flight, uncommitted
  writeFileSync(join(ws.path, "draft.txt"), "stuck work\n");

  await t.clock.advance(90 * MIN); // t = 150min: SIGTERM
  await t.clock.advance(grace); // t = 180min: SIGKILL — the failure path runs

  // tree rule stashed the WIP and the tree is clean
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "show", `task/${task.id}:draft.txt`)).toBe("stuck work");

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // the original task is blocked on its own failure question (derived, not stored)
  expect(list.find((x: any) => x.id === task.id).status).toBe("blocked");

  const question = list.find((x: any) => x.type === "question");
  expect(question).toBeDefined();
  expect(question.status).toBe("todo");
  expect(question.question_options).toContain("retry");
  // the human-facing text (not just a source comment) spells out what
  // abandon actually does, since the option label alone ("abandon") can't
  // carry that — ADR 0006's implementation note
  expect(question.purpose).toMatch(/abandon/i);
  expect(question.purpose).toMatch(/plan/i);
  expect(question.purpose).toMatch(/replan|queue head/i);

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  expect(events.find((e: any) => e.kind === "task_registered").worker_id).toBe("tidepool");

  // slot is free: a second task can now proceed
  const second = await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id, second.id]);
});

it("failure question の「再実行」を選ぶと元タスクが先頭復帰し、再ピックアップされる", async () => {
  const grace = 30 * MIN;
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    watchdog: { timeLimits: { work: WORK_LIMIT }, grace },
  });
  const task = await registerWork(t, "long haul");

  await t.clock.advance(HOUR); // picked up at t = 60min
  await t.clock.advance(90 * MIN); // t = 150min: SIGTERM
  await t.clock.advance(grace); // t = 180min: SIGKILL, failure question registered

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "retry" });

  // answered → parent returns to the queue head and is immediately re-picked up
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(after.status).toBe("in_progress");
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id, task.id]);
});

it("再実行で再ピックアップされたタスクにも、新しい pickup から改めて時間リミットが働く(以前の kill 状態を引きずらない)", async () => {
  const grace = 30 * MIN;
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    watchdog: { timeLimits: { work: WORK_LIMIT }, grace },
  });
  const task = await registerWork(t, "long haul");

  // first run: hits the limit, gets killed
  await t.clock.advance(HOUR); // picked up at t = 60min
  await t.clock.advance(90 * MIN); // t = 150min: SIGTERM
  await t.clock.advance(grace); // t = 180min: SIGKILL
  expect(t.worker.killed).toEqual([
    { taskId: task.id, signal: "SIGTERM" },
    { taskId: task.id, signal: "SIGKILL" },
  ]);

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = list.find((x: any) => x.type === "question");
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "retry" });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");

  // second run, from the retry's own pickup: hits the limit again and is
  // killed again — the earlier kill must not have permanently disabled the
  // watchdog for this task id
  await t.clock.advance(90 * MIN);
  await t.clock.advance(grace);
  expect(t.worker.killed).toEqual([
    { taskId: task.id, signal: "SIGTERM" },
    { taskId: task.id, signal: "SIGKILL" },
    { taskId: task.id, signal: "SIGTERM" },
    { taskId: task.id, signal: "SIGKILL" },
  ]);
});

it("failure question が開いている間、失敗タスクの兄弟(計画の残り)も held になり slot に入らない", async () => {
  const grace = 30 * MIN;
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    watchdog: { timeLimits: { work: WORK_LIMIT }, grace },
  });

  const parent = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "plan",
      purpose: "plan purpose",
      completion_criteria: "plan criteria",
    })
  ).json;
  await t.clock.advance(HOUR); // parent picked up
  const client = await mcpClient(t.baseUrl, parent.id);
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
  const sibling = board0.find((x: any) => x.title === "sibling");

  await t.clock.advance(HOUR); // "will fail" picked up (lower sort_key)
  writeFileSync(join(ws.path, "draft.txt"), "stuck work\n");
  await t.clock.advance(90 * MIN); // t: SIGTERM
  await t.clock.advance(grace); // SIGKILL — failure question registered

  const board1 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // sibling has no unfinished children of its own — plain 'todo' (and
  // pickable) without the abandon-aware held rule reaching past its own
  // parent's subtree to the whole plan
  expect(board1.find((x: any) => x.id === sibling.id).status).toBe("held");

  // held keeps it out of the freed slot
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x: any) => x.title)).toEqual(["plan", "will fail"]);

  const question = board1.find((x: any) => x.type === "question");
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "retry" });

  // answered — held clears regardless of which option was chosen
  const board2 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board2.find((x: any) => x.id === sibling.id).status).toBe("todo");
});

it("SIGKILL 後に tree rule 自体が失敗すると、failure question ではなく workspace の quarantine に落ちる", async () => {
  const grace = 30 * MIN;
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace: ws,
    watchdog: { timeLimits: { work: WORK_LIMIT }, grace },
  });
  const task = await registerWork(t, "long haul");

  await t.clock.advance(HOUR); // picked up at t = 60min

  // 破壊してWIPコミット自体を失敗させる(tree-rule.test.tsの代役と同じ手法)
  writeFileSync(join(ws.path, "junk.txt"), "uncommittable\n");
  await rm(join(ws.path, ".git"), { recursive: true, force: true });

  await t.clock.advance(90 * MIN); // t = 150min: SIGTERM
  await t.clock.advance(grace); // t = 180min: SIGKILL, tree rule fails → quarantine

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // failure question に加えて、quarantine 用の question も盤面自身の名義で立つ
  const quarantineQuestion = list.find((x: any) => x.type === "question" && x.title.includes("sandbox"));
  expect(quarantineQuestion).toBeDefined();
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${quarantineQuestion.id}/events`)).json;
  expect(events.find((e: any) => e.kind === "task_registered").worker_id).toBe("tidepool");

  // needs-human の workspace はpickupを止める
  await registerWork(t, "long haul");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});
