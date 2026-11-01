import { beforeEach, describe, expect, it, vi } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { ProcessContainers } from "../src/process-container.js";
import { FAILED_TEARDOWN_QUESTION_TITLE, openQuarantineQuestion } from "../src/quarantine.js";
import { Slot } from "../src/slot.js";
import { completeTask, getTask, listBoard, pickupTask, registerTask, returnToQueue, type Task } from "../src/tasks.js";
import { acceptTeardownQuarantine, markTeardown, runTeardown, sessionInTeardown, type TeardownAction, type TeardownDeps, teardownStep } from "../src/teardown.js";
import { recordHumanStop, spawnFailureHandler, startWatchdog, transcriptFailureHandler, type Watchdog } from "../src/watchdog.js";
import { prepareWorkspaceAtPickup, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, FakeContainerRuntime, ScriptedWorker, unusedLanding } from "./fakes.js";
import { commitWork, FULL_HANDOFF, failTeardownMark, GIT_FIXTURE_TEST_TIMEOUT, HUMAN_WEBUI, makeWorkspace, QUIET_EXIT, unhandledRejectionsDuring, WORKER_SPAWNED } from "./harness.js";

/** 後始末の runner(ADR 0342 決定6 / ADR 0112): 後始末のどの step で盤面のバグが投げても落ちた後始末の question が1枚立ち、
 *  梯子は進まず、受理は投げた step を撃ち直す。既定は workspace を持たない盤面(tree rule は no-op)で step と枠だけを見て、
 *  後始末の await の窓が要るテストだけ workspace を渡す。 */

const MIN = 60 * 1000;
const CONFIG = { timeLimits: { work: 90 * MIN }, grace: 30 * MIN, reclaimTimeout: 5 * MIN };
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

interface Board {
  db: Db;
  clock: FakeClock;
  slot: Slot;
  runtime: FakeContainerRuntime;
  containers: ProcessContainers;
  task: Task;
  deps: TeardownDeps;
  watchdog: Watchdog;
  spawned: number;
}

/** 走っている session 1つ。`hold` した容器は強制回収では空にならない。 */
function board({ hold = false, workspace }: { hold?: boolean; workspace?: WorkspaceConfig } = {}): Board {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const runtime = new FakeContainerRuntime();
  const containers = new ProcessContainers(runtime);
  const task = pickupTask(db, registerTask(db, { type: "work", title: "one", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), "deckhand", clock.now())!;
  const spawned = appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: clock.now() });
  slot.occupy(task.id);
  containers.open(task.id);
  if (hold) runtime.hold(task.id);
  const deps: TeardownDeps = { db, clock, slot, resolve: workspace && (() => workspace), pollNow: () => {} };
  const watchdog = startWatchdog({ db, clock, slot, worker: new ScriptedWorker(clock), containers, workspace, pollNow: () => {}, config: CONFIG });
  return { db, clock, slot, runtime, containers, task, deps, watchdog, spawned };
}

const questions = (db: Db) => listBoard(db).filter((t) => t.type === "question").map((q) => q.title);

/** 落ちた後始末の question への確認回答(受理の検査は `acceptTeardownQuarantine`)。 */
function answer(b: Board) {
  const question = getTask(b.db, openQuarantineQuestion(b.db, "failedTeardown", b.task.id)!.id)!;
  return submitAnswer(
    {
      db: b.db,
      pollNow() {},
      landing: unusedLanding,
      quarantineChecks: quarantineChecks({ db: b.db, teardownQuarantine: (taskId: string) => acceptTeardownQuarantine(b.deps, taskId) }),
    },
    question,
    ["repaired by hand"],
    undefined,
    () => b.clock.now(),
    "webui",
  );
}

/** 落ちた後始末で止まっている: question は1枚、枠は握ったまま、待っている回収は無い(行と一致)。 */
function expectHeld(b: Board) {
  expect(questions(b.db)).toEqual([FAILED_TEARDOWN_QUESTION_TITLE]);
  expect(boardHalts(b.db)).toEqual([{ kind: "failedTeardown" }]);
  expect(b.slot.currentTaskId).toBe(b.task.id);
  expect(b.watchdog.pendingReclaim()).toBeUndefined();
}

/** 梯子の底を越えるまで時計を進め、容器の空も観測させる —— 落ちた後始末は梯子に入らない(ADR 0112 決定4)。 */
async function climbTheLadder(b: Board) {
  await b.clock.advance(CONFIG.timeLimits.work + CONFIG.grace + CONFIG.reclaimTimeout * 3);
  b.runtime.fireEmpty(b.task.id);
  await settle();
}

it.each([
  [
    "分類が揃った後の決定の tx",
    (b: Board) => {
      b.containers.forceReclaim(b.task.id);
      b.watchdog.onWorkerExited(b.task.id, { ...QUIET_EXIT, exit_code: 1 }, { workerSpawnedEventId: b.spawned, turnRan: true, writes: [], capInterrupted: false });
    },
    `worker exited without reporting: one`,
  ],
  [
    "spawn 前の窓の一撃",
    (b: Board) => spawnFailureHandler(b.deps, b.containers)(b.task.id, { error_code: "ENOENT", message: "spawn claude ENOENT" }),
    `worker never started for task: one`,
  ],
] as const)("%s が投げると落ちた後始末が1枚立って梯子は進まず、直してから受理すると同じ step が撃ち直されて枠が空く(ADR 0342 決定6)", async (_, fire, failure) => {
  const b = board();
  const repair = failTeardownMark(b.db);

  fire(b);
  await climbTheLadder(b);

  expectHeld(b);
  repair();
  await answer(b);
  await settle();
  expect(questions(b.db)).toEqual([failure]);
  expect(b.slot.currentTaskId).toBeNull();
});

it("回収済み観測の書き込みが投げると落ちた後始末が立ち、受理が撃ち直して watchdog の failure question を立て枠を空ける(ADR 0342 決定6)", async () => {
  const b = board({ hold: true });
  await b.clock.advance(CONFIG.timeLimits.work + CONFIG.grace);
  expect(b.runtime.forceReclaims).toEqual([b.task.id]);
  const repair = failTeardownMark(b.db);

  b.runtime.fireEmpty(b.task.id);
  await settle();
  await climbTheLadder(b);

  expectHeld(b);
  repair();
  await answer(b);
  await settle();
  expect(questions(b.db)).toEqual(["watchdog killed task: one"]);
  expect(b.slot.currentTaskId).toBeNull();
});

it("回収 timeout の書き込みが投げると落ちた後始末が立ち、待つ回収を報せない —— 受理が撃ち直すと Containment の門に移り、回収の待ちが行と一致する(ADR 0342 決定5・6)", async () => {
  const b = board({ hold: true });
  const repair = failTeardownMark(b.db);

  await b.clock.advance(CONFIG.timeLimits.work + CONFIG.grace + CONFIG.reclaimTimeout);
  await b.clock.advance(CONFIG.reclaimTimeout * 3);

  expectHeld(b);
  expect(b.watchdog.heldForContainment(b.task.id)).toBe(false);
  repair();
  await answer(b);
  expect(questions(b.db)).toEqual(["watchdog killed task: one", "worker containment is not established — pickup is stopped"]);
  expect(b.watchdog.pendingReclaim()).toBe(`the container for task ${b.task.id}`);
  expect(b.slot.inTeardown).toBe(true);
});

it("後始末の梯子の底の Containment の書き込みが投げると落ちた後始末が立ち、待つ回収を報せない(ADR 0342 決定5・6)", async () => {
  const b = board({ hold: true });
  completeTask(b.db, getTask(b.db, b.task.id)!, FULL_HANDOFF, "deckhand", b.clock.now(), "worker");
  markTeardown(b.db, b.task.id, b.clock.now());
  b.slot.enterTeardown();
  b.db.exec(
    "CREATE TRIGGER fail_containment BEFORE INSERT ON tasks WHEN NEW.question_quarantine_kind = 'containment' " +
      "BEGIN SELECT RAISE(ABORT, 'containment write failed'); END",
  );

  await b.clock.advance(CONFIG.reclaimTimeout); // backstop 超過 → 強制回収
  await b.clock.advance(CONFIG.reclaimTimeout); // 回収 timeout → Containment の書き込みが投げる
  await b.clock.advance(CONFIG.reclaimTimeout * 3);

  expectHeld(b);
  expect(b.runtime.forceReclaims).toEqual([b.task.id]);
  b.db.exec("DROP TRIGGER fail_containment");
  await answer(b);
  expect(b.watchdog.pendingReclaim()).toBe(`the container for task ${b.task.id}`);
});

it("落ちた後始末が立った後に遅れて届いた空の観測は後始末を走らせず枠を空けない —— 受理が投げた手を撃ち直してから回収の門を通る(ADR 0112 決定4 / ADR 0342 決定6)", async () => {
  const b = board({ hold: true });
  b.containers.forceReclaim(b.task.id);
  // 上限到達による中断: 決定が後始末へ入り、回収済み観測に後始末を繋ぐ
  b.watchdog.onWorkerExited(b.task.id, QUIET_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, writes: [], capInterrupted: true });
  b.db.exec(
    "CREATE TRIGGER fail_containment BEFORE INSERT ON tasks WHEN NEW.question_quarantine_kind = 'containment' " +
      "BEGIN SELECT RAISE(ABORT, 'containment write failed'); END",
  );
  await b.clock.advance(CONFIG.reclaimTimeout); // 後始末の梯子の底 → Containment の書き込みが投げる
  expectHeld(b);

  b.runtime.fireEmpty(b.task.id);
  await settle();

  expectHeld(b);
  expect(getTask(b.db, b.task.id)?.status).toBe("in_progress");
  b.db.exec("DROP TRIGGER fail_containment");
  await answer(b);
  expect(questions(b.db)).toEqual(["worker containment is not established — pickup is stopped"]);
  b.watchdog.acceptReclaimed();
  await settle();
  expect(b.slot.currentTaskId).toBeNull();
  expect(getTask(b.db, b.task.id)?.status).toBe("todo");
});

it("後始末(`runTeardown`)が投げると落ちた後始末が立ち、後始末の梯子は進まない —— 受理が後始末を撃ち直して枠が空く(ADR 0112)", async () => {
  const b = board({ hold: true });
  completeTask(b.db, getTask(b.db, b.task.id)!, FULL_HANDOFF, "deckhand", b.clock.now(), "worker");
  markTeardown(b.db, b.task.id, b.clock.now());
  b.slot.enterTeardown();
  // 印を消す書き込み(`clearTeardown`)が投げる
  const repair = failTeardownMark(b.db);

  await runTeardown(b.deps, b.task.id, teardownStep(b.db, b.task.id));
  await climbTheLadder(b);

  expectHeld(b);
  expect(b.runtime.forceReclaims).toEqual([]);
  repair();
  await answer(b);
  expect(b.slot.currentTaskId).toBeNull();
});

it("transcript 失敗の一撃が投げると event も残らず落ちた後始末が立ち、受理の撃ち直しが event を1行だけ書く(ADR 0149 決定4 / ADR 0342 決定6)", async () => {
  const b = board();
  const spawned = appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: b.clock.now() });
  const failure = { taskId: b.task.id, workerSpawnedEventId: spawned, file: "stream", error_code: "ENOSPC", message: "no space left", path: "/records/x.stream.jsonl" } as const;
  const repair = failTeardownMark(b.db);
  const transcripts = () => listEvents(b.db, b.task.id).filter((e) => e.kind === "transcript_failed");

  transcriptFailureHandler(b.deps, b.containers)(failure);
  await climbTheLadder(b);

  expect(transcripts()).toEqual([]);
  expectHeld(b);
  repair();
  await answer(b);
  await settle();
  expect(transcripts()).toHaveLength(1);
  expect(questions(b.db)).toEqual(["worker transcript could not be written: one", "the board's record container cannot be written — pickup is stopped"]);
  expect(b.slot.currentTaskId).toBeNull();
});

it("記録の tx の後の step が投げても落ちた後始末になり、受理はその step だけを撃ち直して枠を空ける —— failure question は2枚目を立てない(#2856)", async () => {
  const b = board();
  const forceReclaim = b.containers.forceReclaim.bind(b.containers);
  b.containers.forceReclaim = () => {
    throw new Error("force reclaim blew up");
  };

  spawnFailureHandler(b.deps, b.containers)(b.task.id, { error_code: "ENOENT", message: "spawn claude ENOENT" });

  expect(questions(b.db)).toEqual(["worker never started for task: one", FAILED_TEARDOWN_QUESTION_TITLE]);
  expect(b.slot.currentTaskId).toBe(b.task.id);
  b.containers.forceReclaim = forceReclaim;
  await answer(b);
  await settle();
  expect(questions(b.db)).toEqual(["worker never started for task: one"]);
  expect(b.slot.currentTaskId).toBeNull();
});

it("直さずに受理すると拒まれ(DomainError)、question は開いたまま枠も握ったまま —— 直してからの受理は通る(ADR 0112 決定3)", async () => {
  const b = board();
  const repair = failTeardownMark(b.db);
  spawnFailureHandler(b.deps, b.containers)(b.task.id, { error_code: "ENOENT", message: "spawn claude ENOENT" });

  await expect(answer(b)).rejects.toThrow(DomainError);
  await expect(answer(b)).rejects.toThrow("teardown mark failed");

  expectHeld(b);
  repair();
  await answer(b);
  await settle();
  expect(b.slot.currentTaskId).toBeNull();
});

it("runner の中で盤面 DB が書きを拒めば(A)、question を立てずに投げる —— 底が process を終える(ADR 0342 決定2・6)", () => {
  const b = board();
  b.containers.forceReclaim(b.task.id);
  b.db.pragma("query_only = 1");

  expect(() => b.watchdog.onWorkerExited(b.task.id, { ...QUIET_EXIT, exit_code: 1 }, { workerSpawnedEventId: b.spawned, turnRan: true, writes: [], capInterrupted: false })).toThrow(
    expect.objectContaining({ code: "SQLITE_READONLY" }),
  );

  b.db.pragma("query_only = 0");
  expect(questions(b.db)).toEqual([]);
  expect(getTask(b.db, b.task.id)?.status).toBe("in_progress");
});

it("破られた契約への備え: 分類の Promise が reject しても(adapter の書き込みは束の step へ移ったのでそこからは来ない)、slot を黙って握り続けず落ちた後始末が立ち、梯子は進まず未処理の reject も出ない(#2822)", async () => {
  const b = board({ hold: true });

  const rejections = await unhandledRejectionsDuring(async () => {
    b.watchdog.onWorkerExited(b.task.id, { ...QUIET_EXIT, exit_code: 1 }, { workerSpawnedEventId: b.spawned, turnRan: true, writes: [], capInterrupted: Promise.reject(new Error("sweep: disk gone")) });
    await settle();
    await climbTheLadder(b);
  });

  expect(rejections).toEqual([]);
  expectHeld(b);
  expect(getTask(b.db, openQuarantineQuestion(b.db, "failedTeardown", b.task.id)!.id)?.purpose).toContain("sweep: disk gone");
});

/** 束の書く step(ADR 0342 決定6 / ADR 0338 決定4): 手ごとに撃った順を残し、`broken` の間だけ2つ目の手が投げる。 */
function writeSteps() {
  const steps: { broken: boolean; fired: string[]; writes: TeardownAction[] } = {
    broken: true,
    fired: [],
    writes: [
      () => steps.fired.push("exit"),
      () => {
        if (steps.broken) throw new Error("write step bug");
        steps.fired.push("temp");
      },
      () => steps.fired.push("project"),
    ],
  };
  return steps;
}

const FAILED_EXIT = { ...QUIET_EXIT, exit_code: 1 };

it.each([
  ["解決済みの分類", (): boolean | Promise<boolean> => false],
  ["Promise の分類", (): boolean | Promise<boolean> => Promise.resolve(false)],
] as const)("束の書く step が投げると(%s)落ちた後始末が1枚立って梯子は進まず、受理で step が再実行され枠が空く —— 済んだ step は撃ち直さない(ADR 0342 決定6)", async (_, cap) => {
  const b = board();
  const steps = writeSteps();
  b.containers.forceReclaim(b.task.id);

  b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: cap(), writes: steps.writes });
  await settle();
  await climbTheLadder(b);

  expectHeld(b);
  expect(steps.fired).toEqual(["exit"]);
  steps.broken = false;
  await answer(b);
  await settle();
  expect(steps.fired).toEqual(["exit", "temp", "project"]);
  expect(questions(b.db)).toEqual(["worker exited without reporting: one"]);
  expect(b.slot.currentTaskId).toBeNull();
});

it("直さずに受理すると書く step の撃ち直しが拒まれ、直してからの受理で枠が空く(ADR 0112 決定3 / #2857)", async () => {
  const b = board();
  const steps = writeSteps();
  b.containers.forceReclaim(b.task.id);
  b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: Promise.resolve(false), writes: steps.writes });
  await settle();

  await expect(answer(b)).rejects.toThrow("write step bug");
  expectHeld(b);

  steps.broken = false;
  await answer(b);
  await settle();
  expect(steps.fired).toEqual(["exit", "temp", "project"]);
  expect(b.slot.currentTaskId).toBeNull();
});

it("書く step は分類が揃ってから撃ち、決定はその後ろ —— Promise の分類の間は何も書かない(ADR 0342 決定6、ADR 0309 決定3 の Status 追記)", async () => {
  const b = board();
  const order: string[] = [];
  let classify!: (cap: boolean) => void;
  b.containers.forceReclaim(b.task.id);

  b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, {
    workerSpawnedEventId: b.spawned,
    turnRan: true,
    capInterrupted: new Promise<boolean>((resolve) => { classify = resolve; }),
    writes: [() => order.push(`questions at write: ${questions(b.db).length}`)],
  });
  await settle();
  expect(order).toEqual([]);

  classify(false);
  await settle();
  expect(order).toEqual(["questions at write: 0"]);
  expect(questions(b.db)).toEqual(["worker exited without reporting: one"]);
});

describe("盤面の決定の門より手前で書く —— 決定しない exit も記録は失わない(ADR 0342 決定6)", () => {
  /** 最終 verb が着地して後始末へ入った session。回収済み観測は `fireEmpty` が撃つ。 */
  function completed() {
    const b = board({ hold: true });
    completeTask(b.db, getTask(b.db, b.task.id)!, FULL_HANDOFF, "deckhand", b.clock.now(), "worker");
    markTeardown(b.db, b.task.id, b.clock.now());
    b.slot.enterTeardown();
    void b.containers.reclaimed(b.task.id).then(() => runTeardown(b.deps, b.task.id, teardownStep(b.db, b.task.id)));
    return b;
  }

  it("後始末中の exit も書く step を撃ち、決定はしない", () => {
    const b = completed();
    const steps = writeSteps();
    steps.broken = false;

    b.watchdog.onWorkerExited(b.task.id, QUIET_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: steps.writes });

    expect(steps.fired).toEqual(["exit", "temp", "project"]);
    expect(questions(b.db)).toEqual([]);
  });

  it("Promise の分類でも分類を待ってから撃つ", async () => {
    const b = completed();
    const steps = writeSteps();
    steps.broken = false;
    let classify!: (cap: boolean) => void;

    b.watchdog.onWorkerExited(b.task.id, QUIET_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: new Promise<boolean>((resolve) => { classify = resolve; }), writes: steps.writes });
    await settle();
    expect(steps.fired).toEqual([]);

    classify(false);
    await settle();
    expect(steps.fired).toEqual(["exit", "temp", "project"]);
  });

  it("後始末中の exit の書く step が投げると落ちた後始末が立ち、遅れた回収済み観測は残りの後ろに継がれて、受理が撃ち直してから後始末が枠を空ける(ADR 0112 決定4)", async () => {
    const b = completed();
    const steps = writeSteps();

    b.watchdog.onWorkerExited(b.task.id, QUIET_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: steps.writes });
    b.runtime.fireEmpty(b.task.id);
    await settle();

    expectHeld(b);
    steps.broken = false;
    await answer(b);
    await settle();
    expect(steps.fired).toEqual(["exit", "temp", "project"]);
    expect(questions(b.db)).toEqual([]);
    expect(b.slot.currentTaskId).toBeNull();
  });

  it("枠の主が替わった後に書く step が投げても次の session の枠を止めない —— log だけで question は立てない(ADR 0342 決定6)", () => {
    const b = board();
    const steps = writeSteps();
    b.slot.release();
    b.slot.occupy("next-task");

    b.watchdog.onWorkerExited(b.task.id, QUIET_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: steps.writes });

    expect(steps.fired).toEqual(["exit"]);
    expect(questions(b.db)).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(`[teardown] task ${b.task.id}:`, expect.objectContaining({ message: "write step bug" }));
  });
});

it("先に落ちた後始末の残りを持つ枠で書く step が投げても、先の残りを失わない —— 受理は投げた順に両方を撃ち直す(ADR 0342 決定6)", async () => {
  const b = board();
  const spawned = appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: b.clock.now() });
  const repair = failTeardownMark(b.db);
  transcriptFailureHandler(b.deps, b.containers)({ taskId: b.task.id, workerSpawnedEventId: spawned, file: "stream", error_code: "ENOSPC", message: "no space left", path: "/records/x.stream.jsonl" });
  const steps = writeSteps();

  b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: steps.writes });

  expectHeld(b);
  repair();
  steps.broken = false;
  await answer(b);
  await settle();
  expect(listEvents(b.db, b.task.id).filter((e) => e.kind === "transcript_failed")).toHaveLength(1);
  expect(steps.fired).toEqual(["exit", "temp", "project"]);
  expect(questions(b.db)).toEqual(["worker transcript could not be written: one", "the board's record container cannot be written — pickup is stopped"]);
  expect(b.slot.currentTaskId).toBeNull();
});

/** 残りが [書く step, 後始末] で question が開いている完了の session。受理の撃ち直しも `ensureWorkspaceToken` の await まで同期に走る。 */
async function teardownBehindWriteStep() {
  const ws = await makeWorkspace("sandbox");
  const b = board({ workspace: ws });
  await prepareWorkspaceAtPickup(b.db, ws, b.task);
  commitWork(ws.path, "deliverable.txt", "work\n");
  completeTask(b.db, getTask(b.db, b.task.id)!, FULL_HANDOFF, "deckhand", b.clock.now(), "worker");
  markTeardown(b.db, b.task.id, b.clock.now());
  b.slot.enterTeardown();
  const steps = writeSteps();

  // 後始末は `ensureWorkspaceToken` の await まで同期に走り、exit の settle はその中に着く
  const running = runTeardown(b.deps, b.task.id, teardownStep(b.db, b.task.id));
  b.watchdog.onWorkerExited(b.task.id, QUIET_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: steps.writes });
  await running;
  await settle();
  return { b, steps };
}

it("走っている後始末の await の間に書く step が投げても、後始末は枠を空けず残りの後ろに回る —— 受理は残りの手を撃ち、偽の workspace question を立てずに枠を空ける(ADR 0342 決定6)", async () => {
  const { b, steps } = await teardownBehindWriteStep();

  expectHeld(b);
  steps.broken = false;
  await answer(b);
  await settle();
  expect(steps.fired).toEqual(["exit", "temp", "project"]);
  expect(questions(b.db)).toEqual([]);
  expect(b.slot.currentTaskId).toBeNull();
}, GIT_FIXTURE_TEST_TIMEOUT);

it("残りが [後始末, 書く step] のとき、受理で後始末が枠を空けた後に step がまた投げても、次の受理は枠を取り直さず step だけ撃つ —— question なしで枠を握らない(ADR 0342 決定6 / ADR 0112 決定3)", async () => {
  const b = board({ hold: true });
  completeTask(b.db, getTask(b.db, b.task.id)!, FULL_HANDOFF, "deckhand", b.clock.now(), "worker");
  markTeardown(b.db, b.task.id, b.clock.now());
  b.slot.enterTeardown();
  let broken = true;
  await runTeardown(b.deps, b.task.id, {
    transition: () => {
      if (broken) throw new Error("teardown bug");
    },
  });
  const steps = writeSteps();
  b.watchdog.onWorkerExited(b.task.id, QUIET_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: steps.writes });
  broken = false;

  await expect(answer(b)).rejects.toThrow("write step bug");
  expect(b.slot.currentTaskId).toBeNull();

  steps.broken = false;
  await answer(b);
  await settle();
  expect(steps.fired).toEqual(["exit", "temp", "project"]);
  expect(questions(b.db)).toEqual([]);
  expect(b.slot.currentTaskId).toBeNull();
  expect(b.slot.inTeardown).toBe(false);
});

it("飲まれた回収済み観測の後で人間が止めると、受理の後ろで人間の停止の後始末が枠を空ける —— 偽の Containment question を立てない(ADR 0112 決定4 / ADR 0305)", async () => {
  const b = board({ hold: true });
  const steps = writeSteps();
  await b.clock.advance(CONFIG.timeLimits.work + CONFIG.grace);
  b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: steps.writes });
  b.runtime.fireEmpty(b.task.id);
  await settle();

  expect(b.watchdog.stopSession(b.task.id, () => recordHumanStop(b.db, b.task.id, "stop now", b.clock.now(), "webui"))).toBeUndefined();
  steps.broken = false;
  await answer(b);
  await settle();
  await b.clock.advance(CONFIG.reclaimTimeout * 2);
  await settle();

  expect(steps.fired).toEqual(["exit", "temp", "project"]);
  expect(questions(b.db)).toEqual(["stopped by human: one"]);
  expect(b.slot.currentTaskId).toBeNull();
});

it("書く step の中で盤面 DB が書きを拒めば(A)、question を立てずに底へ投げる —— 同期は throw、Promise の分類は reject(ADR 0342 決定2・6)", async () => {
  const b = board();
  const write = () => appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: b.clock.now() });
  const refused = expect.objectContaining({ code: "SQLITE_READONLY" });
  b.db.pragma("query_only = 1");

  expect(() => b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: [write] })).toThrow(refused);
  const rejections = await unhandledRejectionsDuring(async () => {
    b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: Promise.resolve(false), writes: [write] });
    await settle();
  });

  b.db.pragma("query_only = 0");
  expect(rejections).toContainEqual(refused);
  expect(questions(b.db)).toEqual([]);
  expect(b.slot.hasFailedTeardownRest(b.task.id)).toBe(false);
});

it("時間制限の停止の後の exit で書く step が投げても、飲まれた回収済み観測は受理の後ろで受ける —— 偽の Containment question を立てずに枠が空く(ADR 0112 決定4)", async () => {
  const b = board({ hold: true });
  const steps = writeSteps();
  await b.clock.advance(CONFIG.timeLimits.work + CONFIG.grace);
  expect(b.runtime.forceReclaims).toEqual([b.task.id]);

  b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: steps.writes });
  b.runtime.fireEmpty(b.task.id);
  await settle();
  expectHeld(b);

  steps.broken = false;
  await answer(b);
  await settle();
  await b.clock.advance(CONFIG.reclaimTimeout * 2);

  expect(steps.fired).toEqual(["exit", "temp", "project"]);
  expect(questions(b.db)).toEqual(["watchdog killed task: one"]);
  expect(b.slot.currentTaskId).toBeNull();
});

it("上限到達の後始末が印を消す書き込みで投げても、受理の撃ち直しが枠を空ける —— 状態遷移が1回だけ残り、偽の Containment question は立たない(ADR 0112 決定3)", async () => {
  const b = board({ hold: true });
  b.containers.forceReclaim(b.task.id);
  b.watchdog.onWorkerExited(b.task.id, QUIET_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: true, writes: [] });
  await settle();
  const repair = failTeardownMark(b.db);
  b.runtime.fireEmpty(b.task.id);
  await settle();
  expectHeld(b);

  repair();
  await answer(b);
  await settle();

  expect(b.slot.currentTaskId).toBeNull();
  expect(questions(b.db)).toEqual([]);
  expect(getTask(b.db, b.task.id)?.status).toBe("todo");
  expect(listEvents(b.db, b.task.id).filter((e) => e.kind === "cap_interrupted")).toHaveLength(1);
  await climbTheLadder(b);
  expect(questions(b.db)).toEqual([]);
});

describe("受理は残りが無くなるまで撃ってから通す(ADR 0112 決定3 / ADR 0342 決定6)", () => {
  /** 先に投げた書く step は直っていて、受理は残りを撃って後始末の await まで進む。 */
  async function repairedBehindWriteStep() {
    const { b, steps } = await teardownBehindWriteStep();
    steps.broken = false;
    return b;
  }

  /** 受理の await の間に遅れた exit の書く step が投げる。返るのは受理と、その exit の手。 */
  function acceptWhileWriteStepThrows(b: Board) {
    const late = writeSteps();
    const accepting = answer(b);
    b.watchdog.onWorkerExited(b.task.id, QUIET_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: late.writes });
    expect(late.fired).toEqual(["exit"]);
    return { accepting, late };
  }

  it("受理の await の間に書く step が投げても、直っていれば投げた手から撃ち直して枠を空けて通る", async () => {
    const b = await repairedBehindWriteStep();

    const { accepting, late } = acceptWhileWriteStepThrows(b);
    late.broken = false;
    await accepting;
    await settle();

    expect(late.fired).toEqual(["exit", "temp", "project"]);
    expect(questions(b.db)).toEqual([]);
    expect(boardHalts(b.db)).toEqual([]);
    expect(b.slot.currentTaskId).toBeNull();
    expect(b.slot.hasFailedTeardownRest(b.task.id)).toBe(false);
    await climbTheLadder(b);
    expect(questions(b.db)).toEqual([]);
  }, GIT_FIXTURE_TEST_TIMEOUT);

  it("同じ窓で直っていなければ回答は拒まれ、question は開いたまま枠と残りは保たれる —— 直してからの受理は通る", async () => {
    const b = await repairedBehindWriteStep();

    const { accepting, late } = acceptWhileWriteStepThrows(b);

    await expect(accepting).rejects.toThrow(DomainError);
    expectHeld(b);
    expect(b.slot.hasFailedTeardownRest(b.task.id)).toBe(true);
    late.broken = false;
    await answer(b);
    await settle();
    expect(late.fired).toEqual(["exit", "temp", "project"]);
    expect(b.slot.currentTaskId).toBeNull();
  }, GIT_FIXTURE_TEST_TIMEOUT);

  it("受理の await の間に遅い `runTeardown` が届いても解放は1回", async () => {
    const b = await repairedBehindWriteStep();
    const pollNow = vi.fn();
    b.deps.pollNow = pollNow;

    const accepting = answer(b);
    const lateTeardown = runTeardown(b.deps, b.task.id, teardownStep(b.db, b.task.id));
    await Promise.all([accepting, lateTeardown]);
    await settle();

    expect(pollNow).toHaveBeenCalledTimes(1);
    expect(questions(b.db)).toEqual([]);
    expect(b.slot.currentTaskId).toBeNull();
  }, GIT_FIXTURE_TEST_TIMEOUT);

  it("受理の await の間に届いた2つ目の回答は拒まれ、1つ目の受理が通って枠を空ける —— 残りも question も残らない", async () => {
    const b = await repairedBehindWriteStep();

    const first = answer(b);
    const second = answer(b);

    // 文面まで見る: 1つ目が閉じた question への回答も DomainError で拒まれるので、型だけでは印の拒否と見分けられない
    await expect(second).rejects.toThrow(DomainError);
    await expect(second).rejects.toThrow("already being re-run");
    await first;
    await settle();
    expect(questions(b.db)).toEqual([]);
    expect(b.slot.currentTaskId).toBeNull();
    expect(b.slot.hasFailedTeardownRest(b.task.id)).toBe(false);
  }, GIT_FIXTURE_TEST_TIMEOUT);
});

describe("exits belong to their original worker session", () => {
  function session() {
    const b = board({ hold: true });
    const spawned = b.spawned;
    const write = () => appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at: b.clock.now(), payload: {
      kind: "worker_exited", ...FAILED_EXIT, worker_spawned_event_id: spawned, output_closed: false, usage: null, advisor: null, model_swaps: [], refusals: [],
    } });
    return { ...b, spawned, write };
  }

  async function pickAgain(b: ReturnType<typeof session>, spawn: boolean) {
    b.containers.forceReclaim(b.task.id);
    b.runtime.fireEmpty(b.task.id);
    await b.containers.reclaimed(b.task.id);
    returnToQueue(b.db, b.task, { kind: "cap_interrupted" }, b.clock.now());
    b.slot.release();
    pickupTask(b.db, getTask(b.db, b.task.id)!, "deckhand", b.clock.now());
    b.slot.occupy(b.task.id);
    b.containers.open(b.task.id);
    b.runtime.hold(b.task.id);
    if (spawn) appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: b.clock.now() });
  }

  it.each(["after-pickup", "classification-pending"] as const)("a stale write failure cannot halt the replacement's time-limit ladder (%s)", async (when) => {
    const b = session();
    let classify!: (value: boolean) => void;
    const facts = { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: when === "classification-pending" ? new Promise<boolean>((resolve) => { classify = resolve; }) : false,
      writes: [b.write, () => { throw new Error("old session write failed"); }] };
    if (when === "classification-pending") b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, facts);
    await pickAgain(b, false);
    if (when === "after-pickup") b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, facts);
    else classify(false);
    await settle();

    expect(questions(b.db)).toEqual([]);
    expect(boardHalts(b.db)).toEqual([]);
    expect(b.slot.hasFailedTeardownRest(b.task.id)).toBe(false);
    expect(b.slot.inTeardown).toBe(false);
    expect(sessionInTeardown(b.db)).toBeUndefined();
    expect(getTask(b.db, b.task.id)?.status).toBe("in_progress");
    await b.clock.advance(CONFIG.timeLimits.work + CONFIG.grace);
    expect(b.runtime.forceReclaims).toEqual([b.task.id, b.task.id]);
  });

  it.each([false, true])("a cap classification resolved after another pickup cannot decide the new session (cap: %s)", async (cap) => {
    const b = session();
    let classify!: (value: boolean) => void;
    b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: new Promise<boolean>((resolve) => { classify = resolve; }), writes: [b.write] });
    await pickAgain(b, false);

    classify(cap);
    await settle();

    expect(getTask(b.db, b.task.id)?.status).toBe("in_progress");
    expect(questions(b.db)).toEqual([]);
    expect(b.slot.inTeardown).toBe(false);
    expect(sessionInTeardown(b.db)).toBeUndefined();
    expect(listEvents(b.db, b.task.id).filter((event) => event.kind === "worker_exited")).toHaveLength(1);
  });

  it.each([false, true])("a stale exit only records its original spawn after another pickup (replacement spawned: %s)", async (spawn) => {
    const b = session();
    await pickAgain(b, spawn);
    expect(getTask(b.db, b.task.id)?.status).toBe("in_progress");

    b.watchdog.onWorkerExited(b.task.id, FAILED_EXIT, { workerSpawnedEventId: b.spawned, turnRan: true, capInterrupted: false, writes: [b.write] });

    expect(getTask(b.db, b.task.id)?.status).toBe("in_progress");
    expect(questions(b.db)).toEqual([]);
    expect(b.slot.inTeardown).toBe(false);
    expect(sessionInTeardown(b.db)).toBeUndefined();
    expect(b.slot.currentTaskId).toBe(b.task.id);
    expect(listEvents(b.db, b.task.id).filter((event) => event.kind === "worker_exited").map((event) => event.payload)).toEqual([
      expect.objectContaining({ worker_spawned_event_id: b.spawned }),
    ]);
  });
});
