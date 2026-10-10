import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { startServer, type TidepoolServer } from "../src/server.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { answerQuestion, getTask, listBoard, pickupTask, registerTask } from "../src/tasks.js";
import { TranscriptStore } from "../src/transcript-store.js";
import { failTask } from "../src/watchdog.js";
import { ensureTaskBranch } from "../src/workspace.js";
import { FakeClock, FakeContainerRuntime, fakeContainers, noRetrospectiveCalls, pinnedCliVersions, ScriptedWorker } from "./fakes.js";
import { defaultingTo, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, TEST_CREDENTIAL } from "./harness.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let server: TidepoolServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

// ADR 0233: 既定への参照は pickup で終わる —— retry の再 pickup も最初の pickup で解決した先に従う
it("既定 workspace a・既定 agent a で pickup したタスクは、再起動の中断を retry すると、既定を b に差し替えた scheduler でも a・a のまま再 pickup され、a の既存のタスクブランチを checkout する", async () => {
  const a = await makeWorkspace("retry-pinned-a");
  const b = await makeWorkspace("retry-pinned-b");
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const schedulerOf = (workspace: typeof a, other: typeof a, worker: ScriptedWorker) =>
    startScheduler({
      retrospectiveCalls: noRetrospectiveCalls,
      db,
      clock,
      slot: new Slot(),
      worker,
      containers: fakeContainers(),
      onSpawnFailed: () => {},
      taskExecutionCandidates: implicitTaskExecutionCandidates(db),
      workspace,
      resolveWorkspace: defaultingTo(workspace, other),
    });
  const first = schedulerOf(a, b, new ScriptedWorker(clock, "a"));
  const task = registerTask(db, { type: "work", title: "unspecified work", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);
  await clock.advance(HOURLY);
  writeFileSync(join(a.path, "stuck.txt"), "interrupted mid-write\n");
  first.stop();

  // 再起動の中断(server.ts の起動時の failTask)は、差し替えた既定 b の resolver で走る
  failTask(db, getTask(db, task.id)!, "restart interrupted task", "the server restarted", defaultingTo(b, a), clock.now());
  const failure = listBoard(db).find((x) => x.type === "question" && x.parent_id === task.id)!;
  answerQuestion(db, getTask(db, failure.id)!, ["retry"], clock.now(), undefined, undefined, undefined, "webui");
  const worker = new ScriptedWorker(clock, "b");
  const second = schedulerOf(b, a, worker);
  await clock.advance(HOURLY);

  expect(worker.started.map(({ id, workspace, assignee }) => ({ id, workspace, assignee }))).toEqual([
    { id: task.id, workspace: a.name, assignee: "a" },
  ]);
  expect(git(a.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  expect(git(a.path, "log", "--format=%s", "HEAD")).toContain(`WIP: task ${task.id}`);
  expect(git(b.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(b.path, "branch", "--list", `task/${task.id}`)).toBe("");
  second.stop();
});

describe("restart 割り込みの failTask が task.workspace を解決する", () => {
  it("再起動時に in_progress のまま残ったタスクは、自身の workspace の checkout で tree rule を実行する", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
    const boardDir = await tempDir("tidepool-board-");
    const dbPath = join(boardDir, "board.sqlite");

    // simulate a restart-interrupted task: in_progress, its task branch
    // already checked out on prod, uncommitted work left mid-flight
    const seedDb = openDb(dbPath);
    const clock0 = new FakeClock();
    const task = registerTask(
      seedDb,
      { type: "work", title: "prod work", purpose: "p", completion_criteria: "c", workspace: "prod" },
      clock0.now(),
      ...HUMAN_WEBUI,
    );
    const picked = pickupTask(seedDb, task, "deckhand", clock0.now())!;
    ensureTaskBranch(seedDb, prod, picked);
    await import("node:fs").then((fs) =>
      fs.writeFileSync(join(prod.path, "stuck.txt"), "interrupted mid-write\n"),
    );
    seedDb.close();

    const bootClock = new FakeClock();
    const db = openDb(dbPath);
    server = await startServer({
      db,
      taskExecutionCandidates: implicitTaskExecutionCandidates(db),
      port: 0,
      mcpPort: 0,
      clock: bootClock,
      // issue #153: 人間面の credential は省略できない(このテストは HTTP を
      // 叩かないが、盤面が無認証で立つ口は塞いである)
      credential: TEST_CREDENTIAL,
      worker: () => new ScriptedWorker(bootClock),
      containerRuntime: new FakeContainerRuntime(),
      transcripts: new TranscriptStore(boardDir),
      checkHarnessCliVersion: pinnedCliVersions,
      workspace: sandbox,
      resolveWorkspace: defaultingTo(sandbox, prod),
    });

    expect(git(prod.path, "status", "--porcelain")).toBe("");
    expect(git(prod.path, "log", "--format=%s", `task/${task.id}`)).toContain(
      `WIP: task ${task.id}`,
    );
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
