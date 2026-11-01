import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { enumerateHostSkills } from "../src/claude-worker.js";
import { openDb } from "../src/db.js";
import { appendEvent, listEventsOfKinds } from "../src/events.js";
import { quarantineUnclosedSession } from "../src/failed-teardown.js";
import { listEpisodes } from "../src/precedent.js";
import { FAILED_TEARDOWN_QUESTION_TITLE } from "../src/quarantine.js";
import { completeTask, getTask, listBoard } from "../src/tasks.js";
import { markTeardown } from "../src/teardown.js";
import { RECLAIM_TIMEOUT } from "../src/watchdog.js";
import { FakeContainerRuntime, recordingSpawn } from "./fakes.js";
import { api, bootTidepool, commitWork, FULL_HANDOFF, failTeardownMark, GIT_FIXTURE_TEST_TIMEOUT, git, HOUR, makeWorkspace, QUIET_EXIT, questions, queueWork, servedQuarantineQuestion, type Tidepool, toolCall, WORKER_SPAWNED } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(() => t?.stop());

it("a restart drops the interrupted task into the same failure-escalation path as a watchdog kill, freeing the slot", async () => {
  t = await bootTidepool();
  const first = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "interrupted by restart",
      purpose: "occupies the slot across a restart",
      completion_criteria: "n/a",
    })
  ).json;
  const second = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "must keep waiting",
      purpose: "would be a second in_progress task",
      completion_criteria: "n/a",
    })
  ).json;
  // first task picked up at its own registration (ADR 0119 決定2)

  // restart the monolith on the same SQLite file
  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });

  // the leftover in_progress task is escalated immediately at boot, no tick needed
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(list.find((x: any) => x.id === first.id).status).toBe("blocked");
  expect(list.find((x: any) => x.type === "question")).toBeDefined();

  // the slot was freed at boot, so the boot poll (ADR 0119 決定4) hands the second task over
  expect(t.worker.started.map((x: any) => x.id)).toEqual([second.id]);
});

// ADR 0119 決定4: 起動完了は pickup の契機である —— 毎時のティックは起動直後には走らない
it("todo を持つ盤面で起動すると、tick を進めずに pickup される", async () => {
  t = await bootTidepool();
  const waiting = queueWork(t, "waiting across a restart");
  await t.stopServer();

  t = await bootTidepool({ dir: t.dir });
  // 起動完了の poll は fire-and-forget なので、boot の返りの後ろにある
  await new Promise((resolve) => setImmediate(resolve));

  expect(t.worker.started.map((x) => x.id)).toEqual([waiting.id]);
});

const watchdog = { timeLimits: { work: 90 * 60 * 1000 }, grace: 30 * 60 * 1000, reclaimTimeout: 5 * 60 * 1000 };

/** 再起動中断の後始末(issue #1936): 未 commit の変更を残して `in_progress` のまま盤面が落ち、
 *  容器機構の前提検査が落ちた起動で立ち上がる —— 前の盤面の process が残っていないことは証明されていない。 */
async function interruptedThenBootWithFailedPreflight(harnessContainment?: () => Promise<{ available: true }>, beforeReboot?: (taskId: string) => void) {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws, watchdog, harnessContainment });
  const task = queueWork(t, "interrupted by restart");
  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([task.id]));
  writeFileSync(join(ws.path, "wip.txt"), "unfinished work\n");
  await t.stopServer();
  beforeReboot?.(task.id);

  const runtime = new FakeContainerRuntime();
  runtime.scriptPreflight("previous session may still be alive");
  t = await bootTidepool({ dir: t.dir, workspace: ws, containerRuntime: runtime, watchdog, harnessContainment });
  return { ws, task, runtime };
}

it("前提検査が落ちた起動では、再起動中断の workspace を書かずに failure question を立てて後始末へ入れる(issue #1936)", async () => {
  const { ws, task } = await interruptedThenBootWithFailedPreflight();

  expect(git(ws.path, "status", "--porcelain")).toContain("wip.txt");
  expect(git(ws.path, "log", "--format=%s", `task/${task.id}`)).not.toContain("WIP");
  expect((await questions(t)).map((q) => q.title)).toContain(`restart interrupted task: ${task.title}`);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toMatchObject({ taskId: task.id, settlement: "released" });
});

it("前提検査が戻ってから Harness Containment question への確認回答を受理すると、再起動中断の tree rule が走って枠が空く(issue #1936)", async () => {
  const { ws, task, runtime } = await interruptedThenBootWithFailedPreflight(async () => ({ available: true }) as const);
  const next = queueWork(t, "waits for the slot");
  const confirmations = await vi.waitFor(async () => {
    const found = (await questions(t)).filter((q) => q.question_quarantine_kind === "harnessContainment");
    expect(found).toHaveLength(2);
    return found;
  });

  runtime.scriptPreflight(); // 修理済み
  for (const question of confirmations) {
    expect((await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] })).status).toBe(200);
  }
  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([next.id]));

  expect(git(ws.path, "show", `task/${task.id}:wip.txt`)).toBe("unfinished work");
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
});

// `harnessContainment` を持たない盤面は Containment question の修理を検査できず、回答を拒む ——
// そこで tree rule を持つ門は、前提検査の通る次の起動の復旧である
it("Harness 封じ込めを持たない盤面では、前提検査の通る次の起動が再起動中断の tree rule を走らせ、failure question は2枚目を立てない(issue #1936)", async () => {
  const { ws, task } = await interruptedThenBootWithFailedPreflight();
  await t.stopServer();

  t = await bootTidepool({ dir: t.dir, workspace: ws, watchdog });

  expect(git(ws.path, "show", `task/${task.id}:wip.txt`)).toBe("unfinished work");
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
  expect((await questions(t)).filter((q) => q.title.startsWith("restart interrupted task"))).toHaveLength(1);
});

it("後始末の印が書けなかった起動は、再起動中断の failure question も残さない —— タスクは in_progress のまま(issue #1936)", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "interrupted by restart");
  await t.clock.advance(HOUR);
  await t.stopServer();
  const seed = openDb(join(t.dir, "board.sqlite"));
  seed.exec(
    "CREATE TRIGGER mark_fails BEFORE UPDATE OF teardown_started_at ON tasks BEGIN SELECT RAISE(ABORT, 'mark failed'); END",
  );
  seed.close();

  await expect(bootTidepool({ dir: t.dir })).rejects.toThrow("mark failed");

  const db = openDb(join(t.dir, "board.sqlite"));
  expect(getTask(db, task.id)?.status).toBe("in_progress");
  expect(listBoard(db).filter((x) => x.type === "question")).toEqual([]);
  db.close();
});

it("後始末の step が盤面のバグで投げたまま再起動すると、掃き出しの question と落ちた後始末の question の2枚が開き、受理は後始末を撃ち直して枠を空ける(ADR 0342 決定6)", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = queueWork(t, "throws while deciding");
  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([task.id]));
  writeFileSync(join(ws.path, "wip.txt"), "unfinished work\n");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const repair = failTeardownMark(t.db);
  t.worker.exitWith(task.id, { ...QUIET_EXIT, exit_code: 1 });
  expect((await questions(t)).map((q) => q.title)).toEqual([FAILED_TEARDOWN_QUESTION_TITLE]);
  repair();
  await t.stopServer();

  t = await bootTidepool({ dir: t.dir, workspace: ws });

  const open = await questions(t);
  expect(open.map((q) => q.title).sort()).toEqual([FAILED_TEARDOWN_QUESTION_TITLE, `restart interrupted task: ${task.title}`].sort());
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toMatchObject({ taskId: task.id });
  const failed = open.find((q) => q.title === FAILED_TEARDOWN_QUESTION_TITLE)!;
  expect((await api(t.baseUrl, "POST", `/api/tasks/${failed.id}/answer`, { answers: ["repaired by hand"] })).status).toBe(200);

  expect(git(ws.path, "show", `task/${task.id}:wip.txt`)).toBe("unfinished work");
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
  expect((await questions(t)).map((q) => q.title)).toEqual([`restart interrupted task: ${task.title}`]);
});

// ── 前の盤面が閉じ切らなかった session(issue #2600 / ADR 0315)──────────────────

/** setup: 止めた盤面の記録に、閉じ切らなかった session を1つ置く —— spawn(と `exited` なら exit)、stderr、task temp。
 *  `transcript: false` は記録の dir から transcript が欠けた形で、返る `writeTranscript` が後から置く。 */
function leaveOpenSession(dir: string, taskId: string, { exited = false, transcript = true } = {}) {
  const db = openDb(join(dir, "board.sqlite"));
  const at = new Date();
  const spawned = appendEvent(db, { taskId, actorId: "fake-worker", origin: "board", at, payload: WORKER_SPAWNED });
  if (exited) appendEvent(db, { taskId, actorId: "fake-worker", origin: "board", at, payload: { kind: "worker_exited", advisor: null, model_swaps: [], refusals: [], ...QUIET_EXIT, worker_spawned_event_id: spawned, output_closed: true, usage: null } });
  db.close();
  const writeTranscript = () => writeFileSync(join(dir, `${taskId}.${spawned}.stream.jsonl`), toolCall(1, "Bash", null).join("\n"));
  if (transcript) writeTranscript();
  writeFileSync(join(dir, `${taskId}.${spawned}.stderr.log`), "lost the board\n");
  const temp = mkdtempSync(join(tmpdir(), `tidepool-claude-${taskId}-`));
  onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  return { spawned, temp, writeTranscript };
}

const exitsOf = (spawned: number) => listEventsOfKinds(t.db, ["worker_exited"]).filter((e) => e.payload.worker_spawned_event_id === spawned);
const episodeOf = (spawned: number) => listEpisodes(t.db, { workerSpawnedEventId: spawned })[0];

it("前提検査が通った起動は、前の盤面が閉じ切らなかった session を観測していない印の exit で閉じ、Episode を投影する(ADR 0315。記録の形と task temp は tests/session-close.test.ts)", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "interrupted by restart");
  await t.clock.advance(HOUR);
  await t.stopServer();
  const left = leaveOpenSession(t.dir, task.id);

  t = await bootTidepool({ dir: t.dir });

  const [exited] = exitsOf(left.spawned);
  expect(exited?.payload).toMatchObject({ exit_observed: false });
  expect(episodeOf(left.spawned)?.workerExitedEventId).toBe(exited!.id);
});

it("前提検査が落ちた起動では session を閉じず、Harness Containment の確認回答の受理で閉じる(ADR 0315 決定1)", async () => {
  let left!: ReturnType<typeof leaveOpenSession>;
  const { runtime } = await interruptedThenBootWithFailedPreflight(async () => ({ available: true }) as const, (taskId) => {
    left = leaveOpenSession(t.dir, taskId);
  });
  expect(exitsOf(left.spawned)).toEqual([]);
  expect(existsSync(left.temp)).toBe(true);
  const confirmations = await vi.waitFor(async () => {
    const found = (await questions(t)).filter((q) => q.question_quarantine_kind === "harnessContainment");
    expect(found).toHaveLength(2);
    return found;
  });

  runtime.scriptPreflight(); // 修理済み
  for (const question of confirmations) {
    expect((await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] })).status).toBe(200);
  }

  expect(exitsOf(left.spawned)).toHaveLength(1);
  expect(episodeOf(left.spawned)).toBeDefined();
  expect(existsSync(left.temp)).toBe(false);
});

it("回収 timeout の確認回答の受理でも復旧が走り、この起動の後に spawn した session には何も書かない(ADR 0315 決定3)", async () => {
  const containers = new FakeContainerRuntime();
  const options = { containerRuntime: containers, watchdog, harnessContainment: async () => ({ available: true }) as const };
  t = await bootTidepool(options);
  const previous = queueWork(t, "the previous board's session");
  await t.stopServer();
  const left = leaveOpenSession(t.dir, previous.id, { exited: true, transcript: false });
  t = await bootTidepool({ ...options, dir: t.dir });
  expect(episodeOf(left.spawned)).toBeUndefined();
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([previous.id]));
  containers.hold(previous.id);
  // この起動が spawn した走行中の session(偽の worker は spawn を刻まないので setup が置く)
  const running = appendEvent(t.db, { taskId: previous.id, actorId: "fake-worker", origin: "board", at: t.clock.now(), payload: WORKER_SPAWNED });
  await t.clock.advance(watchdog.timeLimits.work);
  await t.clock.advance(watchdog.grace);
  await t.clock.advance(watchdog.reclaimTimeout);
  containers.fireEmpty(previous.id);
  left.writeTranscript(); // 記録の dir が戻った

  const containment = (await questions(t)).find((q) => q.question_quarantine_kind === "containment")!;
  expect((await api(t.baseUrl, "POST", `/api/tasks/${containment.id}/answer`, { answers: ["repaired by hand"] })).status).toBe(200);

  expect(episodeOf(left.spawned)).toBeDefined();
  expect(exitsOf(running)).toEqual([]);
});

it("待っている回収の無い Containment の確認回答の受理でも復旧が走る(ADR 0315 決定1)", async () => {
  t = await bootTidepool();
  const previous = queueWork(t, "the previous board's session");
  await t.stopServer();
  const left = leaveOpenSession(t.dir, previous.id, { exited: true, transcript: false });
  const recorder = recordingSpawn();
  const runtime = new FakeContainerRuntime(recorder.spawn);
  t = await bootTidepool({ dir: t.dir, containerRuntime: runtime, hostSkills: enumerateHostSkills, harnessContainment: async () => ({ available: true }) });
  // 起動の pickup が開く worker の容器と Board call の容器の順を固定する
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([previous.id]));
  // Board call の容器が回収 timeout まで空にならない —— 盤面全体の Containment quarantine(watchdog の待つ回収は無い)
  const pending = api(t.baseUrl, "GET", "/api/skills");
  await vi.waitFor(() => expect(recorder.calls).toHaveLength(1));
  const container = runtime.created.find((id) => id !== previous.id)!;
  runtime.hold(container);
  recorder.processes[0]!.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", skills: [] })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  recorder.emitExit(0, null);
  await pending;
  await t.clock.advance(RECLAIM_TIMEOUT);
  runtime.fireEmpty(container);
  await new Promise((resolve) => setImmediate(resolve));
  left.writeTranscript();

  const containment = (await questions(t)).find((q) => q.question_quarantine_kind === "containment")!;
  expect((await api(t.baseUrl, "POST", `/api/tasks/${containment.id}/answer`, { answers: ["repaired by hand"] })).status).toBe(200);

  expect(episodeOf(left.spawned)).toBeDefined();
});

// ADR 0315 決定1: 配線と門は server の合成にしか現れないので、この seam で書く(ADR 0107)
it("前提検査が通らない間、閉じ切らなかった session の回答は拒まれ、記録から閉じず後始末も走らせない —— 通れば閉じ直して枠を空ける", async () => {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });
  const task = queueWork(t, "left open");
  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([task.id]));
  const spawned = appendEvent(t.db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: t.clock.now() });
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  completeTask(t.db, getTask(t.db, task.id)!, FULL_HANDOFF, "deckhand", t.clock.now(), "worker");
  markTeardown(t.db, task.id, t.clock.now());
  quarantineUnclosedSession(t.db, spawned, task.id, new Error("exit write bug"), t.clock.now());
  await t.stopServer();
  const runtime = new FakeContainerRuntime();
  runtime.scriptPreflight("the previous session may still be alive");
  t = await bootTidepool({ dir: t.dir, workspace: ws, containerRuntime: runtime });
  const temp = join(tmpdir(), `tidepool-claude-${task.id}-still-used`);
  mkdirSync(temp);
  onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const question = await servedQuarantineQuestion(t, "unclosedSession", String(spawned));
  const answerIt = () => api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });

  const refused = await answerIt();

  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.json)).toContain("the previous session may still be alive");
  expect(exitsOf(spawned)).toEqual([]);
  expect(existsSync(temp)).toBe(true);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toMatchObject({ taskId: task.id });
  expect((await servedQuarantineQuestion(t, "unclosedSession", String(spawned))).id).toBe(question.id);

  runtime.scriptPreflight();
  expect((await answerIt()).status).toBe(200);

  expect(exitsOf(spawned).map((e) => e.payload)).toEqual([expect.objectContaining({ exit_observed: false })]);
  expect(existsSync(temp)).toBe(false);
  await vi.waitFor(() => expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main"));
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
}, GIT_FIXTURE_TEST_TIMEOUT);
