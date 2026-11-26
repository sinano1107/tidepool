import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { openDb } from "../src/db.js";
import { loadRegistry } from "../src/registry.js";
import { workbenchPath } from "../src/workbench.js";
import { openHumanContentWorkbench } from "../src/workspace.js";
import { deleteWorkspace } from "../src/workspace-create.js";
import { stallCarriedVerification } from "./carried-verification-fixture.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, makeWorkspace, quarantineQuestion } from "./harness.js";
import { deletionReaders } from "./landing-fixture.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";
import { answer, boardWithParent, completedChild, conflicted, resolveInWorkbench } from "./workbench-fixture.js";

// 取り込みが作業台に撃つ git の上限超過(ADR 0357)は、人間には作業台の在り処で届く —— worker の tree とは言わない。
vi.mock("../src/worker-tree-git-timeout.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker-tree-git-timeout.js")>(),
  WORKER_TREE_GIT_TIMEOUT_MS: 1000,
}));
vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

it("作業台の作業ツリーを読む git が上限で止まった取り込みの拒否は、作業台の在り処を名指す", async () => {
  const c = await conflicted();
  const workbench = c.workbench();
  resolveInWorkbench(workbench, c.source);
  // 読み手の無い FIFO の .gitignore —— 未追跡の列挙がそこで止まる
  const fifo = join(workbench, ".gitignore");
  execFileSync("mkfifo", [fifo]);
  try {
    const refused = await answer(c).catch((err: Error) => err.message);

    expect(refused).toContain(`\`git ls-files\` on the workbench at ${workbench} did not finish within 1 s`);
    expect(refused).not.toContain("the worker's tree");
    expect(quarantineQuestion(c.db, "workspace", c.ws.name)).toBeDefined();
  } finally {
    rmSync(fifo, { force: true });
  }
});

it("運んだ後の確かめが上限を越えた取り込みは、作業台を名指して拒み、書き先の ref を保つ(ADR 0423 決定5)", async () => {
  const c = await conflicted();
  const workbench = c.workbench();
  resolveInWorkbench(workbench, c.source);
  const original = git(c.ws.path, "rev-parse", c.target);
  await stallCarriedVerification();
  try {
    await expect(answer(c)).rejects.toThrow(`\`git pack-objects\` on the workbench at ${workbench} did not finish within 1 s`);
  } finally {
    vi.unstubAllEnvs();
  }
  expect(git(c.ws.path, "rev-parse", c.target)).toBe(original);
  expect(existsSync(workbench)).toBe(true);
  expect(quarantineQuestion(c.db, "workspace", c.ws.name)).toBeDefined();
});

// 開く手が既にある作業台を読む git の上限超過は「読めない作業台」ではない —— 消さず、答え直しが開き直す文(text A7d)のまま
it("開く手が既にある作業台を読む git が上限で止まれば、作業台を消さず、人間に消させずに答え直しを言う", async () => {
  const b = await boardWithParent();
  const target = `task/${b.parent.id}`;
  let fifo = "";
  try {
    await completedChild(b, {
      work: (_checkout, task) => {
        const leftover = workbenchPath(b.base, { task: b.parent.id }, `task/${task.id}`);
        mkdirSync(dirname(leftover), { recursive: true });
        git(b.ws.path, "clone", "--quiet", "--branch", target, b.ws.path, leftover);
        // 読み手の無い FIFO の .gitignore —— 未追跡の列挙がそこで止まる
        fifo = join(leftover, ".gitignore");
        execFileSync("mkfifo", [fifo]);
      },
    });

    const purpose = quarantineQuestion(b.db, "workspace", b.ws.name)!.purpose;
    expect(purpose).toContain("The board could not open the workbench (");
    expect(purpose).toContain("answer again and it opens it again. ");
    expect(purpose).not.toContain("remove it by hand");
    expect(existsSync(fifo)).toBe(true);
  } finally {
    rmSync(fifo, { force: true });
  }
});

// #3587: 削除の扉で作業台を読む git の上限超過は参照の拒否ではない —— そのまま投げ、文は作業台の在り処を名指す
it("削除の扉が作業台を読む git が上限で止まれば、参照の拒否にせず作業台を名指して投げ、entry も作業台も残す", async () => {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("intake");
  const base = await tempDir("tidepool-workbenches-");
  const registryDir = await makeRegistry({ "workspaces.yaml": `${ws.name}:\n  path: ${ws.path}\n` });
  git(registryDir, "branch", "-M", "main");
  await openHumanContentWorkbench(db, ws, base, { actorId: HUMAN_ACTOR_ID, origin: "webui" }, () => new Date(), { resolveRegistered: undefined });
  const workbench = realpathSync(workbenchPath(base, { workspace: ws.name }));
  // 読み手の無い FIFO の .gitignore —— 未追跡の列挙がそこで止まる
  const fifo = join(workbench, ".gitignore");
  execFileSync("mkfifo", [fifo]);
  try {
    const failed = await deleteWorkspace({ name: ws.name, confirm: true }, {
      registry: { dir: registryDir, mode: "purely-local" },
      workspacesBaseDir: base,
      db,
      ...deletionReaders(db, () => ws),
    }).catch((err: Error) => err);

    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).name).not.toBe("DeletionBlockedError");
    expect((failed as Error).message).toContain(`on the workbench at ${workbench} did not finish within 1 s`);
    expect((failed as Error).message).not.toContain("the worker's tree");
    expect(loadRegistry(registryDir, "purely-local").workspaces[ws.name]).toBeDefined();
    expect(existsSync(workbench)).toBe(true);
  } finally {
    rmSync(fifo, { force: true });
  }
});
