import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import { prepareWorkspaceAtPickup, verifyWorkspaceClean } from "../src/workspace.js";
import { makeWorkspace } from "./harness.js";

/** linked worktree / submodule の形: `.git` がディレクトリでなくファイル(ADR 0146)。
 *  本物の `.git` は脇へ退けておき、直す側のテストが戻せるようにする。 */
async function gitFileCheckout(name: string) {
  const workspace = await makeWorkspace(name);
  await rename(join(workspace.path, ".git"), join(workspace.path, ".git.real"));
  await writeFile(join(workspace.path, ".git"), "gitdir: /nowhere\n");
  return workspace;
}

it("`.git` がファイルの checkout は pickup の準備で拒否され、理由に linked worktree / submodule を挙げる", async () => {
  const workspace = await gitFileCheckout("git-file-pickup");
  const db = openDb(":memory:");
  const task = registerTask(
    db,
    { type: "work", title: "work", purpose: "pick up a git-file checkout", completion_criteria: "never runs" },
    new Date("2026-09-22T00:00:00.000Z"),
  );

  await expect(prepareWorkspaceAtPickup(db, workspace, task, {})).rejects.toThrow(
    ".git is not a directory — linked worktrees and submodules cannot be workspaces",
  );
  db.close();
});

it("修理確認の検証は `.git` がファイルのままなら拒否し、ディレクトリに戻せば通す", async () => {
  const workspace = await gitFileCheckout("git-file-verify");

  expect(() => verifyWorkspaceClean(workspace)).toThrow("linked worktrees and submodules cannot be workspaces");

  await rm(join(workspace.path, ".git"));
  await rename(join(workspace.path, ".git.real"), join(workspace.path, ".git"));
  expect(() => verifyWorkspaceClean(workspace)).not.toThrow();
});
