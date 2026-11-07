import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../src/git.js";
import { commitToRegistry } from "../src/registry-write.js";
import { makeRegistry, writeUnannounced } from "./registry-fixture.js";

describe("commitToRegistry", () => {
  it("returns the base SHA without a commit when nothing changes", async () => {
    const dir = await makeRegistry();
    git(dir, "branch", "-M", "main");
    const base = git(dir, "rev-parse", "main");

    const landed = commitToRegistry(
      { dir, mode: "purely-local", writeRef: writeUnannounced },
      undefined,
      () => {},
      "no change",
    );

    expect(landed).toBe(base);
    expect(git(dir, "rev-parse", "main")).toBe(base);
  });

  it("lands a new file even when Git is configured to hide untracked files", async () => {
    const dir = await makeRegistry();
    git(dir, "branch", "-M", "main");
    git(dir, "config", "status.showUntrackedFiles", "no");
    const base = git(dir, "rev-parse", "main");

    const landed = commitToRegistry(
      { dir, mode: "purely-local", writeRef: writeUnannounced },
      undefined,
      (worktree) => writeFileSync(join(worktree, "new-file.txt"), "new content\n"),
      "add new file",
    );

    expect(landed).not.toBe(base);
    expect(git(dir, "rev-parse", "main")).toBe(landed);
    expect(git(dir, "show", `${landed}:new-file.txt`)).toBe("new content");
  });
});
