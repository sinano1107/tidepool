import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { openDb } from "../src/db.js";
import { listEvents, taskDecisionLog } from "../src/events.js";
import { setPaused } from "../src/pause.js";
import { POLL_FAILURE_QUESTION_TITLE } from "../src/quarantine.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, getTask, listBoard, registerTask } from "../src/tasks.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { HUMAN_WEBUI, quarantineQuestion, unhandledRejectionsDuring } from "./harness.js";

/** ADR 0294 決定1: slot を握る前の poll の想定外の例外は盤面を落とさず、「最後の poll の失敗」の行に残して次の poll に任せる。 */
function board(overrides: Partial<Parameters<typeof startScheduler>[0]> = {}) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const candidates = implicitTaskExecutionCandidates(db);
  const state = { broken: true, calls: 0 };
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: async () => [],
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: () => {},
    taskExecutionCandidates: (task) => {
      state.calls++;
      if (state.broken) throw new Error("registry is broken");
      return candidates(task);
    },
    ...overrides,
  });
  const head = registerTask(db, { type: "work", title: "head", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);
  return { db, clock, worker, scheduler, state, head };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("候補の読みが投げても unhandledRejection は撃たれず、次の tick も本体に入り、最後の poll の失敗が時刻と本文で残る", async () => {
  const { clock, worker, scheduler, state } = board();

  const rejections = await unhandledRejectionsDuring(async () => {
    await clock.advance(HOURLY);
    await clock.advance(HOURLY);
  });

  expect(rejections).toEqual([]);
  expect(state.calls).toBe(2);
  expect(worker.started).toEqual([]);
  expect(scheduler.lastPollFailure()).toEqual({ at: clock.now().toISOString(), message: "registry is broken" });
  scheduler.stop();
});

it("門で返った poll(Pause)は行を残し、Pause を解いて本体に入った poll が投げずに終われば行は消える", async () => {
  const { db, clock, worker, scheduler, state } = board();
  await clock.advance(HOURLY);
  const failure = scheduler.lastPollFailure();

  setPaused(db, true);
  await clock.advance(HOURLY);
  expect(scheduler.lastPollFailure()).toEqual(failure);

  setPaused(db, false);
  state.broken = false;
  await clock.advance(HOURLY);
  expect(worker.started.map((t) => t.title)).toEqual(["head"]);
  expect(scheduler.lastPollFailure()).toBeUndefined();
  scheduler.stop();
});

it("投げた task が消えて queue が空になれば、本体に入った poll は成功に数えられ行は消える", async () => {
  const { db, clock, scheduler, head } = board();
  await clock.advance(HOURLY);
  expect(scheduler.lastPollFailure()).toBeDefined();

  cancelTaskDirectly(db, head, null, clock.now(), {}, "webui");
  await clock.advance(HOURLY);

  expect(scheduler.lastPollFailure()).toBeUndefined();
  scheduler.stop();
});

it("後始末の一撃そのものが投げても process は生きて行が残り、一撃は撃ち直されない(ADR 0294 決定5)", async () => {
  let shots = 0;
  const { clock, worker, scheduler, state } = board({
    onSpawnFailed: () => {
      shots++;
      throw new Error("teardown one-shot blew up");
    },
  });
  state.broken = false;
  worker.scriptStartFailure(new Error("spawn blew up"));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  const rejections = await unhandledRejectionsDuring(async () => {
    await clock.advance(HOURLY);
    await clock.advance(HOURLY);
  });

  expect(rejections).toEqual([]);
  expect(shots).toBe(1);
  expect(scheduler.lastPollFailure()?.message).toBe("teardown one-shot blew up");
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("[scheduler] poll failed"), expect.objectContaining({ message: "teardown one-shot blew up" }));
  scheduler.stop();
});

it("pickup の契機で収束が reject しても unhandledRejection は撃たれない", async () => {
  const { scheduler } = board({
    converge: async () => {
      throw new Error("convergence blew up");
    },
  });

  const rejections = await unhandledRejectionsDuring(async () => scheduler.pollNow());

  expect(rejections).toEqual([]);
  scheduler.stop();
});

const MINUTE = 60 * 1000;

const quietErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

/** pickup の契機1回(`pollNow`)を撃ち、その poll の終わりまで待つ。 */
async function trigger(scheduler: ReturnType<typeof board>["scheduler"]) {
  scheduler.pollNow();
  await new Promise((resolve) => setImmediate(resolve));
  await scheduler.idle();
}

describe("続く poll の失敗の question(ADR 0294 決定2)", () => {
  beforeEach(() => void quietErrors());

  it("最初の失敗から10分後の失敗で Tidepool 名義の question が1枚立ち、もう1度投げても2枚目も再発火の event も無い", async () => {
    const { db, clock, scheduler } = board();
    await trigger(scheduler);
    await clock.advance(10 * MINUTE);
    await trigger(scheduler);
    const question = quarantineQuestion(db, "pollFailure", null)!;
    expect(question.title).toBe(POLL_FAILURE_QUESTION_TITLE);
    expect(listEvents(db, question.id).find((e) => e.kind === "task_registered")).toMatchObject({ actor_id: BOARD_ACTOR_ID, origin: "board" });

    await trigger(scheduler);

    expect(listBoardQuestions(db).map((q) => q.id)).toEqual([question.id]);
    expect(listEvents(db, question.id).map((e) => e.payload.kind)).not.toContain("quarantine_refired");
    scheduler.stop();
  });

  it("門の中(封じ込めの検査)で投げ続ける poll も数え、10分で立つ", async () => {
    const { db, clock, scheduler, state } = board({
      containment: async () => {
        throw new Error("containment probe exploded");
      },
    });
    await trigger(scheduler);
    await clock.advance(10 * MINUTE);
    await trigger(scheduler);

    expect(quarantineQuestion(db, "pollFailure", null)!.purpose).toContain("Latest exception: containment probe exploded");
    expect(state.calls).toBe(0);
    scheduler.stop();
  });

  it("10分未満の間の失敗では立たない", async () => {
    const { db, clock, scheduler } = board();
    await trigger(scheduler);
    await clock.advance(10 * MINUTE - 1);
    await trigger(scheduler);

    expect(listBoardQuestions(db)).toEqual([]);
    scheduler.stop();
  });

  it("契機の連打(数秒の間の失敗)だけでは立たない", async () => {
    const { db, clock, scheduler } = board();
    for (let i = 0; i < 5; i++) {
      await trigger(scheduler);
      await clock.advance(1000);
    }

    expect(listBoardQuestions(db)).toEqual([]);
    scheduler.stop();
  });

  it("本文が poll ごとに変わっても10分で立ち、本文は いつから・何回・最初と最新の例外の本文・撃ち直しの予告 だけを言う", async () => {
    let n = 0;
    const { db, clock, scheduler } = board({
      taskExecutionCandidates: () => {
        throw new Error(`registry is broken at commit ${++n}`);
      },
    });
    const since = clock.now().toISOString();
    await trigger(scheduler);
    await clock.advance(5 * MINUTE);
    await trigger(scheduler);
    await clock.advance(5 * MINUTE);
    await trigger(scheduler);

    expect(quarantineQuestion(db, "pollFailure", null)!.purpose).toBe(
      `the board's poll has thrown 3 times since ${since} with no successful poll in between.\n\n` +
        "First exception: registry is broken at commit 1\n\n" +
        "Latest exception: registry is broken at commit 3\n\n" +
        "Answering re-runs the poll: if it throws again the answer is refused, this question stays open, " +
        "and the refusal carries that run's exception body.",
    );
    scheduler.stop();
  });

  it("回答せず本体に入った poll が成功すれば question は回答なしで決着し、quarantine_released を残し、decision log に載らず、計測は戻る", async () => {
    const { db, clock, scheduler, state } = board();
    await trigger(scheduler);
    await clock.advance(10 * MINUTE);
    await trigger(scheduler);
    const question = quarantineQuestion(db, "pollFailure", null)!;

    state.broken = false;
    await trigger(scheduler);

    expect(getTask(db, question.id)!.status).toBe("done");
    expect(listEvents(db, question.id).at(-1)!.payload).toEqual({ kind: "quarantine_released", quarantine: "pollFailure", value: null });
    expect(taskDecisionLog(db, question.id)).toEqual([]);
    // 計測は戻った: 成功の後の最初の失敗は10分前の失敗に繋がらない
    registerTask(db, { type: "work", title: "next", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);
    state.broken = true;
    await trigger(scheduler);
    expect(quarantineQuestion(db, "pollFailure", null)).toBeUndefined();
    scheduler.stop();
  });
});

describe("撃ち直しの口(ADR 0294 決定2 の受理の検査)", () => {
  beforeEach(() => void quietErrors());

  it("本体が投げれば例外の本文を、投げなければ成功を返す", async () => {
    const { scheduler, state, worker } = board();

    expect(await scheduler.rerunPoll()).toEqual({ outcome: "threw", message: "registry is broken" });
    state.broken = false;
    expect(await scheduler.rerunPoll()).toEqual({ outcome: "succeeded" });
    expect(worker.started.map((t) => t.title)).toEqual(["head"]);
    scheduler.stop();
  });

  it("本体に入れなければ、入れなかった理由を名指す —— slot 握り中・Pause", async () => {
    const slot = new Slot();
    const { db, scheduler, state } = board({ slot });
    state.broken = false;

    slot.occupy("task-in-the-slot");
    expect(await scheduler.rerunPoll()).toEqual({ outcome: "blocked", reason: "the slot is held by task task-in-the-slot" });
    slot.release();
    setPaused(db, true);
    expect(await scheduler.rerunPoll()).toEqual({ outcome: "blocked", reason: "pickup is stopped: pause" });
    expect(state.calls).toBe(0);
    scheduler.stop();
  });

  it("走っている poll があれば入れなかったと答え、その poll を `idle` から見失わせない", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { scheduler, state } = board({
      containment: async () => {
        await held;
        return { available: true };
      },
    });
    state.broken = false;

    const first = scheduler.rerunPoll();
    expect(await scheduler.rerunPoll()).toEqual({ outcome: "blocked", reason: "another poll is in flight" });
    let idled = false;
    void scheduler.idle().then(() => (idled = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(idled).toBe(false);

    release();
    expect(await first).toEqual({ outcome: "succeeded" });
    scheduler.stop();
  });
});

/** ADR 0342 決定4: poll 失敗の行の guard は境界 —— 盤面 DB の拒否は行にも question にもせず投げる(床が process を終える)。 */
describe("盤面 DB が書きを拒んだ poll", () => {
  beforeEach(() => void quietErrors());
  const refusal = () => new Database.SqliteError("database or disk is full", "SQLITE_FULL");

  it("候補の読みで拒まれれば poll は投げ、最後の poll の失敗の行は残らない", async () => {
    const error = refusal();
    const { scheduler } = board({
      taskExecutionCandidates: () => {
        throw error;
      },
    });

    await expect(scheduler.rerunPoll()).rejects.toBe(error);
    expect(scheduler.lastPollFailure()).toBeUndefined();
    scheduler.stop();
  });

  it("pickup の契機の poll が拒まれれば、鎖の末尾で飲まず unhandled rejection として床へ届く", async () => {
    const error = refusal();
    const { clock, scheduler } = board({
      taskExecutionCandidates: () => {
        throw error;
      },
    });

    const rejections = await unhandledRejectionsDuring(() => clock.advance(HOURLY));

    expect(rejections).toEqual([error]);
    scheduler.stop();
  });

  it("後始末の一撃で拒まれれば poll は投げ、行は残らない", async () => {
    const error = refusal();
    const { scheduler, state, worker } = board({
      onSpawnFailed: () => {
        throw error;
      },
    });
    state.broken = false;
    worker.scriptStartFailure(new Error("spawn blew up"));

    await expect(scheduler.rerunPoll()).rejects.toBe(error);
    expect(scheduler.lastPollFailure()).toBeUndefined();
    scheduler.stop();
  });

  it("続く poll の失敗の question の登録で拒まれれば poll は投げる", async () => {
    let readonly = false;
    const b = board({
      taskExecutionCandidates: () => {
        if (readonly) b.db.pragma("query_only = 1");
        throw new Error("registry is broken");
      },
    });
    await b.scheduler.rerunPoll();
    await b.clock.advance(10 * MINUTE);
    readonly = true;

    await expect(b.scheduler.rerunPoll()).rejects.toThrow("attempt to write a readonly database");
    b.scheduler.stop();
  });

  it("開いた question の観測での決着で拒まれれば poll は投げる", async () => {
    let readonly = false;
    const b = board({
      converge: async () => {
        if (readonly) b.db.pragma("query_only = 1");
        return [];
      },
    });
    await b.scheduler.rerunPoll();
    await b.clock.advance(10 * MINUTE);
    await b.scheduler.rerunPoll();
    expect(quarantineQuestion(b.db, "pollFailure", null)).toBeDefined();
    // queue を空にする —— 本体は書かずに成功し、finally の決着だけが書く
    cancelTaskDirectly(b.db, b.head, null, b.clock.now(), {}, "webui");
    readonly = true;

    await expect(b.scheduler.rerunPoll()).rejects.toThrow("attempt to write a readonly database");
    b.scheduler.stop();
  });
});

const listBoardQuestions = (db: ReturnType<typeof openDb>) => listBoard(db).filter((task) => task.type === "question");
