import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { workbenchPath } from "../src/workbench.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, quarantineQuestion } from "./harness.js";
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

// 開く手が既にある作業台を読む git の上限超過は「読めない作業台」ではない —— 消さず、答え直しが開き直す文(text A7d)のまま
it("開く手が既にある作業台を読む git が上限で止まれば、作業台を消さず、人間に消させずに答え直しを言う", async () => {
  const b = await boardWithParent();
  const target = `task/${b.parent.id}`;
  let fifo = "";
  try {
    await completedChild(b, {
      work: (_checkout, task) => {
        const leftover = workbenchPath(b.base, target, `task/${task.id}`);
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
