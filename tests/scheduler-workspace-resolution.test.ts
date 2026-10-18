import { describe, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { getTask, listBoard, registerTask } from "../src/tasks.js";
import { queueReturnHandler } from "../src/watchdog.js";
import { type WorkspaceConfig, workspaceNeedsHuman } from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { defaultingTo, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** 資源の停止を本物の一撃(`queueReturnHandler`)で受ける盤面。後始末の pickup の契機は scheduler へ遅延束縛する(server.ts と同じ)。
 *  収束は macrotask を1つ挟む —— 戻った task を同じ停止が拾い直す輪があれば、worker を固めずに時間切れで赤くなる。 */
function stoppingBoard(workspace: WorkspaceConfig | undefined, resolveWorkspace: (name: string | null) => WorkspaceConfig) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const slot = new Slot();
  const containers = fakeContainers();
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: () => new Promise((resolve) => setImmediate(() => resolve([]))),
    db,
    clock,
    slot,
    worker,
    containers,
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: queueReturnHandler({ db, clock, slot, resolve: resolveWorkspace, pollNow: () => scheduler.pollNow() }, containers),
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    workspace,
    resolveWorkspace,
  });
  return { db, clock, worker, slot, scheduler };
}

/** 失敗にされずに先頭へ戻り、止めた資源を1件だけ刻んでいる(ADR 0274 決定1・2)。 */
function expectReturnedToHead(db: Db, taskId: string, stop: Record<string, unknown>): void {
  const returned = getTask(db, taskId)!;
  expect(returned.status).toBe("todo");
  expect(returned.sort_key).toBe(Math.min(...listBoard(db).map((t) => t.sort_key)));
  const events = listEvents(db, taskId);
  expect(events.filter((e) => e.kind === "pickup_stopped").map((e) => e.payload)).toEqual([{ kind: "pickup_stopped", ...stop }]);
  expect(events.map((e) => e.kind)).not.toContain("spawn_failed");
  expect(listBoard(db).filter((t) => t.type === "question" && t.parent_id === taskId)).toEqual([]);
}

describe("scheduler の pickup が task.workspace を解決する", () => {
  it("既定の workspace 名を持たない盤面で準備が落ちても、戻った task は修復まで同じ停止に拾い直されない(ADR 0274 決定1)", async () => {
    // 空の workspace 欄は resolver の既定に解決されるが、候補の除外の鍵は空のまま —— 鍵が揃わなくても止めた記録で外す
    const { db, clock, worker, slot, scheduler } = stoppingBoard(undefined, () => ({ name: "known-workspace", path: "/nonexistent/known" }));
    const task = registerTask(db, { type: "work", title: "unpreparable", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);

    await clock.advance(HOURLY);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(worker.started).toEqual([]);
    expect(listEvents(db, task.id).filter((e) => e.kind === "pickup_stopped")).toHaveLength(1);
    expect(getTask(db, task.id)?.status).toBe("todo");
    expect(slot.currentTaskId).toBeNull();
    scheduler.stop();
  });

  it("task.workspace が盤面既定と異なる workspace を指すとき、そのタスク自身の checkout でブランチが作られる", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const worker = new ScriptedWorker(clock);
    const slot = new Slot();
    const scheduler = startScheduler({
      retrospectiveCalls: noRetrospectiveCalls,
      converge: async () => [],
      db,
      clock,
      slot,
      worker,
      containers: fakeContainers(),
      onSpawnFailed: () => {},
      onRecordContainerFailed: () => {},
      onPickupStopped: () => {},
      taskExecutionCandidates: implicitTaskExecutionCandidates(db),
      workspace: sandbox,
      resolveWorkspace: defaultingTo(sandbox, prod),
    });

    const task = registerTask(
      db,
      { type: "work", title: "prod work", purpose: "p", completion_criteria: "c", workspace: "prod" },
      clock.now(),
      ...HUMAN_WEBUI,
    );
    await clock.advance(HOURLY);

    expect(worker.started.map((t) => t.id)).toEqual([task.id]);
    expect(git(prod.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
    // the board's default (sandbox) checkout is untouched
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

    scheduler.stop();
  });

  it("registry に存在しない workspace 名は quarantine され、worker には渡らず、拾った task は todo の先頭へ戻って枠が空き、tick を待たずに次の task が拾われる(ADR 0274)", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const { db, clock, worker, slot, scheduler } = stoppingBoard(sandbox, defaultingTo(sandbox));

    const drifted = registerTask(
      db,
      { type: "work", title: "drifted", purpose: "p", completion_criteria: "c", workspace: "ghost" },
      clock.now(),
      ...HUMAN_WEBUI,
    );
    const next = registerTask(db, { type: "work", title: "next in line", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);
    await clock.advance(HOURLY);
    await vi.waitFor(() => expect(worker.started.map((t) => t.id)).toEqual([next.id]));

    expect(workspaceNeedsHuman(db, "ghost")).toBe(true);
    expectReturnedToHead(db, drifted.id, { quarantine: "workspace", value: "ghost", reason: "unknown workspace: ghost" });
    expect(slot.currentTaskId).toBe(next.id);

    scheduler.stop();
  });

  it("workspace の branch がその checkout に存在しないとき、pickup 時に workspace が quarantine され、worker には渡らず、拾った task は todo の先頭へ戻って枠が空く(issue #27 / ADR 0274)", async () => {
    const prod = await makeWorkspace("prod");
    const sandbox = await makeWorkspace("sandbox");
    const { db, clock, worker, slot, scheduler } = stoppingBoard(sandbox, defaultingTo(sandbox, { ...prod, branch: "no-such-branch" }));

    const dangling = registerTask(
      db,
      { type: "work", title: "dangling branch", purpose: "p", completion_criteria: "c", workspace: "prod" },
      clock.now(),
      ...HUMAN_WEBUI,
    );
    const next = registerTask(db, { type: "work", title: "next in line", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);
    await clock.advance(HOURLY);
    await vi.waitFor(() => expect(worker.started.map((t) => t.id)).toEqual([next.id]));

    expect(workspaceNeedsHuman(db, "prod")).toBe(true);
    expectReturnedToHead(db, dangling.id, { quarantine: "workspace", value: "prod", reason: expect.stringContaining("no-such-branch") });
    expect(slot.currentTaskId).toBe(next.id);

    scheduler.stop();
  });
});
