import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF as fullHandoff,
  git,
  HOUR,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("issue #26: 実行側の複数 workspace 対応", () => {
  it("異なる workspace の2タスクがそれぞれの checkout で実行され、片方の quarantine が他方の pickup を止めない", async () => {
    const sandbox = await makeWorkspace(dirs, "sandbox");
    const prod = await makeWorkspace(dirs, "prod");
    const registry: Record<string, WorkspaceConfig> = { sandbox, prod };
    t = await bootTidepool({
      workspace: sandbox,
      resolveWorkspace: (name) => {
        const ws = registry[name ?? "sandbox"];
        if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
        return ws;
      },
    });

    // AC1: workspace が異なる2つのタスクが、それぞれの registry workspace
    // の checkout で実行される
    const inSandbox = await registerWork(t, "runs in sandbox");
    const inProd = await registerWork(t, "runs in prod", "prod");
    await t.clock.advance(HOUR);
    expect(t.worker.started.map((x) => x.id)).toEqual([inSandbox.id]);
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${inSandbox.id}`);

    const c1 = await mcpClient(t.baseUrl, inSandbox.id);
    await c1.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
    await c1.close();

    await t.clock.advance(HOUR);
    expect(t.worker.started.map((x) => x.id)).toEqual([inSandbox.id, inProd.id]);
    expect(git(prod.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${inProd.id}`);
    // sandbox's own checkout was left clean and untouched by prod's pickup
    expect(git(sandbox.path, "status", "--porcelain")).toBe("");

    // break prod's tree rule so completing it quarantines only "prod"
    writeFileSync(join(prod.path, "junk.txt"), "uncommittable\n");
    await rm(join(prod.path, ".git"), { recursive: true, force: true });
    const c2 = await mcpClient(t.baseUrl, inProd.id);
    await c2.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
    await c2.close();

    const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
    const quarantineQuestion = board.find(
      (x: any) => x.type === "question" && x.title.includes("prod"),
    );
    expect(quarantineQuestion).toBeDefined();

    // AC2: prod のタスクだけ pickup が止まり、sandbox のタスクは流れ続ける
    const stuckInProd = await registerWork(t, "stuck", "prod");
    const runsInSandbox = await registerWork(t, "keeps flowing", "sandbox");
    await t.clock.advance(HOUR);

    expect(t.worker.started.map((x) => x.id)).toEqual([
      inSandbox.id,
      inProd.id,
      runsInSandbox.id,
    ]);
    expect(t.worker.started.map((x) => x.id)).not.toContain(stuckInProd.id);
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      `task/${runsInSandbox.id}`,
    );
  });
});
