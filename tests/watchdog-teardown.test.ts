import { writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { applyExecutionSettingsChange, loadExecutionSettingTable } from "../src/execution-setting.js";
import { quarantineFailedTeardown } from "../src/failed-teardown.js";
import { ProcessContainers } from "../src/process-container.js";
import { FAILED_TEARDOWN_QUESTION_TITLE, openQuarantineQuestion, openQuarantineValues, registerQuarantine } from "../src/quarantine.js";
import { Slot } from "../src/slot.js";
import { completeTask, escalateTask, getTask, listBoard, moveTask, nextSlotTask, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { sessionInTeardown as markedSession, markTeardown, resumeUnfinishedTeardown, runTeardown, teardownStep } from "../src/teardown.js";
import { capInterruptionHandler, queueReturnHandler, rowRefusalHandler, spawnFailureHandler, startWatchdog, transcriptFailureHandler, type Watchdog } from "../src/watchdog.js";
import {
  prepareWorkspaceAtPickup,
  quarantineWorkspace,
  resolveOrQuarantine,
  UnknownWorkspaceError,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "../src/workspace.js";
import { FakeClock, FakeContainerRuntime, ScriptedWorker } from "./fakes.js";
import { commitWork, FULL_HANDOFF, failTeardownMark, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, QUIET_EXIT } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** 後始末の時限(ADR 0109 決定5)と、その底に落ちた完了済み session(ADR 0099 決定3)。
 *  梯子の底では**解放の門は確認 question ただ1つ**であり、遅れて届いた回収済み観測が
 *  それを跨いではならない —— 跨げば確認 question が開いたまま workspace と slot が動く。 */

const MIN = 60 * 1000;
const CONFIG = { timeLimits: { work: 90 * MIN }, grace: 30 * MIN, reclaimTimeout: 5 * MIN };
/** 後始末は fire-and-forget の `void` の先にある。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

interface Fixture {
  db: Db;
  clock: FakeClock;
  slot: Slot;
  task: Task;
  ws: WorkspaceConfig;
  runtime: FakeContainerRuntime;
  containers: ProcessContainers;
  worker: ScriptedWorker;
  watchdog: Watchdog;
  /** watchdog の後始末が撃った pickup の契機 —— 着地はこの契機が突く収束が撃つ(ADR 0241 決定5)。 */
  triggered: string[];
}

/** 最終 verb が着地し、後始末に入ったところで止まっている完了済み session。容器は
 *  `hold` されている = root が exit しても空にならないホスト。`exit` は最終 verb なしに
 *  root が exit した session(ADR 0145)。`watchdog` はまだ走っている session で、
 *  watchdog の時間制限の梯子に乗せるのは `reclaimTimesOut`。 */
async function sessionInTeardown(
  route: "complete" | "cap" | "escalate" | "exit" | "watchdog" = "complete",
): Promise<Fixture> {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace("sandbox");
  const slot = new Slot();
  const runtime = new FakeContainerRuntime();
  const containers = new ProcessContainers(runtime);
  const registered = registerTask(
    db,
    { type: "work", title: "one", purpose: "why", completion_criteria: "done" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  const picked = pickupTask(db, registered, "deckhand", clock.now())!;
  slot.occupy(picked.id);
  await prepareWorkspaceAtPickup(db, ws, picked, { now: new Date(0) });
  // 盤面は pickup 時に session の容器を作る。このホストでは force だけでは空にならない
  containers.open(picked.id);
  runtime.hold(picked.id);
  commitWork(ws.path, "deliverable.txt", "the real work\n");

  const task =
    route === "complete"
      ? completeTask(db, picked, FULL_HANDOFF, "deckhand", clock.now(), "worker")
      : picked;
  if (route === "escalate") {
    escalateTask(db, picked, {
      context: "need a decision",
      questions: [{ title: "which?", options: ["a", "b"], recommendation: "a" }],
    }, "deckhand", clock.now(), "worker");
  }
  if (route === "complete" || route === "escalate") {
    markTeardown(db, task.id, clock.now());
    slot.enterTeardown();
  }

  const triggered: string[] = [];
  const worker = new ScriptedWorker(clock);
  const watchdog = startWatchdog({
    db,
    clock,
    slot,
    worker,
    containers,
    workspace: ws,
    pollNow: () => triggered.push("pollNow"),
    config: CONFIG,
  });
  if (route === "cap") {
    capInterruptionHandler({ db, clock, slot, resolve: () => ws, heldForContainment: watchdog.heldForContainment, pollNow: () => {} })(task.id, containers.reclaimed(task.id));
    containers.forceReclaim(task.id);
  }
  if (route === "exit") watchdog.onWorkerExited(task.id, { ...QUIET_EXIT, exit_code: 1 });
  return { db, clock, slot, task, ws, runtime, containers, worker, watchdog, triggered };
}

/** 後始末の backstop を超え、回収も観測できないまま梯子の底まで落とす。 */
async function fallToTheBottom(f: Fixture): Promise<void> {
  await f.clock.advance(5 * MIN); // backstop 超過 → 強制回収
  expect(f.runtime.forceReclaims).toEqual([f.task.id]);
  await f.clock.advance(5 * MIN); // 回収 timeout → Containment quarantine
  expect(f.watchdog.heldForContainment(f.task.id)).toBe(true);
}

/** 時間制限 → 猶予 → 強制回収 → 回収 timeout まで、容器の空を観測できないまま進める。 */
async function reclaimTimesOut(f: Fixture): Promise<void> {
  await f.clock.advance(CONFIG.timeLimits.work + CONFIG.grace + CONFIG.reclaimTimeout);
  expect(f.runtime.forceReclaims).toEqual([f.task.id]);
  expect(f.watchdog.heldForContainment(f.task.id)).toBe(true);
}

const questions = (db: Db) => listBoard(db).filter((t) => t.type === "question");

it("cap settlement supersedes an already pending watchdog reclaim callback", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const runtime = new FakeContainerRuntime();
  const containers = new ProcessContainers(runtime);
  const task = pickupTask(db, registerTask(db, { type: "work", title: "one", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), "deckhand", clock.now())!;
  slot.occupy(task.id);
  containers.open(task.id);
  runtime.hold(task.id);
  const watchdog = startWatchdog({ db, clock, slot, containers, worker: new ScriptedWorker(clock), pollNow: () => {}, config: { timeLimits: { work: MIN }, grace: MIN, reclaimTimeout: 5 * MIN } });
  await clock.advance(2 * MIN);
  expect(runtime.forceReclaims).toEqual([task.id]);
  capInterruptionHandler({ db, clock, slot, resolve: undefined, heldForContainment: watchdog.heldForContainment, pollNow: () => {} })(task.id, containers.reclaimed(task.id));
  runtime.fireEmpty(task.id);
  await settle();
  expect(questions(db)).toEqual([]);
  expect(getTask(db, task.id)?.status).toBe("todo");
  expect(slot.currentTaskId).toBeNull();
});

it("走っている間に表から消えた行の 404 は行の Quarantine を立てず、row_refused を残して failure question 無しに先頭へ戻る(issue #1265)", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const { provider, model, effort } = loadExecutionSettingTable(db)[0]!;
  const task = pickupTask(db, registerTask(db, { type: "work", title: "refused", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), "deckhand", clock.now())!;
  slot.occupy(task.id);
  // 走っている間に別のタスクを先頭へ置く —— 断られたタスクがその前へ戻ることを見るため
  moveTask(db, registerTask(db, { type: "work", title: "queued after", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), null, clock.now(), ...HUMAN_WEBUI);
  applyExecutionSettingsChange(db, { setting: "delete_row", provider, model, effort }, "webui", clock.now());

  rowRefusalHandler({ db, clock, slot, resolve: undefined, pollNow: () => {} })(task.id, { provider, model, cause: "api_404", worker_spawned_event_id: 1 }, Promise.resolve());
  await settle();

  expect(openQuarantineValues(db, "tableRow")).toEqual([]);
  expect(listEvents(db, task.id).some((e) => e.kind === "row_refused")).toBe(true);
  expect(nextSlotTask(db)?.id).toBe(task.id);
  expect(questions(db)).toEqual([]);
});

it("行の拒否で後始末の印の書き込みが落ちると、行の Quarantine も row_refused も残らず、タスクは in_progress のまま(issue #1935)", () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const { provider, model } = loadExecutionSettingTable(db)[0]!;
  const task = pickupTask(db, registerTask(db, { type: "work", title: "refused", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), "deckhand", clock.now())!;
  slot.occupy(task.id);
  failTeardownMark(db);

  expect(() =>
    rowRefusalHandler({ db, clock, slot, resolve: undefined, pollNow: () => {} })(task.id, { provider, model, cause: "api_404", worker_spawned_event_id: 1 }, Promise.resolve()),
  ).toThrow("teardown mark failed");

  expect(getTask(db, task.id)?.status).toBe("in_progress");
  expect(listEvents(db, task.id).some((e) => e.kind === "row_refused")).toBe(false);
  expect(questions(db)).toEqual([]);
});

/** 準備まで済んで worker を起動する前に資源が止めた pickup(ADR 0274)。容器は盤面が開いたまま空 —— process は1つも無い。
 *  先頭に別のタスクを置くのは、戻ったタスクがその前へ入ることを見るため。 */
async function stoppedBeforeSpawn(taskWorkspace?: string) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace("sandbox");
  const slot = new Slot();
  const runtime = new FakeContainerRuntime();
  const containers = new ProcessContainers(runtime);
  const registered = registerTask(db, { type: "work", title: "stopped", purpose: "why", completion_criteria: "done", workspace: taskWorkspace }, clock.now(), ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", clock.now(), { assignee: "deckhand", workspace: ws.name })!;
  slot.occupy(task.id);
  containers.open(task.id);
  if (!taskWorkspace) await prepareWorkspaceAtPickup(db, ws, task, { now: clock.now() });
  moveTask(db, registerTask(db, { type: "work", title: "queued after", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), null, clock.now(), ...HUMAN_WEBUI);
  const triggered: string[] = [];
  const resolve = (name: string | null) => {
    if (name === "ghost") throw new UnknownWorkspaceError(name);
    return ws;
  };
  const handler = queueReturnHandler({ db, clock, slot, resolve, pollNow: () => triggered.push("pollNow") }, containers);
  return { db, clock, ws, slot, runtime, containers, task, triggered, resolve, handler };
}

it("worker を起動する前に資源の Quarantine が止めた pickup は、failure question も spawn_failed も無く todo の先頭へ戻り、後始末が休止位置へ戻して枠と容器を空ける(ADR 0274)", async () => {
  const f = await stoppedBeforeSpawn();
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${f.task.id}`);
  const stop = { quarantine: "workspaceContainment", value: "codex/sandbox", reason: "Codex still reports these skills enabled" } as const;
  registerQuarantine(f.db, stop.quarantine, stop.value, stop.reason, f.clock.now());

  f.handler(f.task.id, { kind: "pickup_stopped", ...stop });
  await settle();

  const returned = getTask(f.db, f.task.id)!;
  expect(returned.status).toBe("todo");
  expect(returned.sort_key).toBe(Math.min(...listBoard(f.db).map((t) => t.sort_key)));
  // pickup が書いた assignee / workspace は戻すときに消さない(ADR 0274 決定5)
  expect([returned.assignee, returned.workspace]).toEqual(["deckhand", f.ws.name]);
  const kinds = listEvents(f.db, f.task.id).map((e) => e.kind);
  expect(kinds).not.toContain("spawn_failed");
  expect(listEvents(f.db, f.task.id).filter((e) => e.kind === "pickup_stopped").map((e) => e.payload)).toEqual([{ kind: "pickup_stopped", ...stop }]);
  expect(questions(f.db).map((q) => q.id)).toEqual([openQuarantineQuestion(f.db, "workspaceContainment", "codex/sandbox")!.id]);
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(f.slot.currentTaskId).toBeNull();
  expect(markedSession(f.db)).toBeUndefined();
  expect(f.runtime.forceReclaims).toEqual([f.task.id]);
  f.containers.preflight();
  expect(f.runtime.preflightLive.at(-1)).toEqual(new Set());
  expect(f.triggered).toEqual(["pollNow"]);
});

/** 準備が task ブランチへの checkout より前に落ちた pickup(ADR 0274 決定3)。git は動く —— remote 正本の宣言が clone とずれていて、
 *  準備は checkout の前に投げる。`prior` は同じ workspace で別の task が先に拾われ、後始末まで終えていたか。 */
async function stoppedBeforeCheckout(prior: boolean) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace("sandbox");
  const slot = new Slot();
  const runtime = new FakeContainerRuntime();
  const containers = new ProcessContainers(runtime);
  const triggered: string[] = [];
  const deps = { db, clock, slot, resolve: () => ws, pollNow: () => triggered.push("pollNow") };
  if (prior) {
    const earlier = pickupTask(db, registerTask(db, { type: "work", title: "earlier", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), "deckhand", clock.now())!;
    slot.occupy(earlier.id);
    await prepareWorkspaceAtPickup(db, ws, earlier, { now: clock.now() });
    escalateTask(db, earlier, { context: "need a decision", questions: [{ title: "which?", options: ["a", "b"], recommendation: "a" }] }, "deckhand", clock.now(), "worker");
    markTeardown(db, earlier.id, clock.now());
    slot.enterTeardown();
    await runTeardown(deps, earlier.id, teardownStep(db, earlier.id));
    expect(slot.currentTaskId).toBeNull();
    triggered.length = 0;
  }
  const task = pickupTask(db, registerTask(db, { type: "work", title: "stopped", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), "deckhand", clock.now(), { assignee: "deckhand", workspace: ws.name })!;
  slot.occupy(task.id);
  containers.open(task.id);
  const failure = await prepareWorkspaceAtPickup(db, { ...ws, repo: "https://github.com/acme/elsewhere.git" }, task, { now: clock.now() }).then(() => undefined, (err: unknown) => err);
  expect(failure).toBeInstanceOf(Error);
  const stop = quarantineWorkspace(db, ws.name, failure, clock.now());
  const handler = queueReturnHandler(deps, containers);
  return { db, clock, ws, slot, runtime, containers, task, triggered, deps, stop, handler };
}

/** 触っていない checkout は休止位置のまま、止めた Quarantine は止めた理由だけを持ち、task は先頭の todo、枠と印は空き、契機は1回。 */
function expectUntouchedReturn(f: Awaited<ReturnType<typeof stoppedBeforeCheckout>>, slot: Slot = f.slot): void {
  const question = openQuarantineQuestion(f.db, "workspace", f.ws.name)!;
  expect(listEvents(f.db, question.id).map((e) => e.kind)).not.toContain("quarantine_refired");
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  const returned = getTask(f.db, f.task.id)!;
  expect(returned.status).toBe("todo");
  expect(returned.sort_key).toBe(Math.min(...listBoard(f.db).map((t) => t.sort_key)));
  expect(slot.currentTaskId).toBeNull();
  expect(markedSession(f.db)).toBeUndefined();
  expect(f.triggered).toEqual(["pollNow"]);
}

it.each([
  ["別の task の pickup と後始末の後", true],
  ["1度も拾われていない workspace", false],
])("準備が checkout より前に落ちた pickup の後始末は checkout に触れず、止めた Quarantine に偽の理由を積まずに枠を空ける —— %s(ADR 0274 決定3)", async (_, prior) => {
  const f = await stoppedBeforeCheckout(prior);

  f.handler(f.task.id, { kind: "pickup_stopped", ...f.stop });
  await settle();

  expectUntouchedReturn(f);
});

/** 盤面がこの後始末の途中で落ちた: 回収済み観測は届かず(容器が空にならないホスト)、新しい盤面の枠で起動時の復旧が走らせる。 */
function restartMidTeardown(f: { db: Db; clock: FakeClock; triggered: string[] }, resolve: (name: string | null) => WorkspaceConfig): Slot {
  const slot = new Slot();
  void resumeUnfinishedTeardown({ db: f.db, clock: f.clock, slot, resolve, pollNow: () => f.triggered.push("pollNow") });
  return slot;
}

it.each([
  ["そのまま", false],
  ["再起動を跨いで", true],
])("registry drift で止まった pickup の後始末は、解決できない workspace の quarantine をもう一度撃たずに枠を空ける —— %s(ADR 0274 決定3)", async (_, restart) => {
  const f = await stoppedBeforeSpawn("ghost");
  expect(resolveOrQuarantine(f.db, f.resolve, "ghost", f.clock.now())).toBeUndefined();
  const question = openQuarantineQuestion(f.db, "workspace", "ghost")!;
  if (restart) f.runtime.hold(f.task.id);

  f.handler(f.task.id, { kind: "pickup_stopped", quarantine: "workspace", value: "ghost", reason: "unknown workspace: ghost" });
  await settle();
  const slot = restart ? restartMidTeardown(f, f.resolve) : f.slot;
  await settle();

  expect(getTask(f.db, f.task.id)?.status).toBe("todo");
  expect(questions(f.db).map((q) => q.id)).toEqual([question.id]);
  expect(listEvents(f.db, question.id).map((e) => e.kind)).not.toContain("quarantine_refired");
  expect(slot.currentTaskId).toBeNull();
  expect(markedSession(f.db)).toBeUndefined();
  expect(f.triggered).toEqual(["pollNow"]);
});

it("準備が checkout より前に落ちた pickup の後始末が再起動で途切れても、起動時の復旧は途切れなかった後始末と同じところへ着く(ADR 0274 決定3)", async () => {
  const f = await stoppedBeforeCheckout(true);
  f.runtime.hold(f.task.id);

  f.handler(f.task.id, { kind: "pickup_stopped", ...f.stop });
  await settle();
  expect(markedSession(f.db)?.taskId).toBe(f.task.id);
  const slot = restartMidTeardown(f, () => f.ws);
  await settle();

  expectUntouchedReturn(f, slot);
});

it("準備が task ブランチへ checkout した後で spawn が落ちた pickup の後始末は、今日どおり退避して休止位置へ戻す(ADR 0274 決定3 / ADR 0052 決定7)", async () => {
  const f = await stoppedBeforeSpawn();
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${f.task.id}`);
  const failure = { error_code: "ENOENT", message: "spawn claude ENOENT" };
  // 観測点が event を書いてから盤面の一撃を呼ぶ(scheduler / adapter と同じ順)
  appendEvent(f.db, { taskId: f.task.id, workerId: "deckhand", origin: "board", payload: { kind: "spawn_failed", ...failure }, at: f.clock.now() });

  spawnFailureHandler({ db: f.db, clock: f.clock, slot: f.slot, resolve: f.resolve, pollNow: () => f.triggered.push("pollNow") }, f.containers)(f.task.id, failure);
  await settle();

  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(workspaceNeedsHuman(f.db, f.ws.name)).toBe(false);
  expect(f.slot.currentTaskId).toBeNull();
  expect(f.triggered).toEqual(["pollNow"]);
});

it("1度目の pickup で止まり、2度目の pickup で走ってエスカレーションした session は、走った session として退避を通る —— 自分のブランチを離れていれば拒否して Quarantine に落ちる(ADR 0274 決定3 の「最後の pickup」)", async () => {
  const f = await stoppedBeforeSpawn("sandbox");
  registerQuarantine(f.db, "agent", "deckhand", "unknown agent", f.clock.now());
  f.handler(f.task.id, { kind: "pickup_stopped", quarantine: "agent", value: "deckhand", reason: "unknown agent" });
  await settle();
  expect(f.slot.currentTaskId).toBeNull();

  const picked = pickupTask(f.db, getTask(f.db, f.task.id)!, "deckhand", f.clock.now())!;
  f.slot.occupy(picked.id);
  f.containers.open(picked.id);
  await prepareWorkspaceAtPickup(f.db, f.ws, picked, { now: f.clock.now() });
  // 走った worker が自分のブランチを離れ、成果を main の上に残した
  git(f.ws.path, "checkout", "main");
  await writeFile(`${f.ws.path}/wip.txt`, "work left on main\n");
  escalateTask(f.db, picked, { context: "need a decision", questions: [{ title: "which?", options: ["a", "b"], recommendation: "a" }] }, "deckhand", f.clock.now(), "worker");
  markTeardown(f.db, picked.id, f.clock.now());
  f.slot.enterTeardown();
  expect(markedSession(f.db)?.settlement).toBe("released");

  await runTeardown({ db: f.db, clock: f.clock, slot: f.slot, resolve: f.resolve, pollNow: () => {} }, picked.id, teardownStep(f.db, picked.id));

  expect(getTask(f.db, openQuarantineQuestion(f.db, "workspace", f.ws.name)!.id)?.purpose).toContain(`is on 'main', not 'task/${picked.id}' — refusing to commit`);
  expect(git(f.ws.path, "status", "--porcelain")).toContain("wip.txt");
});

it("資源の停止で後始末の印の書き込みが落ちると、pickup_stopped は残らず、タスクは in_progress のまま(issue #1935)", async () => {
  const f = await stoppedBeforeSpawn();
  failTeardownMark(f.db);

  expect(() => f.handler(f.task.id, { kind: "pickup_stopped", quarantine: "agent", value: "ghost", reason: "unknown agent" })).toThrow("teardown mark failed");

  expect(getTask(f.db, f.task.id)?.status).toBe("in_progress");
  expect(listEvents(f.db, f.task.id).map((e) => e.kind)).not.toContain("pickup_stopped");
});

it("回収済み観測が中断の一撃より先に届いていても(Codex の読み直しの順)、中断は failure question を立てず、task を todo の先頭へ戻して cap_interrupted を残す(ADR 0261)", async () => {
  const f = await sessionInTeardown("watchdog");
  registerTask(f.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, f.clock.now(), ...HUMAN_WEBUI);

  // Codex の順: root の exit で強制回収 → 使用量を読み直す間に容器が空になる → 中断の一撃 → exit の一撃
  f.containers.forceReclaim(f.task.id);
  f.runtime.fireEmpty(f.task.id);
  await settle();
  capInterruptionHandler({ db: f.db, clock: f.clock, slot: f.slot, resolve: () => f.ws, heldForContainment: f.watchdog.heldForContainment, pollNow: () => {} })(f.task.id, f.containers.reclaimed(f.task.id));
  f.watchdog.onWorkerExited(f.task.id, {
    ...QUIET_EXIT,
    exit_code: 1,
    reported_error: "You've hit your usage limit.",
    usage_recheck: { result: "full", windows: [{ name: "primary", used_percent: 100, resets_at: "2026-10-15T12:00:00.000Z" }] },
  });
  await settle();

  expect(questions(f.db)).toEqual([]);
  expect(getTask(f.db, f.task.id)?.status).toBe("todo");
  expect(nextSlotTask(f.db)?.id).toBe(f.task.id);
  expect(listEvents(f.db, f.task.id).some((e) => e.kind === "cap_interrupted")).toBe(true);
  expect(f.slot.currentTaskId).toBeNull();
});

it("使用量を読み直せなかった報告なき exit の failure question は、確かめられなかったことと理由を1行添える(ADR 0261 決定6)", async () => {
  const f = await sessionInTeardown("watchdog");

  f.watchdog.onWorkerExited(f.task.id, {
    ...QUIET_EXIT,
    exit_code: 1,
    usage_recheck: { result: "unreadable", reason: "App Server probe failed: timeout" },
  });

  const [question, ...more] = questions(f.db);
  expect(more).toEqual([]);
  expect(question?.title).toBe("worker exited without reporting: one");
  expect(question?.purpose).toContain(
    "\n\nthe board could not check whether a usage cap ended this session: App Server probe failed: timeout",
  );
});

it("cap teardown reaches containment in one reclaim timeout without running the task-type ladder", async () => {
  const f = await sessionInTeardown("cap");
  await f.clock.advance(4 * MIN);
  expect(questions(f.db)).toEqual([]);
  await f.clock.advance(MIN);
  expect(questions(f.db)).toHaveLength(1);
  expect(questions(f.db)[0]?.purpose).toContain("usage cap");
  expect(questions(f.db)[0]?.purpose).toContain("queue head");
  expect(questions(f.db)[0]?.purpose).toContain("may still be running");
  expect(f.runtime.forceReclaims).toEqual([f.task.id]);
  expect(getTask(f.db, f.task.id)?.status).toBe("in_progress");
  expect(f.slot.currentTaskId).toBe(f.task.id);
  await f.clock.advance(180 * MIN);
  expect(questions(f.db)).toHaveLength(1);
  expect(f.runtime.forceReclaims).toEqual([f.task.id]);
  expect(f.worker.gracefulStops).toEqual([]);
});

it("cap reclaim arriving after containment waits for acceptance before stashing WIP and returning to the queue head", async () => {
  const f = await sessionInTeardown("cap");
  registerTask(f.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, f.clock.now(), ...HUMAN_WEBUI);
  await writeFile(`${f.ws.path}/wip.txt`, "unfinished work\n");
  await f.clock.advance(5 * MIN);
  expect(f.watchdog.pendingReclaim()).toBe(`the container for task ${f.task.id}`);
  f.watchdog.acceptReclaimed();
  expect(f.slot.currentTaskId).toBe(f.task.id);
  f.runtime.fireEmpty(f.task.id);
  await settle();
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(getTask(f.db, f.task.id)?.status).toBe("in_progress");
  expect(git(f.ws.path, "status", "--porcelain")).toContain("wip.txt");

  f.watchdog.acceptReclaimed();
  await settle();
  expect(getTask(f.db, f.task.id)?.status).toBe("todo");
  expect(nextSlotTask(f.db)?.id).toBe(f.task.id);
  expect(git(f.ws.path, "show", `task/${f.task.id}:wip.txt`)).toBe("unfinished work");
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(workspaceNeedsHuman(f.db, f.ws.name)).toBe(false);
  expect(f.slot.currentTaskId).toBeNull();
});

it("acceptance of an escalated session stashes WIP without completion inspection or merge-back", async () => {
  const f = await sessionInTeardown("escalate");
  await writeFile(`${f.ws.path}/wip.txt`, "unfinished work\n");
  await fallToTheBottom(f);
  f.runtime.fireEmpty(f.task.id);
  await settle();
  f.watchdog.acceptReclaimed();
  await settle();
  expect(getTask(f.db, f.task.id)?.status).toBe("todo");
  expect(git(f.ws.path, "show", `task/${f.task.id}:wip.txt`)).toBe("unfinished work");
  expect(workspaceNeedsHuman(f.db, f.ws.name)).toBe(false);
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(f.slot.currentTaskId).toBeNull();
});

it("最終 verb 着地後に root が exit しないまま時限を超えると既存の梯子に乗る —— failure question は立たず task は done のまま", async () => {
  const f = await sessionInTeardown();

  // backstop(既定は回収 timeout と同じ尺度)まではまだ何も起きない
  await f.clock.advance(4 * MIN);
  expect(boardHalts(f.db)).toEqual([]);
  expect(f.runtime.forceReclaims).toEqual([]);

  await fallToTheBottom(f);

  const containment = questions(f.db).find((q) => q.title.includes("containment"));
  expect(containment?.purpose).toContain("is settled");
  // ADR 0112: 同じ観測に対する断言の強さを盤面の中で揃える —— `in_progress` 側と同じ
  // 「残っているかもしれない」であって、「残っている」とは断言しない
  expect(containment?.purpose).toContain("may still be running");
  // タスクの決着は host 側の事情で覆らない
  expect(questions(f.db).some((q) => q.title.includes("watchdog killed"))).toBe(false);
  expect(getTask(f.db, f.task.id)?.status).toBe("done");
  expect(boardHalts(f.db)).toEqual([{ kind: "containment" }]);
});

it("落ちた後始末の question が開いている間、後始末の時限は強制回収を撃たない", async () => {
  const f = await sessionInTeardown();
  // 盤面自身のコードが投げた = 容器はもう空である。ここで梯子に入れると、no-op の強制
  // 回収に続いて「プロセスが残っている」と断言する偽の Containment question が立つ
  quarantineFailedTeardown(f.db, f.task.id, new Error("resolve exploded"), f.clock.now());

  await f.clock.advance(60 * MIN);

  expect(f.runtime.forceReclaims).toEqual([]);
  expect(questions(f.db).map((q) => q.title)).toEqual([FAILED_TEARDOWN_QUESTION_TITLE]);
  expect(boardHalts(f.db)).toEqual([{ kind: "failedTeardown" }]);
});

it("梯子の底まで落ちた完了済み session でも、確認回答で後始末が完走して、pickup の契機まで走る", async () => {
  const f = await sessionInTeardown();
  await fallToTheBottom(f);

  // 人間が手で残存 process を片付けた = 容器の空が観測できるようになった
  f.runtime.fireEmpty(f.task.id);
  await settle();
  f.watchdog.acceptReclaimed();
  await settle();

  // 検査(退避ではない)→ merge-back → 休止位置 → slot 解放 → **契機**(ADR 0109 決定1 / ADR 0241 決定5)
  expect(workspaceNeedsHuman(f.db, f.ws.name)).toBe(false);
  expect(git(f.ws.path, "log", "--oneline", `task/${f.task.id}`)).not.toContain("WIP");
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(f.slot.currentTaskId).toBeNull();
  expect(f.triggered).toEqual(["pollNow"]);
});

it("梯子の底に落ちた後で届いた回収済み観測は解放しない —— 門は確認 question ただ1つである", async () => {
  const f = await sessionInTeardown();
  await fallToTheBottom(f);

  // 遅れて容器の空が観測される。これが最終 verb の `void reclaimed.then(...)` で、
  // watchdog の梯子を知らないまま同じ後始末を撃つ
  f.runtime.fireEmpty(f.task.id);
  await settle();
  const teardownDeps = {
    db: f.db,
    clock: f.clock,
    slot: f.slot,
    resolve: () => f.ws,
    heldForContainment: f.watchdog.heldForContainment,
    pollNow: () => {},
  };
  await runTeardown(teardownDeps, f.task.id, { completion: true, workspace: f.ws });

  // 確認 question は開いたまま。workspace も slot も動かない
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${f.task.id}`);
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(f.triggered).toEqual([]);
  expect(boardHalts(f.db)).toEqual([{ kind: "containment" }]);

  // 回答で初めて走る —— どちらの順でもちょうど1回
  f.watchdog.acceptReclaimed();
  await settle();
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(f.slot.currentTaskId).toBeNull();
  expect(f.triggered).toEqual(["pollNow"]);
});

it("Harness Containment の受理の経路は、この run で待っている回収を解放しない —— 容器が空になっていても、解放の門は Containment question だけ(issue #1937)", async () => {
  const f = await sessionInTeardown();
  await fallToTheBottom(f);
  f.runtime.fireEmpty(f.task.id);
  await settle();

  f.watchdog.resumeTeardown();
  await settle();

  expect(f.watchdog.heldForContainment(f.task.id)).toBe(true);
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${f.task.id}`);
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(f.triggered).toEqual([]);

  // 確認回答の受理なら同じ待ちが解ける
  f.watchdog.acceptReclaimed();
  await settle();
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(f.slot.currentTaskId).toBeNull();
});

it("報告なき exit が梯子の底に落ちた後で届いた回収済み観測は解放しない —— 確認回答で tree rule が走る(issue #1380)", async () => {
  const f = await sessionInTeardown("exit");
  await writeFile(`${f.ws.path}/wip.txt`, "unfinished work\n");
  await fallToTheBottom(f);

  // 遅れて容器の空が観測される。報告なき exit の `void reclaimed.then(...)` が後始末を撃つ
  f.runtime.fireEmpty(f.task.id);
  await settle();
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(git(f.ws.path, "status", "--porcelain")).toContain("wip.txt");
  expect(boardHalts(f.db)).toEqual([{ kind: "containment" }]);

  f.watchdog.acceptReclaimed();
  await settle();
  expect(git(f.ws.path, "show", `task/${f.task.id}:wip.txt`)).toBe("unfinished work");
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(f.slot.currentTaskId).toBeNull();
});

it("回収 timeout に落ちた watchdog の session は後始末へ入り、続く tick で同じ session の梯子をもう一度回さない(issue #648)", async () => {
  const f = await sessionInTeardown("watchdog");
  await reclaimTimesOut(f);

  expect(markedSession(f.db)?.taskId).toBe(f.task.id);
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(f.slot.inTeardown).toBe(true);

  const containment = questions(f.db).find((q) => q.title.includes("containment"))!;
  await f.clock.advance(60 * MIN);
  // 開いている question への撃ち直しは2枚目を刷らず `quarantine_refired` を積む —— それも無い
  expect(listEvents(f.db, containment.id).map((e) => e.kind)).not.toContain("quarantine_refired");
  expect(questions(f.db).filter((q) => q.title.includes("containment"))).toHaveLength(1);
  expect(f.runtime.forceReclaims).toEqual([f.task.id]);
});

it("回収 timeout で後始末の印の書き込みが落ちると、failure question も Containment quarantine も残らず、タスクは in_progress のまま(issue #1935)", async () => {
  const f = await sessionInTeardown("watchdog");
  failTeardownMark(f.db);

  await expect(f.clock.advance(CONFIG.timeLimits.work + CONFIG.grace + CONFIG.reclaimTimeout)).rejects.toThrow("teardown mark failed");

  expect(getTask(f.db, f.task.id)?.status).toBe("in_progress");
  expect(questions(f.db)).toEqual([]);
});

it("1度も走らなかった pickup で後始末の印の書き込みが落ちると、failure question は残らず、タスクは in_progress のまま(issue #1935)", async () => {
  const f = await sessionInTeardown("watchdog");
  const deps = { db: f.db, clock: f.clock, slot: f.slot, resolve: () => f.ws, pollNow: () => {} };
  failTeardownMark(f.db);

  expect(() => spawnFailureHandler(deps, f.containers)(f.task.id, { error_code: "ENOENT", message: "spawn claude ENOENT" })).toThrow(
    "teardown mark failed",
  );

  expect(getTask(f.db, f.task.id)?.status).toBe("in_progress");
  expect(questions(f.db)).toEqual([]);
});

it("transcript が書けなくなった session で後始末の印の書き込みが落ちると、failure question は残らず、タスクは in_progress のまま(issue #1935)", async () => {
  const f = await sessionInTeardown("watchdog");
  const deps = { db: f.db, clock: f.clock, slot: f.slot, resolve: () => f.ws, pollNow: () => {} };
  // handler は worker_spawned の worker id を引くだけなので、pickup の event で足りる
  const spawned = listEvents(f.db, f.task.id).at(-1)!.id;
  failTeardownMark(f.db);

  expect(() =>
    transcriptFailureHandler(deps, f.containers)({ taskId: f.task.id, workerSpawnedEventId: spawned, file: "stream", error_code: "ENOSPC", message: "no space left", path: "/records/x.stream.jsonl" }),
  ).toThrow("teardown mark failed");

  expect(getTask(f.db, f.task.id)?.status).toBe("in_progress");
  expect(questions(f.db)).toEqual([]);
});

it("報告なき exit で後始末の印の書き込みが落ちると、failure question は残らず、タスクは in_progress のまま(issue #1935)", async () => {
  const f = await sessionInTeardown("watchdog");
  failTeardownMark(f.db);

  expect(() => f.watchdog.onWorkerExited(f.task.id, { ...QUIET_EXIT, exit_code: 1 })).toThrow("teardown mark failed");

  expect(getTask(f.db, f.task.id)?.status).toBe("in_progress");
  expect(questions(f.db)).toEqual([]);
});

it("時間制限の梯子で容器の空を観測したときに後始末の印の書き込みが落ちると、failure question は残らず、タスクは in_progress のまま(issue #1935)", async () => {
  const f = await sessionInTeardown("watchdog");
  await f.clock.advance(CONFIG.timeLimits.work + CONFIG.grace);
  expect(f.runtime.forceReclaims).toEqual([f.task.id]);
  failTeardownMark(f.db);

  // 観測は `void reclaimed.then(...)` の先に届くので、落ちた書き込みは未処理の reject として上がる
  const raised = new Promise<unknown>((resolve) => process.once("unhandledRejection", resolve));
  f.runtime.fireEmpty(f.task.id);
  expect(String(await raised)).toContain("teardown mark failed");

  expect(getTask(f.db, f.task.id)?.status).toBe("in_progress");
  expect(questions(f.db)).toEqual([]);
});

/** 盤面の再起動: 同じ DB に新しい watchdog と空の `Slot` を作る。前提検査が落ちた起動を表す
 *  —— 起動時の復旧は枠を握らず、後始末の印だけが行に残っている(ADR 0254 決定2)。 */
function restart(f: Fixture): { slot: Slot; watchdog: Watchdog; triggered: string[] } {
  f.watchdog.stop();
  const slot = new Slot();
  const triggered: string[] = [];
  const watchdog = startWatchdog({
    db: f.db,
    clock: f.clock,
    slot,
    worker: new ScriptedWorker(f.clock),
    containers: new ProcessContainers(new FakeContainerRuntime()),
    workspace: f.ws,
    pollNow: () => triggered.push("pollNow"),
    config: CONFIG,
  });
  return { slot, watchdog, triggered };
}

it("再起動後の確認回答が、回収 timeout に落ちた watchdog の session の後始末を走らせる —— WIP はタスクブランチへ退避され、枠が空く(issue #648)", async () => {
  const f = await sessionInTeardown("watchdog");
  await writeFile(`${f.ws.path}/wip.txt`, "unfinished work\n");
  await reclaimTimesOut(f);
  const restarted = restart(f);

  restarted.watchdog.acceptReclaimed();
  await settle();

  expect(git(f.ws.path, "show", `task/${f.task.id}:wip.txt`)).toBe("unfinished work");
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(workspaceNeedsHuman(f.db, f.ws.name)).toBe(false);
  expect(markedSession(f.db)).toBeUndefined();
  expect(restarted.slot.currentTaskId).toBeNull();
  expect(restarted.triggered).toEqual(["pollNow"]);
});

it("再起動後の確認回答が、梯子の底に落ちた完了済み session の後始末を走らせる —— 検査と merge-back を経て枠が空く(issue #648)", async () => {
  const f = await sessionInTeardown();
  await fallToTheBottom(f);
  const restarted = restart(f);

  restarted.watchdog.acceptReclaimed();
  await settle();

  expect(workspaceNeedsHuman(f.db, f.ws.name)).toBe(false);
  expect(git(f.ws.path, "log", "--oneline", `task/${f.task.id}`)).not.toContain("WIP");
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(markedSession(f.db)).toBeUndefined();
  expect(restarted.slot.currentTaskId).toBeNull();
  expect(restarted.triggered).toEqual(["pollNow"]);
});

it("再起動後の確認回答は、起動時の復旧がすでに枠を握っているなら何もしない(issue #648)", async () => {
  const f = await sessionInTeardown("watchdog");
  await reclaimTimesOut(f);
  const restarted = restart(f);
  // 前提検査が通った起動の復旧が、後始末の途中で枠を握っている
  restarted.slot.occupy(f.task.id);
  restarted.slot.enterTeardown();

  expect(() => restarted.watchdog.acceptReclaimed()).not.toThrow();
  await settle();

  expect(markedSession(f.db)?.taskId).toBe(f.task.id);
  expect(restarted.slot.currentTaskId).toBe(f.task.id);
  expect(restarted.triggered).toEqual([]);
});
