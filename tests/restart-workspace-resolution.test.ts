import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { startServer, type TidepoolServer } from "../src/server.js";
import { pickupTask, registerTask } from "../src/tasks.js";
import { ensureTaskBranch, UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, ScriptedWorker } from "./fakes.js";
import { git, makeWorkspace } from "./harness.js";

const dirs: string[] = [];
let server: TidepoolServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("restart 割り込みの failTask が task.workspace を解決する", () => {
  it("再起動時に in_progress のまま残ったタスクは、自身の workspace の checkout で tree rule を実行する", async () => {
    const sandbox = await makeWorkspace(dirs, "sandbox");
    const prod = await makeWorkspace(dirs, "prod");
    const registry: Record<string, WorkspaceConfig> = { sandbox, prod };
    const boardDir = await mkdtemp(join(tmpdir(), "tidepool-board-"));
    dirs.push(boardDir);
    const dbPath = join(boardDir, "board.sqlite");

    // simulate a restart-interrupted task: in_progress, its task branch
    // already checked out on prod, uncommitted work left mid-flight
    const seedDb = openDb(dbPath);
    const clock0 = new FakeClock();
    const task = registerTask(
      seedDb,
      { type: "work", title: "prod work", purpose: "p", completion_criteria: "c", workspace: "prod" },
      clock0.now(),
    );
    pickupTask(seedDb, task, "deckhand", clock0.now());
    ensureTaskBranch(prod, task.id);
    await import("node:fs").then((fs) =>
      fs.writeFileSync(join(prod.path, "stuck.txt"), "interrupted mid-write\n"),
    );
    seedDb.close();

    const bootClock = new FakeClock();
    server = await startServer({
      dbPath,
      port: 0,
      mcpPort: 0,
      clock: bootClock,
      worker: () => new ScriptedWorker(bootClock),
      workspace: sandbox,
      resolveWorkspace: (name) => {
        const ws = registry[name ?? "sandbox"];
        if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
        return ws;
      },
    });

    expect(git(prod.path, "status", "--porcelain")).toBe("");
    expect(git(prod.path, "log", "--format=%s", `task/${task.id}`)).toContain(
      `WIP: task ${task.id}`,
    );
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
