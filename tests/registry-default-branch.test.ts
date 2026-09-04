import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { loadRegistry } from "../src/registry.js";
import { listBoard } from "../src/tasks.js";
import { guardRegistryDefaultBranch, workspaceNeedsHuman } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import { makeRegistry } from "./registry-fixture.js";

/** A registry clone whose own workspaces.yaml carries a protected entry
 *  resolving to the clone itself (the registry workspace), with `origin/HEAD`
 *  optionally pointed at a given branch. `git symbolic-ref` sets the symref
 *  without needing a live remote — enough to exercise the default-branch guard. */
async function setup(originHeadBranch: string | null): Promise<{ dir: string; db: Db }> {
  const dir = await makeRegistry();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd: dir });
  await writeFile(join(dir, "workspaces.yaml"), `registry:\n  path: ${dir}\n  protected: true\n`);
  git("add", "-A");
  git("commit", "-m", "registry self-entry");
  if (originHeadBranch !== null) {
    git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${originHeadBranch}`);
  }
  return { dir, db: openDb(":memory:") };
}

function guard(dir: string, db: Db): void {
  guardRegistryDefaultBranch(db, loadRegistry(dir, "purely-local"), dir, "/unused-base", new FakeClock().now());
}

describe("guardRegistryDefaultBranch (ADR 0020 part 2)", () => {
  it("origin/HEAD が origin/main を指すなら quarantine しない", async () => {
    const { dir, db } = await setup("main");
    guard(dir, db);
    expect(workspaceNeedsHuman(db, "registry")).toBe(false);
  });

  it("origin/HEAD が main 以外を指すなら registry workspace を quarantine に落とす", async () => {
    const { dir, db } = await setup("develop");
    guard(dir, db);
    expect(workspaceNeedsHuman(db, "registry")).toBe(true);
    // the existing quarantine surface: a 1-choice Confirmation question stands
    const question = listBoard(db).find(
      (task) => task.question_quarantine_workspace === "registry",
    );
    expect(question?.title).toContain("registry");
  });

  it("origin/HEAD が無い(remote 未設定のローカル clone)なら不一致ではなく、quarantine しない", async () => {
    const { dir, db } = await setup(null);
    guard(dir, db);
    expect(workspaceNeedsHuman(db, "registry")).toBe(false);
  });
});
