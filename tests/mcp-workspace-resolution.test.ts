import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createLanding } from "../src/landing.js";
import { createMcpRouter } from "../src/mcp.js";
import { Slot } from "../src/slot.js";
import { pickupTask, registerTask } from "../src/tasks.js";
import { ensureTaskBranch, UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import { commitWork, FULL_HANDOFF as fullHandoff, git, makeWorkspace } from "./harness.js";

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
    const picked = pickupTask(db, task, "deckhand", clock.now());
    slot.occupy(task.id);
    // as the scheduler's pickup() would have done: the task branch is
    // already checked out on prod, not sandbox, by the time the worker runs
    ensureTaskBranch(db, prod, picked);
    const resolveWorkspace = (name: string | null) => {
      const ws = registry[name ?? "sandbox"];
      if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
      return ws;
    };

    const app = express();
    app.use(
      "/mcp",
      createMcpRouter({
        db,
        slot,
        clock,
        landing: createLanding({ db, clock, workspace: sandbox, resolveWorkspace, github: null }),
        workspace: sandbox,
        resolveWorkspace,
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

    // dirty the prod checkout: the completion gate (ADR 0084) must read *prod*
    // — sandbox is clean, so a gate resolving the board default would let this
    // through
    await import("node:fs").then((fs) =>
      fs.writeFileSync(join(prod.path, "notes.txt"), "half-finished\n"),
    );
    const denied: any = await client.callTool({
      name: "complete_task",
      arguments: { handoff: fullHandoff },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("uncommitted changes");

    commitWork(prod.path, "notes.txt", "half-finished\n");
    const res: any = await client.callTool({
      name: "complete_task",
      arguments: { handoff: fullHandoff },
    });
    expect(res.isError ?? false).toBe(false);
    await client.close();
    await new Promise<void>((resolve, reject) =>
      listener.close((err) => (err ? reject(err) : resolve())),
    );

    // the release ran on prod's checkout, not sandbox's
    expect(git(prod.path, "status", "--porcelain")).toBe("");
    expect(git(prod.path, "show", `task/${task.id}:notes.txt`)).toBe("half-finished");
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
