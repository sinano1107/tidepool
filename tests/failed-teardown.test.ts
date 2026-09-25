import { rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { type Db, openDb } from "../src/db.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import type { Landing } from "../src/landing.js";
import { FAILED_TEARDOWN_QUESTION_TITLE, openQuarantineQuestion } from "../src/quarantine.js";
import { Slot } from "../src/slot.js";
import {
  BOARD_WORKER_ID,
  completeTask,
  escalateTask,
  getTask,
  listBoard,
  pickupTask,
  registerTask,
  type Task,
} from "../src/tasks.js";
import {
  acceptTeardownQuarantine,
  markTeardown,
  runTeardown,
  type TeardownDeps,
  teardownStep,
} from "../src/teardown.js";
import { prepareWorkspaceAtPickup, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, unusedLanding } from "./fakes.js";
import { commitWork, FULL_HANDOFF, git, makeWorkspace } from "./harness.js";

/** 落ちた後始末は盤面全体の停止であり、解放の門は後始末の再実行そのものである
 *  (ADR 0112)。既存 quarantine 族の**機構だけ**を借りる —— 確認 question 1枚、
 *  受理の直前の検査、回答が唯一の門。 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
// 想定外の例外は握り潰さず console にも残る(この経路の唯一の signal ではなくなった)
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const questions = (db: Db) => listBoard(db).filter((t) => t.type === "question");

const events = (db: Db, taskId: string) =>
  (db.prepare("SELECT kind FROM events WHERE task_id = ?").all(taskId) as { kind: string }[]).map(
    (e) => e.kind,
  );

interface Fixture {
  db: Db;
  clock: FakeClock;
  slot: Slot;
  task: Task;
  ws: WorkspaceConfig;
  deps: TeardownDeps;
  landing: Landing;
  landed: string[];
  /** 盤面のコードが直って再デプロイされた。 */
  repair: () => void;
}

/** 後始末が投げる session。落ちるのは盤面自身のコード —— workspace の解決が想定外の
 *  例外で止まる(`releaseWorkspace` が自前で quarantine に落とす nameable な失敗は
 *  そもそもここへ届かない)。 */
async function session(route: "complete" | "cap" | "watchdog" = "complete"): Promise<Fixture> {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace(dirs, "sandbox");
  const slot = new Slot();
  const registered = registerTask(
    db,
    { type: "work", title: "one", purpose: "why", completion_criteria: "done" },
    clock.now(),
  );
  const picked = pickupTask(db, registered, "deckhand", clock.now())!;
  slot.occupy(picked.id);
  await prepareWorkspaceAtPickup(db, ws, picked, {});
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  const task =
    route === "complete"
      ? completeTask(db, picked, FULL_HANDOFF, "deckhand", clock.now())
      : picked;
  // watchdog の強制回収は failure question を**後始末より先に**立てる(escalate verb と
  // 同じ順)。決着した status がそのまま経路になる(ADR 0113 決定3)
  if (route === "watchdog") {
    escalateTask(
      db,
      picked,
      {
        context: "the task hit its work time limit",
        questions: [{ title: "watchdog killed task: one", options: ["retry", "abandon"], recommendation: "retry" }],
        cancel_option: "abandon",
      },
      BOARD_WORKER_ID,
      clock.now(),
      "board",
    );
  }
  markTeardown(db, task.id, clock.now());
  slot.enterTeardown();

  let broken = true;
  const landed: string[] = [];
  const landing: Landing = {
    ...unusedLanding,
    async land(t) {
      landed.push(t.id);
      return { kind: "landed", surface: "local_merge_question" };
    },
  };
  const deps: TeardownDeps = {
    db,
    clock,
    slot,
    resolve: () => {
      if (broken) throw new Error("resolve exploded");
      return ws;
    },
    landing,
    pollNow: () => {},
  };
  return { db, clock, slot, task, ws, deps, landing, landed, repair: () => (broken = false) };
}

/** 立っている落ちた後始末の question。 */
const openQuestion = (f: Fixture) => getTask(f.db, openQuarantineQuestion(f.db, "failedTeardown", f.task.id)!.id)!;

const answer = (f: Fixture, question: Task, deps: TeardownDeps = f.deps) =>
  submitAnswer(
    {
      db: f.db,
      pollNow() {},
      landing: f.landing,
      quarantineChecks: quarantineChecks({
        db: f.db,
        teardownQuarantine: (taskId: string) => acceptTeardownQuarantine(deps, taskId),
      }),
    },
    question,
    ["repaired by hand"],
    undefined,
    () => f.clock.now(),
  );

it("後始末が投げたら、落ちた後始末の question が1枚立つ —— 断言は3つだけで、再実行を予告する", async () => {
  const f = await session();

  await runTeardown(f.deps, f.task.id, teardownStep(f.db, f.task.id));

  const raised = questions(f.db);
  expect(raised.map((q) => q.title)).toEqual([FAILED_TEARDOWN_QUESTION_TITLE]);
  const purpose = raised[0]?.purpose ?? "";
  // どのタスクの後始末が・いつから未了で・盤面のコードが投げた例外の本文
  expect(purpose).toContain(f.task.id);
  expect(purpose).toContain(f.clock.now().toISOString());
  expect(purpose).toContain("resolve exploded");
  // 答えると後始末を撃ち直す。まだ落ちるなら回答は拒まれ、question は開いたまま残る
  expect(purpose).toContain("Answering re-runs the same teardown");
  // 諦めて枠を解放する2つ目の選択肢は無い
  expect(raised[0]?.question_items?.[0]?.options).toEqual(["repaired by hand"]);
  // 枠は握られたまま。workspace も動いていない
  expect(f.slot.currentTaskId).toBe(f.task.id);
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${f.task.id}`);
});

it("同じ session に対して2枚目は立たない", async () => {
  const f = await session();

  await runTeardown(f.deps, f.task.id, teardownStep(f.db, f.task.id));
  await runTeardown(f.deps, f.task.id, teardownStep(f.db, f.task.id));

  expect(questions(f.db)).toHaveLength(1);
});

it("通常完了・上限到達による中断・watchdog の強制回収のどの経路で落ちても同じ question が立つ", async () => {
  const cap = await session("cap");
  await runTeardown(cap.deps, cap.task.id, teardownStep(cap.db, cap.task.id));

  const forced = await session("watchdog");
  await runTeardown(forced.deps, forced.task.id, teardownStep(forced.db, forced.task.id));

  const done = await session();
  await runTeardown(done.deps, done.task.id, teardownStep(done.db, done.task.id));

  expect([cap, forced, done].map((f) => questions(f.db).map((q) => q.title))).toEqual([
    [FAILED_TEARDOWN_QUESTION_TITLE],
    ["watchdog killed task: one", FAILED_TEARDOWN_QUESTION_TITLE],
    [FAILED_TEARDOWN_QUESTION_TITLE],
  ]);
});

it("watchdog の強制回収で落ちた後始末の受理は、殺したタスクを queue head へ戻さない", async () => {
  const f = await session("watchdog");
  await runTeardown(f.deps, f.task.id, teardownStep(f.db, f.task.id));
  const question = openQuestion(f);
  f.repair();

  await answer(f, question);

  // 決着済みなので上限到達による中断の復帰は走らない —— 自動リトライは存在せず
  // (CONTEXT.md「Watchdog」)、queue へ戻すかは retry / abandon の回答が決める
  expect(events(f.db, f.task.id)).not.toContain("cap_interrupted");
  expect(getTask(f.db, question.id)?.status).toBe("done");
  // 殺したタスクの行き先を決めるのは、立ったままの retry / abandon の問いである
  expect(questions(f.db).map((q) => q.title)).toEqual(["watchdog killed task: one"]);
  expect(f.slot.currentTaskId).toBeNull();
});

it("早期 return では立たない —— 枠の主が変わった / 梯子の底で保留は失敗ではない", async () => {
  const changed = await session();
  changed.slot.release();
  changed.slot.occupy("someone-else");
  await runTeardown(changed.deps, changed.task.id, { completion: true });

  const held = await session();
  await runTeardown({ ...held.deps, heldForContainment: () => true }, held.task.id, {
    completion: true,
  });

  expect([questions(changed.db), questions(held.db)]).toEqual([[], []]);
});

it("受理の検査が通れば question が閉じ、tree rule・merge-back・slot 解放・着地まで完走する", async () => {
  const f = await session();
  await runTeardown(f.deps, f.task.id, teardownStep(f.db, f.task.id));
  const question = openQuestion(f);
  f.repair();

  await answer(f, question);

  expect(getTask(f.db, question.id)?.status).toBe("done");
  expect(boardHalts(f.db)).toEqual([]);
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(f.ws.path, "show", `task/${f.task.id}:deliverable.txt`)).toBe("the real work");
  expect(git(f.ws.path, "log", "--oneline", `task/${f.task.id}`)).not.toContain("WIP");
  expect(f.slot.currentTaskId).toBeNull();
  expect(f.landed).toEqual([f.task.id]);
});

it("受理の検査が投げれば回答が拒まれ、question は開いたまま、例外本文がメッセージに載る", async () => {
  const f = await session();
  await runTeardown(f.deps, f.task.id, teardownStep(f.db, f.task.id));
  const question = openQuestion(f);

  await expect(answer(f, question)).rejects.toThrow("resolve exploded");

  expect(getTask(f.db, question.id)?.status).toBe("todo");
  expect(openQuarantineQuestion(f.db, "failedTeardown", f.task.id)?.id).toBe(question.id);
  expect(boardHalts(f.db)).toEqual([{ kind: "failedTeardown" }]);
  expect(f.slot.currentTaskId).toBe(f.task.id);
});

it("再起動を跨いだ受理 —— 枠が空でも tree rule が走り、枠が空く", async () => {
  const f = await session();
  await runTeardown(f.deps, f.task.id, teardownStep(f.db, f.task.id));
  const question = openQuestion(f);
  f.repair();
  // 起動時復旧は落ちた後始末を撃ち直さず、**枠も占めない**。回答はその盤面へ届く
  const restarted = new Slot();

  await answer(f, question, { ...f.deps, slot: restarted });

  expect(getTask(f.db, question.id)?.status).toBe("done");
  expect(git(f.ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(restarted.currentTaskId).toBeNull();
  expect(f.landed).toEqual([f.task.id]);
});
