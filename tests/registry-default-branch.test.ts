import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { registryDefaultBranchCheck } from "../src/registry.js";
import { makeRemoteBackedRegistry } from "./registry-fixture.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });

describe("registry clone の default branch の検査(ADR 0377 決定7)", () => {
  it("origin/HEAD が origin/main 以外を指すなら registry は使えず、理由は直す手を名指す", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect(registryDefaultBranchCheck(registryDir)).toEqual({
      available: false,
      reason: `the registry clone's origin/HEAD does not point at origin/main. In ${registryDir}, run \`git remote set-head origin main\`.`,
    });
  });

  it("origin/HEAD が origin/main を指すなら使える", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(registryDefaultBranchCheck(registryDir)).toEqual({ available: true });
  });

  it("origin/HEAD の symref が無いなら使える", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    expect(registryDefaultBranchCheck(registryDir)).toEqual({ available: true });
  });

  it("`git remote set-head origin main` で直せば同じ検査が通る(受理の撃ち直しが通る根拠)", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect(registryDefaultBranchCheck(registryDir).available).toBe(false);
    git(registryDir, "remote", "set-head", "origin", "main");
    expect(registryDefaultBranchCheck(registryDir)).toEqual({ available: true });
  });
});
