import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { registerTask } from "../src/tasks.js";
import { UnknownWorkspaceError, type WorkspaceConfig, workspaceNeedsHuman } from "../src/workspace.js";
import { FakeClock, ScriptedWorker } from "./fakes.js";
import { git, makeWorkspace } from "./harness.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("scheduler の pickup が task.workspace を解決する", () => {
  it("task.workspace が盤面既定と異なる workspace を指すとき、そのタスク自身の checkout でブランチが作られる", async () => {
    const sandbox = await makeWorkspace(dirs, "sandbox");
    const prod = await makeWorkspace(dirs, "prod");
    const registry: Record<string, WorkspaceConfig> = { sandbox, prod };
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const worker = new ScriptedWorker(clock);
    const slot = new Slot();
    const scheduler = startScheduler({
      db,
      clock,
      slot,
      worker,
      workspace: sandbox,
      resolveWorkspace: (name) => {
        const ws = registry[name ?? "sandbox"];
        if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
        return ws;
      },
    });

    const task = registerTask(
      db,
      { type: "work", title: "prod work", purpose: "p", completion_criteria: "c", workspace: "prod" },
      clock.now(),
    );
    await clock.advance(HOURLY);

    expect(worker.started.map((t) => t.id)).toEqual([task.id]);
    expect(git(prod.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
    // the board's default (sandbox) checkout is untouched
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

    scheduler.stop();
  });

  it("registry に存在しない workspace 名は quarantine され、worker には渡らない", async () => {
    const sandbox = await makeWorkspace(dirs, "sandbox");
    const registry: Record<string, WorkspaceConfig> = { sandbox };
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const worker = new ScriptedWorker(clock);
    const slot = new Slot();
    const scheduler = startScheduler({
      db,
      clock,
      slot,
      worker,
      workspace: sandbox,
      resolveWorkspace: (name) => {
        const ws = registry[name ?? "sandbox"];
        if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
        return ws;
      },
    });

    registerTask(
      db,
      { type: "work", title: "drifted", purpose: "p", completion_criteria: "c", workspace: "ghost" },
      clock.now(),
    );
    await clock.advance(HOURLY);

    expect(worker.started).toEqual([]);
    expect(workspaceNeedsHuman(db, "ghost")).toBe(true);

    scheduler.stop();
  });

  it("workspace の branch がその checkout に存在しないとき、pickup 時に workspace が quarantine され、worker には渡らない(issue #27)", async () => {
    const prod = await makeWorkspace(dirs, "prod");
    const registry: Record<string, WorkspaceConfig> = {
      prod: { ...prod, branch: "no-such-branch" },
    };
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const worker = new ScriptedWorker(clock);
    const slot = new Slot();
    const scheduler = startScheduler({
      db,
      clock,
      slot,
      worker,
      workspace: prod,
      resolveWorkspace: (name) => {
        const ws = registry[name ?? "prod"];
        if (!ws) throw new UnknownWorkspaceError(name ?? "prod");
        return ws;
      },
    });

    registerTask(
      db,
      { type: "work", title: "dangling branch", purpose: "p", completion_criteria: "c", workspace: "prod" },
      clock.now(),
    );
    await clock.advance(HOURLY);

    expect(worker.started).toEqual([]);
    expect(workspaceNeedsHuman(db, "prod")).toBe(true);

    scheduler.stop();
  });
});
