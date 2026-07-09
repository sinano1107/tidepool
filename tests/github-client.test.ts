import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GhCliClient } from "../src/github.js";

let repoPath: string | undefined;
let remotePath: string | undefined;
let binPath: string | undefined;
let originalPath: string | undefined;

afterEach(async () => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  for (const p of [repoPath, remotePath, binPath]) {
    if (p) await rm(p, { recursive: true, force: true });
  }
  repoPath = remotePath = binPath = originalPath = undefined;
});

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir },
  )
    .toString()
    .trim();
}

/** Stands in for the real `gh` binary on PATH: git itself stays real (the
 *  PRD test policy), but the GitHub API side of `gh` would need real network
 *  + auth, so it's faked at the process boundary instead. */
async function fakeGh(logPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const script = join(dir, "gh");
  writeFileSync(
    script,
    `#!/bin/sh\necho "$@" >> "${logPath}"\necho "https://github.com/example/repo/pull/42"\n`,
  );
  chmodSync(script, 0o755);
  return dir;
}

it("gh pr create の前にタスクブランチを origin へ push する", async () => {
  repoPath = await mkdtemp(join(tmpdir(), "tidepool-repo-"));
  remotePath = await mkdtemp(join(tmpdir(), "tidepool-remote-"));
  git(remotePath, "init", "--bare", "-b", "main");

  git(repoPath, "init", "-b", "main");
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  git(repoPath, "add", "-A");
  git(repoPath, "commit", "-m", "initial");
  git(repoPath, "remote", "add", "origin", remotePath);
  git(repoPath, "push", "origin", "main");

  git(repoPath, "checkout", "-b", "task/abc");
  writeFileSync(join(repoPath, "notes.txt"), "done\n");
  git(repoPath, "add", "-A");
  git(repoPath, "commit", "-m", "WIP: task abc");

  const logPath = join(repoPath, "gh-invocations.log");
  const fakeBinDir = await fakeGh(logPath);
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${originalPath}`;

  const client = new GhCliClient();
  const result = await client.createPullRequest({
    path: repoPath,
    branch: "task/abc",
    base: "main",
    title: "ship it",
    body: "the body",
  });

  expect(result).toEqual({ url: "https://github.com/example/repo/pull/42", number: 42 });

  // push が実際に起きたことを、リモート(bare repo)側のブランチの実体で確認する
  const remoteTaskCommit = git(remotePath, "rev-parse", "task/abc");
  const localTaskCommit = git(repoPath, "rev-parse", "task/abc");
  expect(remoteTaskCommit).toBe(localTaskCommit);

  const invocations = await readFile(logPath, "utf8");
  expect(invocations).toContain("pr create");
  expect(invocations).toContain("task/abc");
});
