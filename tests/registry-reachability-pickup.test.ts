import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { loadRegistry, refreshRegistry } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { listBoard, registerTask, type Task } from "../src/tasks.js";
import type { KillSignal, WorkerAdapter } from "../src/worker.js";
import { FakeClock, healthyUsageText, ScriptedWorker } from "./fakes.js";
import { makeRemoteBackedRegistry } from "./registry-fixture.js";

// ここが測るのは**ゲートが spawn の手前で実際に fetch を撃つこと**である。worker は
// fake なので、実 worker がどの ref を読むかはここでは測れない —— それは
// tests/claude-worker.test.ts の「remote-backed 盤面の spawn は…」が測る。2つ揃って
// 初めて ADR 0052 決定2 の「観測点と refresh 点は同じ」が閉じる。
it("次の pickup は spawn の手前で registry を refresh する(ADR 0052)", async () => {
  // リモートにだけ merge が載り、clone の origin/main はまだ古い —— ゲートが
  // fetch を撃たなければ spawn は古い定義を読む、という状態を作る
  const { registryDir, publish } = await makeRemoteBackedRegistry();
  publish(
    "agents/deckhand.md",
    `---\nname: deckhand\ndescription: Definition merged on remote\nversion: 0.4.0\nauthority: standard\nskills:\n  - "*"\n---\nRemote definition.\n`,
    "merged registry change",
  );
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const spawnedVersions: string[] = [];
  const worker: WorkerAdapter = {
    id: "deckhand",
    start(_task: Task) {
      spawnedVersions.push(loadRegistry(registryDir, "remote-backed").agents.deckhand!.version);
    },
    kill(_taskId: string, _signal: KillSignal) {},
    async checkUsage() {
      return healthyUsageText(clock.now());
    },
  };
  const scheduler = startScheduler({
    db,
    clock,
    slot: new Slot(),
    worker,
    // GitHub 身元なしの盤面(ローカルの bare remote なので認証は要らない)
    registryReachability: async () => refreshRegistry(registryDir, undefined),
  });
  registerTask(
    db,
    {
      type: "work",
      title: "use the merged registry definition",
      purpose: "prove the pickup refreshes the registry cache",
      completion_criteria: "the spawned worker observes version 0.4.0",
    },
    clock.now(),
  );

  await clock.advance(HOURLY);

  expect(spawnedVersions).toEqual(["0.4.0"]);
  scheduler.stop();
});

it("registry に到達できない間は盤面全体の pickup を止め、確認 question を1枚だけ立てる(ADR 0052)", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const scheduler = startScheduler({
    db,
    clock,
    slot: new Slot(),
    worker,
    registryReachability: async () => ({
      available: false,
      reason: "origin is unreachable",
    }),
  });
  registerTask(
    db,
    {
      type: "work",
      title: "first queued task",
      purpose: "must wait for the registry source of truth",
      completion_criteria: "runs after repair",
    },
    clock.now(),
  );
  registerTask(
    db,
    {
      type: "work",
      title: "second queued task",
      purpose: "proves the stop is board-wide",
      completion_criteria: "runs after repair",
    },
    clock.now(),
  );

  await clock.advance(HOURLY * 3);

  const questions = listBoard(db).filter((task) => task.type === "question");
  expect({ started: worker.started, questionTitles: questions.map((task) => task.title) }).toEqual({
    started: [],
    questionTitles: ["registry remote is unreachable — pickup is stopped"],
  });
  scheduler.stop();
});
