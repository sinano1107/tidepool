import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, getTask, registerTask } from "../src/tasks.js";
import { queueReturnHandler } from "../src/watchdog.js";
import { holdsBaseline, openInterviewRoom, releaseWorkspace, UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { commitWork, defaultingTo, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, pickUpInterviewRoot, prepareAtPickup, quarantineQuestion } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// registry の名前の最初の撮りの前に、基準の行を持つ workspace を全部確かめる(ADR 0373 決定13、spec #3273 pin B16・B22)

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-16T00:00:00.000Z");
let db: Db;
afterEach(() => db?.close());

function work(title: string, workspace?: string) {
  return registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done", workspace }, NOW, ...HUMAN_WEBUI);
}

/** 盤面が1度拾って休止位置へ戻した `name` の checkout —— 基準の行がある。拾った task は取り消して候補に残さない。 */
async function rested(name: string): Promise<WorkspaceConfig> {
  const ws = await makeWorkspace(name);
  const task = work(`leaves a baseline for ${name}`, name);
  releaseWorkspace(db, await prepareAtPickup(db, ws, task), task, NOW);
  cancelTaskDirectly(db, task, null, NOW, {}, "webui");
  return ws;
}

/** sparse の pin。読む公開の口は無い —— 直に読む。 */
function sparsePin(name: string): unknown {
  const row = db.prepare("SELECT policy FROM workspace_sparse_policies WHERE name = ?").pluck().get(name) as string | undefined;
  return row === undefined ? undefined : JSON.parse(row);
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

it("registry が読めない失敗は引けない名前に数えず、Quarantine を立てずに撮らない(ADR 0373 決定13)", async () => {
  db = openDb(":memory:");
  const old = await rested("old");
  const fresh = await makeWorkspace("fresh");
  const unreadable = (name: string | null) => {
    if (name === "fresh") return fresh;
    throw new Error("workspaces.yaml could not be parsed");
  };

  await expect(prepareAtPickup(db, fresh, work("comes for a fresh name", "fresh"), { resolveRegistered: unreadable })).rejects.toThrow("workspaces.yaml could not be parsed");

  expect(holdsBaseline(db, "fresh")).toBe(false);
  expect(quarantineQuestion(db, "workspace", old.name)).toBeUndefined();
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

it("消えた名前を別の path で戻すと、その場所が基準と違えばその名前で止まり、同じなら最初の撮りは通る(ADR 0373 決定13)", async () => {
  db = openDb(":memory:");
  const old = await rested("old");
  const elsewhere = { ...(await makeWorkspace("old-elsewhere")), name: "old" };
  const fresh = await makeWorkspace("fresh");

  await expect(prepareAtPickup(db, fresh, work("comes while old points elsewhere", "fresh"), { resolveRegistered: defaultingTo(fresh, elsewhere) })).rejects.toThrow();
  expect(quarantineQuestion(db, "workspace", "old")!.purpose).toContain("refs changed");
  expect(holdsBaseline(db, "fresh")).toBe(false);

  await prepareAtPickup(db, fresh, work("comes once old is back", "fresh"), { resolveRegistered: defaultingTo(fresh, old) });
  expect(holdsBaseline(db, "fresh")).toBe(true);
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
  expect(sparsePin("new")).toBeUndefined();
  git(old.path, "sparse-checkout", "set", "--no-cone", "/*", "!/README.md");

  await prepareAtPickup(db, renamed, work("passes once old is back", "new"), { resolveRegistered: defaultingTo(renamed, old) });

  expect(sparsePin("new")).toEqual({ pattern: "/*\n!/README.md\n", cone: false });
});

it("最初の撮りに来た task は落ちた workspace の Quarantine の停止で待ち、その受理の後に走る(spec #3273 pin B16)", async () => {
  db = openDb(":memory:");
  const old = await rested("old");
  const renamed = { ...old, name: "new" };
  const registry = [renamed];
  const resolveWorkspace = (name: string | null) => {
    const found = registry.find((entry) => entry.name === (name ?? renamed.name));
    if (!found) throw new UnknownWorkspaceError(name ?? renamed.name);
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
    onPickupStopped: queueReturnHandler({ db, clock, slot, resolve: resolveWorkspace, pollNow: () => scheduler.pollNow() }, containers, { defaultWorkspaceName: renamed.name }),
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    workspacesDir,
    workspace: renamed,
    resolveWorkspace,
  });
  const task = work("comes for the new name", "new");

  await clock.advance(HOURLY);
  await vi.waitFor(() => expect(listEvents(db, task.id).map((e) => e.kind)).toContain("pickup_stopped"));
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(listEvents(db, task.id).filter((e) => e.kind === "pickup_stopped").map((e) => e.payload)).toEqual([
    { kind: "pickup_stopped", quarantine: "workspace", value: "old", reason: expect.stringContaining("unknown workspace: old") },
  ]);
  expect(listEvents(db, task.id).map((e) => e.kind)).not.toContain("spawn_failed");
  expect(getTask(db, task.id)!.status).toBe("todo");
  expect(worker.started).toEqual([]);

  registry.push(old);
  const question = quarantineQuestion(db, "workspace", "old")!;
  await submitAnswer({ db, pollNow: () => scheduler.pollNow(), landing: unusedLanding, quarantineChecks: quarantineChecks({ db, workspace: renamed, resolveWorkspace, workspacesDir }) }, question, ["repaired by hand"], undefined, () => clock.now(), "webui");

  await vi.waitFor(() => expect(worker.started.map((t) => t.id)).toEqual([task.id]));
  scheduler.stop();
});
