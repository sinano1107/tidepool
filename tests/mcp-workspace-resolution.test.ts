import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { createMcpRouter } from "../src/mcp.js";
import { Slot } from "../src/slot.js";
import { getTask, pickupTask, registerTask } from "../src/tasks.js";
import type { WorkspaceConfig } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import { commitWork, defaultingTo, FULL_HANDOFF as fullHandoff, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, prepareAtPickup, sessionId } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** `prod` の work を pickup の準備まで済ませ(task の checkout が開く)、その task として MCP に繋いだ client。 */
async function connectedWork(sandbox: WorkspaceConfig, prod: WorkspaceConfig) {
  const db: Db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const task = registerTask(
    db,
    { type: "work", title: "prod work", purpose: "p", completion_criteria: "c", workspace: "prod" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  const picked = pickupTask(db, task, "deckhand", clock.now())!;
  slot.occupy(task.id, sessionId(db, task.id));
  // as the scheduler's pickup() would have done: the task checkout is opened
  // from prod, not sandbox, by the time the worker runs
  const place = await prepareAtPickup(db, prod, picked);
  const app = express();
  app.use(
    "/mcp",
    createMcpRouter({ defaultAgentName: "tako", db, slot, clock, workspace: sandbox, resolveWorkspace: defaultingTo(sandbox, prod), pollNow: () => {} }),
  );
  const listener = await new Promise<import("node:http").Server>((resolve) => {
    const l = app.listen(0, "127.0.0.1", () => resolve(l));
  });
  const url = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
  url.searchParams.set("task", task.id);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  onTestFinished(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => listener.close((err) => (err ? reject(err) : resolve())));
  });
  const complete = (): Promise<any> => client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  return { db, task, place, complete };
}

describe("mcp の releasing verb が task.workspace を解決する", () => {
  it("complete_task は task 自身の workspace から開いた task の checkout を完了の門で読み、そこから tree rule を実行する", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
    const { task, place, complete } = await connectedWork(sandbox, prod);

    // dirty the task checkout: the completion gate (ADR 0084) must read *prod's*
    // task checkout — sandbox is clean, so a gate resolving the board default would let this through
    git(place.path, "update-index", "--assume-unchanged", "--", "README.md");
    writeFileSync(join(place.path, "README.md"), "tracked edit\n");
    mkdirSync(join(place.path, ".git", "info"), { recursive: true });
    writeFileSync(join(place.path, ".git", "info", "exclude"), "notes.txt\n");
    writeFileSync(join(place.path, "notes.txt"), "half-finished\n");
    expect(git(place.path, "status", "--porcelain")).toBe("");
    const denied = await complete();
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("with a message whose body says what changed and why in a few lines, readable from the git history alone, then call complete_task again");
    expect(denied.content[0].text).toContain("\n- README.md");
    expect(denied.content[0].text).toContain("\n- notes.txt");

    git(place.path, "update-index", "--no-assume-unchanged", "--", "README.md");
    git(place.path, "add", "README.md");
    writeFileSync(join(place.path, ".git", "info", "exclude"), "");
    commitWork(place.path, "notes.txt", "half-finished\n");
    const res = await complete();
    expect(res.isError ?? false).toBe(false);

    // the completion gate brought the worker's tip to prod before done (ADR 0356 決定3)
    expect(git(prod.path, "show", `task/${task.id}:notes.txt`)).toBe("half-finished");
    expect(git(prod.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("complete_task は worker のタスクブランチを名前の場所へ引けなければ、原因を名指して拒み task を完了させない(ADR 0356 決定3)", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
    const { db, task, place, complete } = await connectedWork(sandbox, prod);
    const before = git(prod.path, "rev-parse", `task/${task.id}`);
    git(place.path, "checkout", "--quiet", "-b", "elsewhere");
    git(place.path, "branch", "-D", `task/${task.id}`);

    const denied = await complete();

    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain(`has no branch task/${task.id}`);
    expect(getTask(db, task.id)?.status).toBe("in_progress");
    expect(git(prod.path, "rev-parse", `task/${task.id}`)).toBe(before);
    expect(existsSync(join(place.path, ".git"))).toBe(true);
  });
});
