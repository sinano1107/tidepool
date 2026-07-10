import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { openDb } from "../src/db.js";
import { createMcpRouter } from "../src/mcp.js";
import { Slot } from "../src/slot.js";
import { pickupTask, registerTask } from "../src/tasks.js";
import { ensureTaskBranch, UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import { FULL_HANDOFF as fullHandoff, git, makeWorkspace } from "./harness.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("mcp の releasing verb が task.workspace を解決する", () => {
  it("complete_task は task 自身の workspace の checkout で tree rule を実行する", async () => {
    const sandbox = await makeWorkspace(dirs, "sandbox");
    const prod = await makeWorkspace(dirs, "prod");
    const registry: Record<string, WorkspaceConfig> = { sandbox, prod };
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const slot = new Slot();

    const task = registerTask(
      db,
      { type: "work", title: "prod work", purpose: "p", completion_criteria: "c", workspace: "prod" },
      clock.now(),
    );
    pickupTask(db, task, "deckhand", clock.now());
    slot.occupy(task.id);
    // as the scheduler's pickup() would have done: the task branch is
    // already checked out on prod, not sandbox, by the time the worker runs
    ensureTaskBranch(prod, task.id);

    const app = express();
    app.use(
      "/mcp",
      createMcpRouter({
        db,
        slot,
        clock,
        workspace: sandbox,
        resolveWorkspace: (name) => {
          const ws = registry[name ?? "sandbox"];
          if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
          return ws;
        },
      }),
    );
    const listener = await new Promise<import("node:http").Server>((resolve) => {
      const l = app.listen(0, "127.0.0.1", () => resolve(l));
    });
    const port = (listener.address() as AddressInfo).port;

    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    url.searchParams.set("task", task.id);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));

    // dirty the prod checkout, exactly like the WorkerAdapter never committing
    await import("node:fs").then((fs) =>
      fs.writeFileSync(join(prod.path, "notes.txt"), "half-finished\n"),
    );
    const res: any = await client.callTool({
      name: "complete_task",
      arguments: { handoff: fullHandoff },
    });
    expect(res.isError ?? false).toBe(false);
    await client.close();
    await new Promise<void>((resolve, reject) =>
      listener.close((err) => (err ? reject(err) : resolve())),
    );

    // the WIP landed on prod's task branch, not sandbox's
    expect(git(prod.path, "status", "--porcelain")).toBe("");
    expect(git(prod.path, "log", "--format=%s", `task/${task.id}`)).toContain(
      `WIP: task ${task.id}`,
    );
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
