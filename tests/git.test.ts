import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { git } from "../src/git.js";
import { tempDir } from "./temp-dir.js";

/** 投げたものを返す(投げなければ赤)。 */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("did not throw");
}

it("cwd が無い git は subcommand と在り処を名指して投げ、元の spawn の失敗を cause に持つ(issue #2722)", async () => {
  const missing = join(await tempDir("tidepool-git-"), "gone");

  const err = thrown(() => git(missing, "status"));

  expect(err.message).toBe(`\`git status\` cannot run: the directory ${missing} does not exist`);
  expect((err.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
});

it("cwd があって git が PATH に無いなら、元の spawn の失敗をそのまま投げる(issue #2722)", async () => {
  const cwd = await tempDir("tidepool-git-");
  vi.stubEnv("PATH", cwd);
  try {
    const err = thrown(() => git(cwd, "status"));
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(err.message).toContain("ENOENT");
    expect(err.cause).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});
