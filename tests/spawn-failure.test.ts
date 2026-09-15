import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  git,
  HOUR,
  makeWorkspace,
  questions,
  queueWork,
  type Tidepool,
} from "./harness.js";

/** ADR 0118(issue #570)。worker が1度も走らなかった pickup は、盤面が失敗を観測した
 *  瞬間に failure question を立て、後始末で枠を空ける —— タスク種別の時間制限の梯子には
 *  入らない。 */

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const MIN = 60 * 1000;
const WATCHDOG = { timeLimits: { work: 90 * MIN }, grace: 30 * MIN, reclaimTimeout: 5 * MIN };

/** 後始末は回収済み観測の後ろ = microtask の先にある。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const started = () => t.worker.started.map((task) => task.id);

const neverStarted = async () =>
  (await questions(t)).filter((q: any) => q.title.startsWith("worker never started for task:"));

const status = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json.status;

it("start が同期で投げた瞬間に failure question が立ち、後始末が checkout を休止位置へ戻して枠を空ける —— 時間制限の梯子には入らない", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws, watchdog: WATCHDOG });
  const task = queueWork(t, "never runs");
  const next = queueWork(t, "next in line");
  t.worker.scriptStartFailure(new Error("registry went bad after boot"));

  // 投げた tick が盤面を落とさない
  await expect(t.clock.advance(HOUR)).resolves.toBeUndefined();

  const [question, ...more] = await neverStarted();
  expect(more).toEqual([]);
  expect(question.title).toBe("worker never started for task: never runs");
  expect(question.question_items[0].options).toEqual(["retry", "abandon"]);
  expect(question.question_items[0].recommendation).toBe("retry");
  expect(question.purpose).toContain(task.id);
  expect(question.purpose).toContain("never ran");
  expect(question.purpose).toContain("registry went bad after boot");
  expect(question.purpose).not.toMatch(/time limit|reclaim|bug|environment/i);
  const questionEvents = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}/events`)).json;
  expect(questionEvents.find((e: any) => e.kind === "task_registered").worker_id).toBe("tidepool");

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  expect(events.find((e: any) => e.kind === "spawn_failed").payload).toEqual({
    kind: "spawn_failed",
    error_code: null,
    message: "registry went bad after boot",
  });

  // 後始末が完走している: 休止位置 → slot 解放 → 次の todo が tick なしで拾われる
  expect(await status(task.id)).toBe("blocked");
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${next.id}`);
  expect(started()).toEqual([task.id, next.id]);

  // 時間制限を越えても、走っていない session へ畳み込み停止は送られない
  await t.clock.advance(2 * HOUR);
  expect(t.worker.gracefulStops).not.toContain(task.id);
  expect(await neverStarted()).toHaveLength(1);
});

it("空を観測できない容器では、読み口が後始末中を報せ、回収 timeout で Containment quarantine に落ちる —— 文面は cap も完了も断言しない", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws, watchdog: WATCHDOG });
  const task = queueWork(t, "never runs");
  queueWork(t, "next in line");
  t.containers.hold(task.id);
  t.worker.scriptStartFailure(new Error("mkdtemp failed"));
  await t.clock.advance(HOUR);

  expect(await neverStarted()).toHaveLength(1);
  expect(t.containers.forceReclaims).toContain(task.id);
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.teardown.taskId).toBe(task.id);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown.taskId).toBe(task.id);
  expect(await status(task.id)).toBe("blocked");

  await t.clock.advance(10 * MIN);
  const containment = (await questions(t)).find((q: any) => q.title.includes("containment"));
  expect(containment.purpose).toContain("may still be running");
  expect(containment.purpose).not.toMatch(/usage cap|finished its work and reported it/);
  expect(started()).toEqual([task.id]);
  expect(t.worker.gracefulStops).toEqual([]);
});

it("後始末の途中で再起動しても failure question は残り、cap として queue 先頭へ戻らず、再起動中断の question も立たない", async () => {
  const ws = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws, watchdog: WATCHDOG });
  const task = queueWork(t, "never runs");
  t.containers.hold(task.id);
  t.worker.scriptStartFailure(new Error("mkdtemp failed"));
  await t.clock.advance(HOUR);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);

  await t.stopServer();
  t = await bootTidepool({ dir: t.dir, workspace: ws, watchdog: WATCHDOG });
  await settle();

  expect(await neverStarted()).toHaveLength(1);
  expect((await questions(t)).some((q: any) => q.title.includes("restart interrupted"))).toBe(false);
  expect(await status(task.id)).toBe("blocked");
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  await t.clock.advance(HOUR);
  expect(started()).toEqual([]);
});

it("adapter が観測した非同期の spawn 失敗も同じ question を立て、同じ pickup に2枚目は立たない", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "never runs");
  await t.clock.advance(HOUR);
  expect(started()).toEqual([task.id]);

  t.worker.failSpawn(task.id, "ENOENT", "spawn claude ENOENT");
  t.worker.failSpawn(task.id, "ENOENT", "spawn claude ENOENT");
  await settle();

  const [question, ...more] = await neverStarted();
  expect(more).toEqual([]);
  expect(question.purpose).toContain("ENOENT");
  expect(question.purpose).toContain("spawn claude ENOENT");
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
});

it("既に別の session が slot に入っているときに遅れて届いた spawn 失敗の観測は、その slot を解放しない", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const failed = queueWork(t, "never runs");
  const running = queueWork(t, "running");
  queueWork(t, "waiting");
  t.worker.scriptStartFailure(new Error("registry went bad after boot"));
  await t.clock.advance(HOUR);
  expect(started()).toEqual([failed.id, running.id]);

  t.worker.failSpawn(failed.id, "ENOENT", "spawn claude ENOENT");
  await settle();
  await t.clock.advance(HOUR);

  expect(await status(running.id)).toBe("in_progress");
  expect(started()).toEqual([failed.id, running.id]);
  expect(await neverStarted()).toHaveLength(1);
});
