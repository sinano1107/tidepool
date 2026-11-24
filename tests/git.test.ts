import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { git, localGitEnv, stashEntries } from "../src/git.js";
import { loadRegistry } from "../src/registry.js";
import { recordedSettingsDisposition } from "../src/sandbox.js";
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

it("local git ignores global and system config even when ambient or supplied env opts in (ADR 0356 決定5)", () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/ambient.gitconfig");
  vi.stubEnv("GIT_CONFIG_PARAMETERS", "'core.hooksPath=/ambient/hooks'");
  vi.stubEnv("GIT_DIR", "/ambient.git");
  const env = localGitEnv({ GIT_CONFIG_NOSYSTEM: "0" });
  expect(env).toMatchObject({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  expect(env.GIT_DIR).toBeUndefined();
});

it("cwd が無い git は subcommand と在り処を名指して投げ、元の spawn の失敗を cause に持つ(issue #2722)", async () => {
  const missing = join(await tempDir("tidepool-git-"), "gone");

  const err = thrown(() => git(missing, "status"));

  expect(err.message).toBe(`\`git status\` cannot run: the directory ${missing} does not exist`);
  expect((err.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
});

it("cwd があって git が PATH に無いなら、元の spawn の失敗をそのまま投げる(issue #2722)", async () => {
  const cwd = await tempDir("tidepool-git-");
  vi.stubEnv("PATH", cwd);
  const err = thrown(() => git(cwd, "status"));
  expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
  expect(err.message).toContain("ENOENT");
  expect(err.cause).toBeUndefined();
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
  vi.stubEnv("LC_ALL", "C");

  expect(() => git(dir, "show", "HEAD:README.md")).toThrow("transport 'http' not allowed");
  expect(offNetwork()).toEqual(STAYED_OFF_THE_NETWORK);
});

it("呼び手の env も ambient の env も転送の床を広げない", async () => {
  const workspace = await makeWorkspace("partial-clone-floor");
  const { dir, offNetwork } = await partialCloneOf(workspace.path);
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "file:http:https");
  vi.stubEnv("LC_ALL", "C");

  expect(() => git(dir, "show", "HEAD:README.md")).toThrow("transport 'http' not allowed");
  expect(offNetwork()).toEqual(STAYED_OFF_THE_NETWORK);
});

it("部分 clone の記録の settings.json は blob を読まず(`recordedSettingsDisposition`)網に出ずに外すと返す(ADR 0360 決定1)", async () => {
  const workspace = await makeWorkspace("partial-clone-settings");
  mkdirSync(join(workspace.path, ".claude"));
  writeFileSync(join(workspace.path, ".claude", "settings.json"), "{}\n");
  fixtureGit(workspace.path, "add", "-A");
  fixtureGit(workspace.path, "commit", "-m", "settings");
  const { dir, offNetwork } = await partialCloneOf(workspace.path);

  expect(recordedSettingsDisposition(dir, "HEAD")).toEqual({ hide: [".claude/settings.json"] });
  expect(offNetwork()).toEqual(STAYED_OFF_THE_NETWORK);
});

it("部分 clone の `loadRegistry` の blob 読みは網に出ず `transport 'http' not allowed` で落ちる", async () => {
  const { dir, offNetwork } = await partialCloneOf(await makeRegistry());
  vi.stubEnv("LC_ALL", "C");

  expect(() => loadRegistry(dir, "purely-local")).toThrow("transport 'http' not allowed");
  expect(offNetwork()).toEqual(STAYED_OFF_THE_NETWORK);
});

it("`git()` の local path の fetch は転送の床の下でも成功する", async () => {
  const source = await makeWorkspace("file-transport-source");
  const sha = fixtureGit(source.path, "rev-parse", "HEAD");
  const target = await makeWorkspace("file-transport-target");

  git(target.path, "fetch", "--quiet", source.path, sha);

  expect(fixtureGit(target.path, "cat-file", "-t", sha)).toBe("commit");
});

/** `path` に3段の stash を積み、新しい順の sha を返す。 */
function stashThree(path: string): string[] {
  for (const body of ["first\n", "second\n", "third\n"]) {
    writeFileSync(join(path, "README.md"), body);
    fixtureGit(path, "stash", "push", "-q");
  }
  return fixtureGit(path, "stash", "list", "--format=%H").split("\n");
}

it("`stashEntries` は途中の段の object が無くても reflog の全段を新しい順に並べ、件数で止まる(ADR 0373 決定4、#3752)", async () => {
  const ws = await makeWorkspace("stash-entries-missing");
  const entries = stashThree(ws.path);
  rmSync(join(ws.path, ".git", "objects", entries[1]!.slice(0, 2), entries[1]!.slice(2)));

  expect(stashEntries(ws.path)).toEqual(entries);
});

// 一番古い件の old 値が 0 でないとき、git は件数と同じ番号 `@{N}` にその old 値を返す —— 消した件の sha を足さない
it("`stashEntries` は `--rewrite` なしで一番古い件を消した reflog でも、残った件だけを並べる", async () => {
  const ws = await makeWorkspace("stash-entries-deleted-oldest");
  const entries = stashThree(ws.path);
  fixtureGit(ws.path, "reflog", "delete", "refs/stash@{2}");

  expect(stashEntries(ws.path)).toEqual(entries.slice(0, 2));
});

it("`stashEntries` は ambient の LC_ALL が git の文を訳す locale でも件の数の終わりを読む", async ({ skip }) => {
  const ws = await makeWorkspace("stash-entries-translated");
  const entries = stashThree(ws.path);
  const LOCALE = "de_DE.UTF-8";
  const probe = spawnSync("git", ["rev-parse", "--verify", "refs/stash@{9}"], { cwd: ws.path, env: { ...process.env, LC_ALL: LOCALE } });
  if (probe.stderr.toString().startsWith("fatal:")) skip(`this git does not translate its messages into ${LOCALE}`);
  vi.stubEnv("LC_ALL", LOCALE);

  expect(stashEntries(ws.path)).toEqual(entries);
});

it("`stashEntries` は reflog の無い refs/stash(update-ref で作った)では今の値だけを返す", async () => {
  const ws = await makeWorkspace("stash-entries-no-reflog");
  const head = fixtureGit(ws.path, "rev-parse", "HEAD");
  fixtureGit(ws.path, "update-ref", "refs/stash", head);

  expect(stashEntries(ws.path)).toEqual([head]);
});

it("`stashEntries` は refs/stash が無ければ空を返す", async () => {
  const ws = await makeWorkspace("stash-entries-absent");

  expect(stashEntries(ws.path)).toEqual([]);
});

// 空の reflog は読めない reflog(権限の無い file)と同じ「is empty」で git が言う —— 件数の終わりと取り違えて短いリストを返さない
it("`stashEntries` は件数を越えた以外の reflog の読みの失敗を投げる", async () => {
  const ws = await makeWorkspace("stash-entries-unreadable");
  stashThree(ws.path);
  fixtureGit(ws.path, "reflog", "expire", "--expire=now", "--all");

  expect(() => stashEntries(ws.path)).toThrow("log for refs/stash is empty");
});
