import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { createLanding, type Landing } from "../src/landing.js";
import { POLL_FAILURE_QUESTION_TITLE } from "../src/quarantine.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { listBoard, registerTask } from "../src/tasks.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { HUMAN_WEBUI } from "./harness.js";
import { failPrepareOnce, pushedRoot, settle } from "./landing-fixture.js";

/** registry の止まりの判定(`registryUnreadableOpen`)の読みだけが当たる文の断片。 */
const REGISTRY_STOP_READ = "question_quarantine_value IS ?";

/** scheduler の `idle` を landing の `pickupIdle` につなぐ盤面(`src/server.ts` と同じ配線)。`converge` の回を `runs` に残す。
 *  候補の読みは毎回まず `readCandidates` を撃つ —— 投げれば poll の本体が投げる。 */
function wiredBoard(
  readCandidates: (db: Db) => void,
  {
    db = openDb(":memory:"),
    clock = new FakeClock(),
    landingWith = ({ pickupIdle }) => createLanding({ defaultAgentName: "tako", db, clock, github: null, pickupIdle }),
  }: { db?: Db; clock?: FakeClock; landingWith?: (deps: { pickupIdle: () => Promise<void> }) => Landing } = {},
) {
  const worker = new ScriptedWorker(clock);
  const candidates = implicitTaskExecutionCandidates(db);
  const runs: Array<ReturnType<Landing["converge"]>> = [];
  let scheduler: ReturnType<typeof startScheduler> | undefined;
  const landing = landingWith({ pickupIdle: () => scheduler?.idle() ?? Promise.resolve() });
  scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: () => {
      const run = landing.converge();
      runs.push(run);
      return run;
    },
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: () => {},
    taskExecutionCandidates: (task) => {
      readCandidates(db);
      return candidates(task);
    },
  });
  registerTask(db, { type: "work", title: "head", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);
  return { db, clock, worker, scheduler, runs };
}

/** 候補の読みを投げさせ、その失敗を受ける pollFailed の判定の読みも1回だけ落とす —— 着地の `pass` の判定には当てない。 */
function breakCandidatesAndStopRead(db: Db): never {
  failPrepareOnce(db, REGISTRY_STOP_READ, "registry stop read broke");
  throw new Error("candidates read broke");
}

afterEach(() => {
  vi.restoreAllMocks();
});

// #3711: `pollFailed` の中の registry の判定が投げても、走っている poll の終わりを待つ収束は止まらない(ADR 0241 決定5 / ADR 0294 決定1)
it("poll の本体が投げ、その pollFailed の registry の判定の読みも投げた後でも、次の契機で収束の回と pickup が走る", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let failures = 1;
  const { worker, scheduler, runs } = wiredBoard((db) => {
    if (failures-- > 0) breakCandidatesAndStopRead(db);
  });

  scheduler.pollNow();
  await runs[0];
  await settle();
  scheduler.pollNow();

  await expect(runs[1]).resolves.toEqual([]);
  await settle();
  expect(worker.started.map((t) => t.title)).toEqual(["head"]);
  scheduler.stop();
});

const MINUTE = 60 * 1000;

/** pickup の契機1回を撃ち、その poll の終わりまで待つ。 */
async function trigger(scheduler: ReturnType<typeof startScheduler>) {
  scheduler.pollNow();
  await settle();
  await scheduler.idle();
}

// #3711: 判定が投げたら止まりは開いていない側に倒す —— 数えなければ、行も question も無いまま pickup が止まる(ADR 0294 決定1・2)
it("registry の止まりの判定の読みが投げ続けても、poll の失敗は行に残り、最初の失敗から10分で pollFailure の question が1枚立つ", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { db, clock, scheduler } = wiredBoard(breakCandidatesAndStopRead);

  await trigger(scheduler);
  expect(scheduler.lastPollFailure()).toEqual({ at: clock.now().toISOString(), message: "candidates read broke" });
  await clock.advance(10 * MINUTE);
  await trigger(scheduler);

  expect(listBoard(db).filter((t) => t.type === "question").map((q) => q.title)).toEqual([POLL_FAILURE_QUESTION_TITLE]);
  scheduler.stop();
});


// #3711: どこで投げた poll でも、終わりを待つ読み手は reject を受け取らない。撃ち直しの呼び手だけが自分の回の reject を受け取る
it("poll が reject すれば log に出し、撃ち直しの呼び手はその reject を受け取り、終わりを待つ idle と次の撃ち直しは止まらない", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  let unprintable = true;
  const { worker, scheduler } = wiredBoard(() => {
    // String() で文字にできない値 —— pollFailed の本文の写しが投げ、poll が reject する
    if (unprintable) throw Object.create(null);
  });

  await expect(scheduler.rerunPoll()).rejects.toThrow(TypeError);
  expect(logged).toHaveBeenCalledWith("[scheduler] poll rejected; the next trigger polls again:", expect.any(TypeError));
  await expect(scheduler.idle()).resolves.toBeUndefined();
  unprintable = false;

  expect(await scheduler.rerunPoll()).toEqual({ outcome: "succeeded" });
  expect(worker.started.map((t) => t.title)).toEqual(["head"]);
  scheduler.stop();
});

// #3711: `pass` の registry の判定が投げたら、止まりは開いていないとみなして根へ進む —— 根ごとの失敗は根ごとの catch が人間に届ける(ADR 0403 決定3)
it("収束の回の registry の止まりの判定の読みが投げても、回は reject せず根を撃ち、同じ契機の pickup も走る", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const c = await pushedRoot("registry-stop-read-throws");
  const { worker, scheduler, runs } = wiredBoard(() => {}, c);
  failPrepareOnce(c.db, REGISTRY_STOP_READ, "registry stop read broke");

  scheduler.pollNow();

  expect((await runs[0]!).map((root) => root.taskId)).toEqual([c.work.id]);
  await settle();
  await scheduler.idle();
  expect(worker.started.map((t) => t.title)).toEqual(["head"]);
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("[landing]"), expect.objectContaining({ message: "registry stop read broke" }));
  scheduler.stop();
});
