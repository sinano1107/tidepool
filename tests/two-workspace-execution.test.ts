import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir },
  )
    .toString()
    .trim();
}

async function makeWorkspace(name: string): Promise<WorkspaceConfig> {
  const path = await mkdtemp(join(tmpdir(), `tidepool-${name}-`));
  dirs.push(path);
  git(path, "init", "-b", "main");
  writeFileSync(join(path, "README.md"), "workspace\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "initial");
  return { name, path };
}

async function registerWork(title: string, workspace?: string) {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
    ...(workspace !== undefined && { workspace }),
  });
  return res.json;
}

const fullHandoff = {
  outcome: "done as specified",
  deliverables: "n/a",
  decision_refs: "n/a",
  dead_ends: "n/a",
  resume_context: "n/a",
  known_issues: "n/a",
};

describe("issue #26: 実行側の複数 workspace 対応", () => {
  it("異なる workspace の2タスクがそれぞれの checkout で実行され、片方の quarantine が他方の pickup を止めない", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
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
    const inSandbox = await registerWork("runs in sandbox");
    const inProd = await registerWork("runs in prod", "prod");
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
    const stuckInProd = await registerWork("stuck", "prod");
    const runsInSandbox = await registerWork("keeps flowing", "sandbox");
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
