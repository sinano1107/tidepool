import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { openQuarantineValues } from "../src/quarantine.js";
import { loadRegistry, refreshRegistry } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import type { ServerOptions } from "../src/server.js";
import { buildServerOptions, implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { listBoard, registerTask, type Task } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import { composition } from "./board-composition.js";
import { FakeClock, fakeContainers, healthyUsageText, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { HUMAN_WEBUI } from "./harness.js";
import { breakRegistry, makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

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
    `---\ndescription: Definition merged on remote\nversion: 0.4.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\n---\nRemote definition.\n`,
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
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    // GitHub 身元なしの盤面(ローカルの bare remote なので認証は要らない)
    registryAvailability: async () => refreshRegistry(registryDir, undefined),
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
    ...HUMAN_WEBUI,
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
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    registryAvailability: async () => ({
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
    ...HUMAN_WEBUI,
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
    ...HUMAN_WEBUI,
  );

  await clock.advance(HOURLY * 3);

  const questions = listBoard(db).filter((task) => task.type === "question");
  expect({ started: worker.started, questionTitles: questions.map((task) => task.title) }).toEqual({
    started: [],
    questionTitles: ["registry is unavailable — pickup and landing are stopped"],
  });
  // ADR 0093 決定7: user token の失効はまずここに出るので、再ログインのコマンドを名指しする
  expect(questions[0]?.purpose).toContain("npm run github-login");
  scheduler.stop();
});

/** registry が読めなくなった purely-local の盤面と、合成 root が組んだ読み口で動く scheduler。 */
async function brokenLocalRegistryBoard(readers: (options: ServerOptions) => Partial<Parameters<typeof startScheduler>[0]>) {
  const registryDir = await makeRegistry();
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const options = await buildServerOptions({ ...composition(), clock, registryDir, workspaceName: "tidepool", defaultAgentName: "deckhand" }, db);
  breakRegistry(registryDir);
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
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    ...readers(options),
  });
  registerTask(
    db,
    { type: "work", title: "queued while the registry is broken", purpose: "waits for the registry", completion_criteria: "runs after repair" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  return { db, clock, worker, scheduler };
}

// ADR 0403 決定5: 判定は remote の到達に「読み込みと検査が通るか」を足し、registry を持つ盤面すべてに置く
it("remote の無い盤面で registry を壊すと、pickup の門が止まり registryUnreadable が1枚立つ", async () => {
  const { db, clock, worker, scheduler } = await brokenLocalRegistryBoard((options) => ({ registryAvailability: options.registryAvailability }));

  await clock.advance(HOURLY * 2);

  expect({ started: worker.started, stops: openQuarantineValues(db, "registryUnreadable") }).toEqual({ started: [], stops: [null] });
  scheduler.stop();
});

it("remote に届いても、remote の main の registry が読めなければ、pickup の門が止まり registryUnreadable が1枚立つ", async () => {
  const { registryDir, publish } = await makeRemoteBackedRegistry();
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const options = await buildServerOptions({ ...composition(), clock, registryDir, registryMode: "remote-backed", workspaceName: "tidepool", defaultAgentName: "deckhand" }, db);
  publish("workspaces.yaml", "tidepool: [unclosed\n", "break workspaces.yaml on remote main");
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
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    registryAvailability: options.registryAvailability,
  });
  registerTask(db, { type: "work", title: "queued behind a broken remote registry", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);

  await clock.advance(HOURLY * 2);

  expect({ started: worker.started, stops: openQuarantineValues(db, "registryUnreadable") }).toEqual({ started: [], stops: [null] });
  scheduler.stop();
});

// ADR 0403 決定5: 重複を避ける判定は poll の catch —— 開いていれば ADR 0294 の行にも計測にも数えない
it("todo の候補を読む poll が registry の読み込みで投げても、registryUnreadable が開いていれば poll の失敗の行にも計測にも数えない", async () => {
  const { db, clock, worker, scheduler } = await brokenLocalRegistryBoard((options) => ({
    registryAvailability: options.registryAvailability,
    taskExecutionCandidates: options.taskExecutionCandidates,
  }));

  await clock.advance(HOURLY * 3);

  expect({
    started: worker.started,
    lastPollFailure: scheduler.lastPollFailure(),
    pollFailures: openQuarantineValues(db, "pollFailure"),
    stops: openQuarantineValues(db, "registryUnreadable"),
  }).toEqual({ started: [], lastPollFailure: undefined, pollFailures: [], stops: [null] });
  scheduler.stop();
});
