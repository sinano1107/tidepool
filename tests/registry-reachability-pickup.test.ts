import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { loadRegistry, refreshRegistry } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { listBoard, registerTask, type Task } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import { FakeClock, fakeContainers, healthyUsageText, ScriptedWorker } from "./fakes.js";
import { api, bootTidepool, HOUR, registerWork } from "./harness.js";
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
    `---\nname: deckhand\ndescription: Definition merged on remote\nversion: 0.4.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\n---\nRemote definition.\n`,
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
    gracefulStop(_taskId: string) {},
    async checkUsage() {
      return healthyUsageText(clock.now());
    },
  };
  const scheduler = startScheduler({
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
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
    containers: fakeContainers(),
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
  // ADR 0093 決定7: user token の失効はまずここに出るので、再ログインのコマンドを名指しする
  expect(questions[0]?.purpose).toContain("npm run github-login");
  scheduler.stop();
});

// ADR 0068 決定5 の帰結: registry の確認 question が開いている間、poll は候補選定の
// **手前**の同期プレフィックスで止まる。壊れている間の /usage 観測はもう走らない
// (pickup しないという結果は同一 — 消えるのは無駄な観測だけ)。
it("registry 質問が開いている間、poll は /usage を観測しない(ADR 0068 決定5)", async () => {
  const t = await bootTidepool({
    registryReachability: async () => ({ available: false, reason: "origin is unreachable" }),
  });
  try {
    await registerWork(t, "waits for the registry");
    await t.clock.advance(HOUR); // 1回目の poll: 質問がまだ無いので観測は走り、質問が立つ
    const first = (await api(t.baseUrl, "GET", "/api/pause")).json.throttle.observedAt;
    expect(first).not.toBeNull();

    await t.clock.advance(HOUR); // 2回目の poll: 質問が開いているので手前で止まる
    expect((await api(t.baseUrl, "GET", "/api/pause")).json.throttle.observedAt).toBe(first);
  } finally {
    await t.stop();
  }
});
