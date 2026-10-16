import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import { prepareWorkspaceAtPickup, verifyWorkspaceClean } from "../src/workspace.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

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
    ...HUMAN_WEBUI,
  );

  await expect(prepareWorkspaceAtPickup(db, workspace, task, { now: new Date(0) })).rejects.toThrow(
    ".git is not a directory — linked worktrees and submodules cannot be workspaces",
  );
  db.close();
});

/** 親 repo の部分ディレクトリ: 自分の `.git` を持たないが、git は親の作業ツリーとして解決する(issue #1964)。 */
async function subdirectoryOfRepository(name: string) {
  const parent = await makeWorkspace(name);
  await mkdir(join(parent.path, "sub"));
  await writeFile(join(parent.path, "sub", "file.md"), "sub\n");
  git(parent.path, "add", "-A");
  git(parent.path, "commit", "-m", "add sub");
  return { parent, workspace: { name, path: join(parent.path, "sub") } };
}

it("親 repo の部分ディレクトリは pickup の準備で拒否され、親 repo の HEAD もブランチも動かない", async () => {
  const { parent, workspace } = await subdirectoryOfRepository("subdir-pickup");
  const headBefore = git(parent.path, "symbolic-ref", "HEAD");
  const branchesBefore = git(parent.path, "branch", "--list");
  const db = openDb(":memory:");
  const task = registerTask(
    db,
    { type: "work", title: "work", purpose: "pick up a subdirectory", completion_criteria: "never runs" },
    new Date("2026-10-16T00:00:00.000Z"),
    ...HUMAN_WEBUI,
  );

  await expect(prepareWorkspaceAtPickup(db, workspace, task, { now: new Date(0) })).rejects.toThrow(
    "has no .git of its own",
  );
  expect(git(parent.path, "symbolic-ref", "HEAD")).toBe(headBefore);
  expect(git(parent.path, "branch", "--list")).toBe(branchesBefore);
  db.close();
});

it("修理確認の検証は親 repo の部分ディレクトリを拒否する", async () => {
  const { workspace } = await subdirectoryOfRepository("subdir-verify");

  expect(() => verifyWorkspaceClean(workspace)).toThrow("has no .git of its own");
});

it("修理確認の検証は `.git` がファイルのままなら拒否し、ディレクトリに戻せば通す", async () => {
  const workspace = await gitFileCheckout("git-file-verify");

  expect(() => verifyWorkspaceClean(workspace)).toThrow("linked worktrees and submodules cannot be workspaces");

  await rm(join(workspace.path, ".git"));
  await rename(join(workspace.path, ".git.real"), join(workspace.path, ".git"));
  expect(() => verifyWorkspaceClean(workspace)).not.toThrow();
});

it("修理確認の検証は、git として使えない path を使えない git リポジトリとして拒否する", () => {
  expect(() => verifyWorkspaceClean({ name: "no-repo", path: "/workspace/does-not-exist" })).toThrow(
    "workspace no-repo is not a usable git repository",
  );
});

it("修理確認の検証は、未 commit の変更が残る checkout を拒否する", async () => {
  const workspace = await makeWorkspace("verify-dirty");
  await writeFile(join(workspace.path, "uncommitted.txt"), "not committed\n");

  expect(() => verifyWorkspaceClean(workspace)).toThrow(`workspace ${workspace.name} still has uncommitted changes`);
});
