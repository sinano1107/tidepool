import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { git, gitWithEnv } from "../src/git.js";
import { authedFetch, GIT_NETWORK_TIMEOUT_MS } from "../src/github-auth.js";
import { loadRegistry } from "../src/registry.js";
import { workspaceSettingsDisposition } from "../src/sandbox.js";
import { humanAskpass, startDenyingHttpRemote } from "./git-http-remote.js";
import { git as fixtureGit, GIT_FIXTURE_TEST_TIMEOUT, makeWorkspace } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

afterEach(() => {
  vi.unstubAllEnvs();
});

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

/** `source` の blob を持たない部分 clone。promisor は 401 の loopback で、index は HEAD を指す(blob は遅延 fetch でしか読めない)。 */
async function partialCloneOf(source: string) {
  fixtureGit(source, "config", "uploadpack.allowFilter", "true");
  const dir = await tempDir("tidepool-partial-");
  execFileSync("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", `file://${source}`, dir], { stdio: "pipe" });
  fixtureGit(dir, "read-tree", "HEAD");
  const remote = await startDenyingHttpRemote();
  fixtureGit(dir, "config", "remote.origin.url", remote.url);
  const askpass = await humanAskpass();
  return { dir, offNetwork: () => ({ askpass: askpass.tripped(), requests: remote.requests() }) };
}

const STAYED_OFF_THE_NETWORK = { askpass: false, requests: [] };

// ADR 0339 Status 追記: 盤面の local の git の転送は file だけ。部分 clone の blob は遅延 fetch でしか読めないので、そこで落ちる
it("部分 clone で blob を要る verb は網に出ず `transport 'http' not allowed` で落ちる", async () => {
  const workspace = await makeWorkspace("partial-clone-show");
  const { dir, offNetwork } = await partialCloneOf(workspace.path);

  expect(() => git(dir, "show", "HEAD:README.md")).toThrow("transport 'http' not allowed");
  expect(offNetwork()).toEqual(STAYED_OFF_THE_NETWORK);
});

it("呼び手の env も ambient の env も転送の床を広げない", async () => {
  const workspace = await makeWorkspace("partial-clone-floor");
  const { dir, offNetwork } = await partialCloneOf(workspace.path);
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "file:http:https");

  expect(() => git(dir, "show", "HEAD:README.md")).toThrow("transport 'http' not allowed");
  expect(() => gitWithEnv({ GIT_ALLOW_PROTOCOL: "file:http:https" }, dir, "show", "HEAD:README.md")).toThrow("transport 'http' not allowed");
  expect(offNetwork()).toEqual(STAYED_OFF_THE_NETWORK);
});

it("部分 clone の sandbox の index 読み(`workspaceSettingsDisposition`)は網に出ず、読めない settings.json として返す", async () => {
  const workspace = await makeWorkspace("partial-clone-settings");
  mkdirSync(join(workspace.path, ".claude"));
  writeFileSync(join(workspace.path, ".claude", "settings.json"), "{}\n");
  fixtureGit(workspace.path, "add", "-A");
  fixtureGit(workspace.path, "commit", "-m", "settings");
  const { dir, offNetwork } = await partialCloneOf(workspace.path);

  expect(workspaceSettingsDisposition(dir, true).overriding).toEqual(["settings.json"]);
  expect(offNetwork()).toEqual(STAYED_OFF_THE_NETWORK);
});

it("部分 clone の `loadRegistry` の blob 読みは網に出ず `transport 'http' not allowed` で落ちる", async () => {
  const { dir, offNetwork } = await partialCloneOf(await makeRegistry());

  expect(() => loadRegistry(dir, "purely-local")).toThrow("transport 'http' not allowed");
  expect(offNetwork()).toEqual(STAYED_OFF_THE_NETWORK);
});

it("`git()` の local path の fetch と `authedFetch` の hop2 は転送の床の下でも成功する", async () => {
  const source = await makeWorkspace("file-transport-source");
  const sha = fixtureGit(source.path, "rev-parse", "HEAD");
  const viaGit = await makeWorkspace("file-transport-git");
  const viaHop2 = await makeWorkspace("file-transport-hop2");
  fixtureGit(viaHop2.path, "remote", "add", "origin", source.path);

  git(viaGit.path, "fetch", "--quiet", source.path, sha);
  authedFetch(undefined, viaHop2.path, GIT_NETWORK_TIMEOUT_MS, sha);

  expect(fixtureGit(viaGit.path, "cat-file", "-t", sha)).toBe("commit");
  expect(fixtureGit(viaHop2.path, "cat-file", "-t", sha)).toBe("commit");
});
