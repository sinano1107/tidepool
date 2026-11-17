import { afterEach, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { quarantineChecks } from "../src/human-verbs.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { getTask, registerTask } from "../src/tasks.js";
import { queueReturnHandler } from "../src/watchdog.js";
import { holdsBaseline, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { bootTidepool, GIT_FIXTURE_TEST_TIMEOUT, git, HOUR, HUMAN_WEBUI, makeWorkspace, quarantineQuestion, registerWork, servedQuarantineQuestion, type Tidepool } from "./harness.js";
import { makeRegistry, registryCloneOverlap, registryFixedPoints } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-17T00:00:00.000Z");

let t: Tidepool | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

// ADR 0377 決定4: 起動の後に手編集で届いた entry は、最初の pickup が registry clone に何も書く前に拒む。同じ項を受理が撃ち、確認の一覧に並ぶ
it("an entry naming the registry clone that arrives after boot is refused at its first pickup with spec #3273 text E1, and the acceptance refuses it too", async ({ onTestFinished }) => {
  const registryDir = await makeRegistry();
  const workspace = { name: "registry", path: registryDir };
  const boardState = registryFixedPoints(registryDir);
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const task = registerTask(db, { type: "work", title: "edit the registry", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const slot = new Slot();
  const containers = fakeContainers();
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: async () => [],
    db, clock, slot, worker, containers,
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: queueReturnHandler({ db, clock, slot, resolve: () => workspace, pollNow: () => scheduler.pollNow() }, containers, { defaultWorkspaceName: workspace.name }),
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    workspace,
    resolveWorkspace: () => workspace,
    workspacesDir: await tempDir("tidepool-registry-clone-checkouts-"),
    boardState,
  });
  onTestFinished(() => scheduler.stop());

  await clock.advance(HOURLY);
  await vi.waitFor(() => expect(quarantineQuestion(db, "workspace", workspace.name)).toBeDefined());

  const purpose = quarantineQuestion(db, "workspace", workspace.name)!.purpose;
  expect(purpose).toContain(registryCloneOverlap(registryDir, registryDir));
  expect(purpose).toContain("overlaps none of the board's fixed points");
  expect(worker.started).toEqual([]);
  expect(getTask(db, task.id)).toMatchObject({ status: "todo" });
  expect(git(registryDir, "for-each-ref", "refs/heads/task/")).toBe("");
  expect(holdsBaseline(db, workspace.name)).toBe(false);

  await expect(quarantineChecks({ db, workspace, boardState }).workspace!(workspace.name, "repaired by hand")).rejects.toThrow(registryCloneOverlap(registryDir, registryDir));
});

// サーバー境界: 盤面の固定点が server から scheduler の pickup に届く(ADR 0041 の配線の形)
it("bootTidepool: an entry naming the registry clone that arrives after boot becomes the spec #3273 text E1 Quarantine at its pickup", async () => {
  const registryDir = await makeRegistry();
  const sandbox = await makeWorkspace("sandbox");
  const resolve = (name: string | null): WorkspaceConfig => (name === "registry" ? { name, path: registryDir } : sandbox);
  t = await bootTidepool({
    resolveWorkspace: resolve,
    // boot の一斉検査が見る列挙に registry の entry は無い —— 起動の後に届いた形
    boardState: { paths: registryFixedPoints(registryDir), listWorkspaces: () => [sandbox] },
  });

  await registerWork(t, "edit the registry", "registry");
  await t.clock.advance(HOUR);

  expect((await servedQuarantineQuestion(t, "workspace", "registry"))?.purpose).toContain(registryCloneOverlap(registryDir, registryDir));
  expect(t.worker.started).toEqual([]);
});
