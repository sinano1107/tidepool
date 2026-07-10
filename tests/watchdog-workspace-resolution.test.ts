import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getTask, pickupTask, registerTask } from "../src/tasks.js";
import { failTask } from "../src/watchdog.js";
import { ensureTaskBranch, UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";

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
  git(path, "commit", "--allow-empty", "-m", "initial");
  return { name, path };
}

describe("watchdog の failTask が task.workspace を解決する", () => {
  it("失敗した task 自身の workspace の checkout で tree rule を実行する", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
    const registry: Record<string, WorkspaceConfig> = { sandbox, prod };
    const db = openDb(":memory:");
    const clock = new FakeClock();

    const task = registerTask(
      db,
      { type: "work", title: "prod work", purpose: "p", completion_criteria: "c", workspace: "prod" },
      clock.now(),
    );
    pickupTask(db, task, "deckhand", clock.now());
    ensureTaskBranch(prod, task.id);
    await import("node:fs").then((fs) =>
      fs.writeFileSync(join(prod.path, "stuck.txt"), "stuck work\n"),
    );

    failTask(
      db,
      getTask(db, task.id)!,
      "watchdog killed task",
      "hit its time limit",
      (name) => {
        const ws = registry[name ?? "sandbox"];
        if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
        return ws;
      },
      clock.now(),
    );

    expect(git(prod.path, "status", "--porcelain")).toBe("");
    expect(git(prod.path, "log", "--format=%s", `task/${task.id}`)).toContain(
      `WIP: task ${task.id}`,
    );
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
