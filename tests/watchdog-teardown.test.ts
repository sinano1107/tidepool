import { rm, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { type Db, openDb } from "../src/db.js";
import { quarantineFailedTeardown } from "../src/failed-teardown.js";
import type { Landing } from "../src/landing.js";
import { ProcessContainers } from "../src/process-container.js";
import { FAILED_TEARDOWN_QUESTION_TITLE } from "../src/quarantine.js";
import { Slot } from "../src/slot.js";
import { completeTask, escalateTask, getTask, listBoard, nextSlotTask, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { markTeardown, runTeardown } from "../src/teardown.js";
import { capInterruptionHandler, startWatchdog, type Watchdog } from "../src/watchdog.js";
import {
  prepareWorkspaceAtPickup,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "../src/workspace.js";
import { FakeClock, FakeContainerRuntime, ScriptedWorker } from "./fakes.js";
import { commitWork, FULL_HANDOFF, git, makeWorkspace } from "./harness.js";

/** 後始末の時限(ADR 0109 決定5)と、その底に落ちた完了済み session(ADR 0099 決定3)。
 *  梯子の底では**解放の門は確認 question ただ1つ**であり、遅れて届いた回収済み観測が
 *  それを跨いではならない —— 跨げば確認 question が開いたまま workspace と slot が動く。 */

const MIN = 60 * 1000;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** 後始末は fire-and-forget の `void` の先にある。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

interface Fixture {
  db: Db;
  clock: FakeClock;
  slot: Slot;
  task: Task;
  ws: WorkspaceConfig;
  runtime: FakeContainerRuntime;
  worker: ScriptedWorker;
  watchdog: Watchdog;
  /** 盤面が持つ着地口 —— MCP 側の後始末も同じものを渡される。 */
  landing: Landing;
  /** 着地が撃たれた task id、呼ばれた順。 */
  landed: string[];
}

/** 最終 verb が着地し、後始末に入ったところで止まっている完了済み session。容器は
 *  `hold` されている = root が exit しても空にならないホスト。 */
async function sessionInTeardown(
  route: "complete" | "cap" | "escalate" = "complete",
): Promise<Fixture> {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace(dirs, "sandbox");
  const slot = new Slot();
  const runtime = new FakeContainerRuntime();
  const containers = new ProcessContainers(runtime);
  const registered = registerTask(
    db,
    { type: "work", title: "one", purpose: "why", completion_criteria: "done" },
    clock.now(),
  );
  const picked = pickupTask(db, registered, "deckhand", clock.now());
  slot.occupy(picked.id);
  await prepareWorkspaceAtPickup(db, ws, picked, {});
  // 盤面は pickup 時に session の容器を作る。このホストでは force だけでは空にならない
  containers.open(picked.id);
  runtime.hold(picked.id);
  commitWork(ws.path, "deliverable.txt", "the real work\n");

  const task =
    route === "complete"
      ? completeTask(db, picked, FULL_HANDOFF, "deckhand", clock.now())
      : picked;
  if (route === "escalate") {
    escalateTask(db, picked, {
      context: "need a decision",
      questions: [{ title: "which?", options: ["a", "b"], recommendation: "a" }],
    }, "deckhand", clock.now());
  }
  if (route !== "cap") {
    markTeardown(db, task.id, clock.now());
    slot.enterTeardown();
  }

  const landed: string[] = [];
  const landing: Landing = {
    async land(t) {
      landed.push(t.id);
      return { kind: "landed", surface: "local_merge_question" };
    },
    async relandAncestors() {
      return [];
    },
    async observeMergedPullRequest() {
      return false;
    },
    async tick() {},
  };
  const worker = new ScriptedWorker(clock);
  const watchdog = startWatchdog({
    db,
    clock,
    slot,
    worker,
    containers,
    workspace: ws,
    landing,
    pollNow: () => {},
    config: { timeLimits: { work: 90 * MIN }, grace: 30 * MIN, reclaimTimeout: 5 * MIN },
  });
  if (route === "cap") {
    capInterruptionHandler({ db, clock, slot, resolve: () => ws, heldForContainment: watchdog.heldForContainment, pollNow: () => {} })(task.id, containers.reclaimed(task.id));
    containers.forceReclaim(task.id);
  }
  return { db, clock, slot, task, ws, runtime, worker, watchdog, landing, landed };
}

/** 後始末の backstop を超え、回収も観測できないまま梯子の底まで落とす。 */
async function fallToTheBottom(f: Fixture): Promise<void> {
  await f.clock.advance(5 * MIN); // backstop 超過 → 強制回収
  expect(f.runtime.forceReclaims).toEqual([f.task.id]);
  await f.clock.advance(5 * MIN); // 回収 timeout → Containment quarantine
  expect(f.watchdog.heldForContainment(f.task.id)).toBe(true);
}

const questions = (db: Db) => listBoard(db).filter((t) => t.type === "question");

it("cap settlement supersedes an already pending watchdog reclaim callback", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const runtime = new FakeContainerRuntime();
  const containers = new ProcessContainers(runtime);
  const task = pickupTask(db, registerTask(db, { type: "work", title: "one", purpose: "why", completion_criteria: "done" }, clock.now()), "deckhand", clock.now());
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
  registerTask(f.db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, f.clock.now());
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
  expect(f.landed).toEqual([]);
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
  expect(f.landed).toEqual([]);
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

it("梯子の底まで落ちた完了済み session でも、確認回答で後始末が完走して着地まで走る", async () => {
  const f = await sessionInTeardown();
  await fallToTheBottom(f);

  // 人間が手で残存 process を片付けた = 容器の空が観測できるようになった
  f.runtime.fireEmpty(f.task.id);
  await settle();
  f.watchdog.acceptReclaimed();
  await settle();

  // 検査(退避ではない)→ merge-back → 休止位置 → slot 解放 → **着地**(ADR 0109 決定1)
  expect(workspaceNeedsHuman(f.db, f.ws.name)).toBe(false);
  expect(git(f.ws.path, "log", "--oneline", `task/${f.task.id}`)).not.toContain("WIP");
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(f.slot.currentTaskId).toBeNull();
  expect(f.landed).toEqual([f.task.id]);
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
    landing: f.landing,
    heldForContainment: f.watchdog.heldForContainment,
    pollNow: () => {},
  };
  await runTeardown(teardownDeps, f.task.id, { completion: true, workspace: f.ws });

  // 確認 question は開いたまま。workspace も slot も動かない
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${f.task.id}`);
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(f.landed).toEqual([]);
  expect(boardHalts(f.db)).toEqual([{ kind: "containment" }]);

  // 回答で初めて走る —— どちらの順でもちょうど1回
  f.watchdog.acceptReclaimed();
  await settle();
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(f.slot.currentTaskId).toBeNull();
  expect(f.landed).toEqual([f.task.id]);
});
