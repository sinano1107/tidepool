import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { getTask, registerTask } from "../src/tasks.js";
import { queueReturnHandler } from "../src/watchdog.js";
import { holdsBaseline, mergeTaskToProtected, openInterviewRoom, quarantineWorkspace, recordTaskCheckoutTip, releaseWorkspace, UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { commitWork, defaultingTo, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, leaveBaseline, makeWorkspace, pickUpInterviewRoot, prepareAtPickup, quarantineQuestion } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// registry の名前の最初の撮りの前に、基準の行を持つ workspace を全部確かめる(ADR 0373 決定13、spec #3273 pin B16・B22)

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-16T00:00:00.000Z");
let db: Db;
afterEach(() => db?.close());

function work(title: string, workspace?: string) {
  return registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done", workspace }, NOW, ...HUMAN_WEBUI);
}

/** 盤面が1度拾って休止位置へ戻した `name` の checkout —— 基準の行がある。 */
async function rested(name: string): Promise<WorkspaceConfig> {
  const ws = await makeWorkspace(name);
  await leaveBaseline(db, ws);
  return ws;
}

it("workspaces.yaml の手編集で改名した名前の最初の撮りは行を作らずに止まり、消えた名前の下に unknown workspace の Quarantine を立てる(spec #3273 text B9)", async () => {
  db = openDb(":memory:");
  const old = await rested("old");
  const renamed = { ...old, name: "new" };

  await expect(prepareAtPickup(db, renamed, work("comes for the new name", "new"), { resolveRegistered: defaultingTo(renamed) })).rejects.toThrow();

  expect(holdsBaseline(db, "new")).toBe(false);
  expect(quarantineQuestion(db, "workspace", "new")).toBeUndefined();
  expect(quarantineQuestion(db, "workspace", "old")!.purpose).toContain(
    'unknown workspace: old. The board holds a baseline for "old", so no workspace captures a first baseline until it resolves again: put the entry back in the registry under that name. To remove the workspace, delete it through the deletion door after this question is closed; to rename it, delete it and register it under the new name. Tasks in this workspace',
  );
});

it("面接室の最初の撮りは、workspace の行が基準と違っていても通る(ADR 0373 決定13)", async () => {
  db = openDb(":memory:");
  const broken = await rested("broken");
  commitWork(broken.path, "by-hand.txt", "committed while resting\n");
  const real = await makeWorkspace("real");
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: real.name, interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }, NOW, ...HUMAN_WEBUI);
  openInterviewRoom(db, root, await tempDir("first-capture-rooms-"), NOW);

  await pickUpInterviewRoot(db, root, real, { resolveRegistered: defaultingTo(broken, real) });

  expect(holdsBaseline(db, root.id)).toBe(true);
  expect(quarantineQuestion(db, "workspace", "broken")).toBeUndefined();
});

it("消えた名前を同じ path で戻しても、ref が動いていればその名前の違反で止まり、新しい名前は撮らない(ADR 0373 決定13)", async () => {
  db = openDb(":memory:");
  const old = await rested("old");
  const renamed = { ...old, name: "new" };
  commitWork(old.path, "by-hand.txt", "committed while resting\n");
  const moved = git(old.path, "rev-parse", "main");

  await expect(prepareAtPickup(db, renamed, work("comes for the new name", "new"), { resolveRegistered: defaultingTo(renamed, old) })).rejects.toThrow();

  expect(holdsBaseline(db, "new")).toBe(false);
  expect(quarantineQuestion(db, "workspace", "new")).toBeUndefined();
  expect(quarantineQuestion(db, "workspace", "old")!.purpose).toContain(`now: ${moved} refs/heads/main`);
});

it("消えた名前を別の path で戻すと、その場所の ref が基準と違えばその名前で止まり、同じ ref の別の path なら最初の撮りは通る(ADR 0373 決定13)", async () => {
  db = openDb(":memory:");
  const old = await rested("old");
  const elsewhere = { ...(await makeWorkspace("old-elsewhere")), name: "old" };
  const fresh = await makeWorkspace("fresh");

  await expect(prepareAtPickup(db, fresh, work("comes while old points elsewhere", "fresh"), { resolveRegistered: defaultingTo(fresh, elsewhere) })).rejects.toThrow();
  expect(quarantineQuestion(db, "workspace", "old")!.purpose).toContain("refs changed");
  expect(holdsBaseline(db, "fresh")).toBe(false);

  const copied = { ...old, path: await tempDir("old-copied-") };
  cpSync(old.path, copied.path, { recursive: true });
  await prepareAtPickup(db, fresh, work("comes once old points at a copy with the same refs", "fresh"), { resolveRegistered: defaultingTo(fresh, copied) });
  expect(holdsBaseline(db, "fresh")).toBe(true);
  expect(quarantineQuestion(db, "workspace", "fresh")).toBeUndefined();
});

it("registry の無い盤面では引けない名前を数えず、最初の撮りは通る(spec #3273 pin B22)", async () => {
  db = openDb(":memory:");
  await rested("vanished");
  const fresh = await makeWorkspace("fresh");

  await prepareAtPickup(db, fresh, work("comes without a registry", "fresh"));

  expect(holdsBaseline(db, "fresh")).toBe(true);
  expect(quarantineQuestion(db, "workspace", "vanished")).toBeUndefined();
});

it("止まった最初の撮りは新しい名前の sparse の pin を書かず、通った撮りがその時の checkout の sparse の規則を pin する(spec #3273 pin B22)", async () => {
  db = openDb(":memory:");
  const old = await rested("old");
  const renamed = { ...old, name: "new" };
  await expect(prepareAtPickup(db, renamed, work("stopped", "new"), { resolveRegistered: defaultingTo(renamed) })).rejects.toThrow();
  git(old.path, "sparse-checkout", "set", "--no-cone", "/*", "!/README.md");
  const task = work("passes once old is back", "new");
  const place = await prepareAtPickup(db, renamed, task, { resolveRegistered: defaultingTo(renamed, old) });
  commitWork(place.path, "README.md", "changed on the task branch\n");
  recordTaskCheckoutTip(db, place, task.id);

  // pin は名前の場所の checkout 済みの branch を盤面が進めるときに効く(ADR 0356 決定5)—— 規則の外の path は作業ツリーに出ない
  mergeTaskToProtected(db, renamed, task.id);

  expect(git(renamed.path, "show", "main:README.md")).toBe("changed on the task branch");
  expect(existsSync(join(renamed.path, "README.md"))).toBe(false);
});

/** scheduler の盤面。`registry` に載っている名前だけが引け、載っていない名前は registry drift(`UnknownWorkspaceError`)。
 *  `unreadable` を立てると、名前を引く口が registry を読めずに投げる —— 既定の名前(`fallback`)だけは引ける。 */
async function board(fallback: WorkspaceConfig, registry: WorkspaceConfig[]) {
  const state = { unreadable: false };
  const resolveWorkspace = (name: string | null) => {
    const found = registry.find((entry) => entry.name === (name ?? fallback.name));
    if (state.unreadable && found !== fallback) throw new Error("workspaces.yaml could not be parsed");
    if (!found) throw new UnknownWorkspaceError(name ?? fallback.name);
    return found;
  };
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const slot = new Slot();
  const containers = fakeContainers();
  const workspacesDir = await tempDir("first-capture-checkouts-");
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    // 収束は macrotask を1つ挟む —— 戻った task を同じ停止が拾い直す輪があれば、時間切れで赤くなる
    converge: () => new Promise((resolve) => setImmediate(() => resolve([]))),
    db,
    clock,
    slot,
    worker,
    containers,
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: queueReturnHandler({ db, clock, slot, resolve: resolveWorkspace, pollNow: () => scheduler.pollNow() }, containers, { defaultWorkspaceName: fallback.name }),
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    workspacesDir,
    workspace: fallback,
    resolveWorkspace,
  });
  onTestFinished(() => scheduler.stop());
  return { state, resolveWorkspace, clock, worker, scheduler, workspacesDir };
}

/** 1回の poll の後、task の pickup の決着が刻まれ、同じ停止で拾い直す輪が無いことを見届ける。 */
async function afterOnePoll(b: Awaited<ReturnType<typeof board>>, taskId: string, settled: string) {
  await b.clock.advance(HOURLY);
  await vi.waitFor(() => expect(listEvents(db, taskId).map((e) => e.kind)).toContain(settled));
  await new Promise((resolve) => setTimeout(resolve, 200));
}

it("最初の撮りに来た task は落ちた workspace の Quarantine の停止で待ち、その受理の後に走る(spec #3273 pin B16)", async () => {
  db = openDb(":memory:");
  const old = await rested("old");
  const renamed = { ...old, name: "new" };
  const registry = [renamed];
  const b = await board(renamed, registry);
  const task = work("comes for the new name", "new");

  await afterOnePoll(b, task.id, "pickup_stopped");

  expect(listEvents(db, task.id).filter((e) => e.kind === "pickup_stopped").map((e) => e.payload)).toEqual([
    { kind: "pickup_stopped", quarantine: "workspace", value: "old", reason: expect.stringContaining("unknown workspace: old") },
  ]);
  expect(listEvents(db, task.id).map((e) => e.kind)).not.toContain("spawn_failed");
  expect(getTask(db, task.id)!.status).toBe("todo");
  expect(b.worker.started).toEqual([]);

  registry.push(old);
  const question = quarantineQuestion(db, "workspace", "old")!;
  await submitAnswer({ db, pollNow: () => b.scheduler.pollNow(), landing: unusedLanding, quarantineChecks: quarantineChecks({ db, workspace: renamed, resolveWorkspace: b.resolveWorkspace, workspacesDir: b.workspacesDir }) }, question, ["repaired by hand"], undefined, () => b.clock.now(), "webui");

  await vi.waitFor(() => expect(b.worker.started.map((t) => t.id)).toEqual([task.id]));
});

it("確認の中で registry が読めなければ、task 自身の registry の読みの失敗と同じく走らなかった pickup の失敗になり、どの名前にも Quarantine を立てない(ADR 0373 決定13)", async () => {
  db = openDb(":memory:");
  const old = await rested("old");
  const fresh = await makeWorkspace("fresh");
  const b = await board(fresh, [fresh, old]);
  b.state.unreadable = true;
  const task = work("comes for a fresh name", "fresh");

  await afterOnePoll(b, task.id, "spawn_failed");

  expect(listEvents(db, task.id).find((e) => e.kind === "spawn_failed")!.payload).toMatchObject({ message: expect.stringContaining("workspaces.yaml could not be parsed") });
  expect(listEvents(db, task.id).map((e) => e.kind)).not.toContain("pickup_stopped");
  expect(quarantineQuestion(db, "workspace", "fresh")).toBeUndefined();
  expect(quarantineQuestion(db, "workspace", "old")).toBeUndefined();
  expect(holdsBaseline(db, "fresh")).toBe(false);
});

/** 実環境 `real` を読む Interview の root。面接室は開いてある。 */
function interviewRoot(real: WorkspaceConfig, base: string) {
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: real.name, interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }, NOW, ...HUMAN_WEBUI);
  openInterviewRoom(db, root, base, NOW);
  return root;
}

it("Interview の root が読む実環境の最初の撮りも確認に掛かり、消えた名前の下にだけ Quarantine を立て、root はその停止で待つ(ADR 0373 決定13)", async () => {
  db = openDb(":memory:");
  await rested("old");
  const real = await makeWorkspace("real");
  const b = await board(real, [real]);
  const root = interviewRoot(real, b.workspacesDir);

  await afterOnePoll(b, root.id, "pickup_stopped");

  expect(listEvents(db, root.id).filter((e) => e.kind === "pickup_stopped").map((e) => e.payload)).toEqual([
    { kind: "pickup_stopped", quarantine: "workspace", value: "old", reason: expect.stringContaining("unknown workspace: old") },
  ]);
  expect(quarantineQuestion(db, "workspace", "real")).toBeUndefined();
  expect(quarantineQuestion(db, "workspace", root.id)).toBeUndefined();
  expect(holdsBaseline(db, "real")).toBe(false);
  expect(getTask(db, root.id)!.status).toBe("todo");
  expect(b.worker.started).toEqual([]);
});

it("面接室の停止は、まだ撮っていない workspace の task を止めない(ADR 0373 決定13: 面接室の行は確かめも守りもしない)", async () => {
  db = openDb(":memory:");
  const real = await makeWorkspace("real");
  const fresh = await makeWorkspace("fresh");
  const b = await board(fresh, [fresh, real]);
  const root = interviewRoot(real, b.workspacesDir);
  const { place } = await pickUpInterviewRoot(db, root, real);
  releaseWorkspace(db, place, root, NOW);
  quarantineWorkspace(db, root.id, "the room needs attention", NOW);
  const task = work("comes for a fresh name", "fresh");

  await b.clock.advance(HOURLY);

  await vi.waitFor(() => expect(b.worker.started.map((t) => t.id)).toEqual([task.id]));
  expect(holdsBaseline(db, "fresh")).toBe(true);
});
