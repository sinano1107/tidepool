import { beforeEach, expect, it, vi } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { ProcessContainers } from "../src/process-container.js";
import { FAILED_TEARDOWN_QUESTION_TITLE, openQuarantineQuestion } from "../src/quarantine.js";
import { Slot } from "../src/slot.js";
import { completeTask, getTask, listBoard, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { acceptTeardownQuarantine, markTeardown, runTeardown, type TeardownDeps, teardownStep } from "../src/teardown.js";
import { spawnFailureHandler, startWatchdog, transcriptFailureHandler, type Watchdog } from "../src/watchdog.js";
import { FakeClock, FakeContainerRuntime, ScriptedWorker, unusedLanding } from "./fakes.js";
import { FULL_HANDOFF, failTeardownMark, HUMAN_WEBUI, QUIET_EXIT, unhandledRejectionsDuring, WORKER_SPAWNED } from "./harness.js";

/** 後始末の runner(ADR 0342 決定6 / ADR 0112): 後始末のどの step で盤面のバグが投げても落ちた後始末の question が1枚立ち、
 *  梯子は進まず、受理は投げた step を撃ち直す。workspace を持たない盤面(tree rule は no-op)で、step と枠だけを見る。 */

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
}

/** 走っている session 1つ。`hold` した容器は強制回収では空にならない。 */
function board({ hold = false } = {}): Board {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const runtime = new FakeContainerRuntime();
  const containers = new ProcessContainers(runtime);
  const task = pickupTask(db, registerTask(db, { type: "work", title: "one", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI), "deckhand", clock.now())!;
  slot.occupy(task.id);
  containers.open(task.id);
  if (hold) runtime.hold(task.id);
  const deps: TeardownDeps = { db, clock, slot, resolve: undefined, pollNow: () => {} };
  const watchdog = startWatchdog({ db, clock, slot, worker: new ScriptedWorker(clock), containers, pollNow: () => {}, config: CONFIG });
  return { db, clock, slot, runtime, containers, task, deps, watchdog };
}

const questions = (db: Db) => listBoard(db).filter((t) => t.type === "question").map((q) => q.title);

const repair = (db: Db) => db.exec("DROP TRIGGER fail_teardown_mark");

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
      b.watchdog.onWorkerExited(b.task.id, { ...QUIET_EXIT, exit_code: 1 }, { turnRan: true, capInterrupted: false });
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
  failTeardownMark(b.db);

  fire(b);
  await climbTheLadder(b);

  expectHeld(b);
  repair(b.db);
  await answer(b);
  await settle();
  expect(questions(b.db)).toEqual([failure]);
  expect(b.slot.currentTaskId).toBeNull();
});

it("回収済み観測の書き込みが投げると落ちた後始末が立ち、受理が撃ち直して watchdog の failure question を立て枠を空ける(ADR 0342 決定6)", async () => {
  const b = board({ hold: true });
  await b.clock.advance(CONFIG.timeLimits.work + CONFIG.grace);
  expect(b.runtime.forceReclaims).toEqual([b.task.id]);
  failTeardownMark(b.db);

  b.runtime.fireEmpty(b.task.id);
  await settle();
  await climbTheLadder(b);

  expectHeld(b);
  repair(b.db);
  await answer(b);
  await settle();
  expect(questions(b.db)).toEqual(["watchdog killed task: one"]);
  expect(b.slot.currentTaskId).toBeNull();
});

it("回収 timeout の書き込みが投げると落ちた後始末が立ち、待つ回収を報せない —— 受理が撃ち直すと Containment の門に移り、回収の待ちが行と一致する(ADR 0342 決定5・6)", async () => {
  const b = board({ hold: true });
  failTeardownMark(b.db);

  await b.clock.advance(CONFIG.timeLimits.work + CONFIG.grace + CONFIG.reclaimTimeout);
  await b.clock.advance(CONFIG.reclaimTimeout * 3);

  expectHeld(b);
  expect(b.watchdog.heldForContainment(b.task.id)).toBe(false);
  repair(b.db);
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

it("後始末(`runTeardown`)が投げると落ちた後始末が立ち、後始末の梯子は進まない —— 受理が後始末を撃ち直して枠が空く(ADR 0112)", async () => {
  const b = board({ hold: true });
  completeTask(b.db, getTask(b.db, b.task.id)!, FULL_HANDOFF, "deckhand", b.clock.now(), "worker");
  markTeardown(b.db, b.task.id, b.clock.now());
  b.slot.enterTeardown();
  // 印を消す書き込み(`clearTeardown`)が投げる
  failTeardownMark(b.db);

  await runTeardown(b.deps, b.task.id, teardownStep(b.db, b.task.id));
  await climbTheLadder(b);

  expectHeld(b);
  expect(b.runtime.forceReclaims).toEqual([]);
  repair(b.db);
  await answer(b);
  expect(b.slot.currentTaskId).toBeNull();
});

it("transcript 失敗の一撃が投げると event も残らず落ちた後始末が立ち、受理の撃ち直しが event を1行だけ書く(ADR 0149 決定4 / ADR 0342 決定6)", async () => {
  const b = board();
  const spawned = appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: b.clock.now() });
  const failure = { taskId: b.task.id, workerSpawnedEventId: spawned, file: "stream", error_code: "ENOSPC", message: "no space left", path: "/records/x.stream.jsonl" } as const;
  failTeardownMark(b.db);
  const transcripts = () => listEvents(b.db, b.task.id).filter((e) => e.kind === "transcript_failed");

  transcriptFailureHandler(b.deps, b.containers)(failure);
  await climbTheLadder(b);

  expect(transcripts()).toEqual([]);
  expectHeld(b);
  repair(b.db);
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
  failTeardownMark(b.db);
  spawnFailureHandler(b.deps, b.containers)(b.task.id, { error_code: "ENOENT", message: "spawn claude ENOENT" });

  await expect(answer(b)).rejects.toThrow(DomainError);
  await expect(answer(b)).rejects.toThrow("teardown mark failed");

  expectHeld(b);
  repair(b.db);
  await answer(b);
  await settle();
  expect(b.slot.currentTaskId).toBeNull();
});

it("runner の中で盤面 DB が書きを拒めば(A)、question を立てずに投げる —— 底が process を終える(ADR 0342 決定2・6)", () => {
  const b = board();
  b.containers.forceReclaim(b.task.id);
  b.db.pragma("query_only = 1");

  expect(() => b.watchdog.onWorkerExited(b.task.id, { ...QUIET_EXIT, exit_code: 1 }, { turnRan: true, capInterrupted: false })).toThrow(
    expect.objectContaining({ code: "SQLITE_READONLY" }),
  );

  b.db.pragma("query_only = 0");
  expect(questions(b.db)).toEqual([]);
  expect(getTask(b.db, b.task.id)?.status).toBe("in_progress");
});

it("分類の Promise が reject すると(adapter の記録の書き込みが投げた)、slot を黙って握り続けず落ちた後始末が立ち、梯子は進まず未処理の reject も出ない(#2822)", async () => {
  const b = board({ hold: true });

  const rejections = await unhandledRejectionsDuring(async () => {
    b.watchdog.onWorkerExited(b.task.id, { ...QUIET_EXIT, exit_code: 1 }, { turnRan: true, capInterrupted: Promise.reject(new Error("sweep: disk gone")) });
    await settle();
    await climbTheLadder(b);
  });

  expect(rejections).toEqual([]);
  expectHeld(b);
  expect(getTask(b.db, openQuarantineQuestion(b.db, "failedTeardown", b.task.id)!.id)?.purpose).toContain("sweep: disk gone");
});
