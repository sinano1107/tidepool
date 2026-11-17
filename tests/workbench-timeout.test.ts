import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { GIT_FIXTURE_TEST_TIMEOUT, quarantineQuestion } from "./harness.js";
import { answer, conflicted, resolveInWorkbench } from "./workbench-fixture.js";

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
