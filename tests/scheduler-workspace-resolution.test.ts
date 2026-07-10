import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { startScheduler, HOURLY } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { registerTask } from "../src/tasks.js";
import { UnknownWorkspaceError, workspaceNeedsHuman, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, ScriptedWorker } from "./fakes.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir },
  )
    .toString()
    .trim();
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeWorkspace(name: string): Promise<WorkspaceConfig> {
  const path = await mkdtemp(join(tmpdir(), `tidepool-${name}-`));
  dirs.push(path);
  git(path, "init", "-b", "main");
  git(
    path,
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  return { name, path };
}

describe("scheduler の pickup が task.workspace を解決する", () => {
  it("task.workspace が盤面既定と異なる workspace を指すとき、そのタスク自身の checkout でブランチが作られる", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
    const registry: Record<string, WorkspaceConfig> = { sandbox, prod };
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const worker = new ScriptedWorker();
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
    const sandbox = await makeWorkspace("sandbox");
    const registry: Record<string, WorkspaceConfig> = { sandbox };
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const worker = new ScriptedWorker();
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
});
