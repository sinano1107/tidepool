import { describe, expect, it } from "vitest";
import { checkRegistryReachability } from "../src/registry.js";
import { git } from "./harness.js";
import { makeRemoteBackedRegistry, writeUnannounced } from "./registry-fixture.js";

const check = (registryDir: string) => checkRegistryReachability(registryDir, undefined, writeUnannounced);

describe("registry clone の default branch はレジストリ到達性の検査に載る(ADR 0377 決定7)", () => {
  it("origin/HEAD が origin/main 以外を指すなら registry は使えず、理由は直す手を名指す", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect(await check(registryDir)).toEqual({
      available: false,
      reason: `the registry clone's origin/HEAD does not point at origin/main. In ${registryDir}, run \`git remote set-head origin main\`.`,
    });
  });

  it("origin/HEAD が origin/main を指すなら使える", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(await check(registryDir)).toEqual({ available: true });
  });

  // spec #3273 の読み: symref が無ければ今日どおり通す(ユーザー未確認)
  it("origin/HEAD の symref が無いなら使える", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    expect(await check(registryDir)).toEqual({ available: true });
  });

  it("`git remote set-head origin main` で直せば同じ検査が通る(受理の撃ち直しが通る根拠)", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect((await check(registryDir)).available).toBe(false);
    git(registryDir, "remote", "set-head", "origin", "main");
    expect(await check(registryDir)).toEqual({ available: true });
  });
});
