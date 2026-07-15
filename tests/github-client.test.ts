import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GhCliClient } from "../src/github.js";
import { git } from "./harness.js";

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

/** Stands in for `gh pr checks`: prints the given JSON to stdout and exits
 *  with the given code — `gh` itself exits non-zero while any check is
 *  pending or failing (its own documented exit codes), which is exactly the
 *  case getCiStatus's stdout-capture fallback exists for. */
async function fakeGhChecks(stdout: string, exitCode: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const script = join(dir, "gh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${exitCode}\n`);
  chmodSync(script, 0o755);
  return dir;
}

it("getCiStatus は全チェック pass で success を返す", async () => {
  const dir = await fakeGhChecks('[{"bucket":"pass"}]', 0);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const status = await new GhCliClient().getCiStatus({ path: "/tmp", number: 1 });
  expect(status).toBe("success");
});

it("getCiStatus は pending なチェックが残っていれば(非ゼロ終了でも)pending を返す", async () => {
  const dir = await fakeGhChecks('[{"bucket":"pending"}]', 8);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const status = await new GhCliClient().getCiStatus({ path: "/tmp", number: 1 });
  expect(status).toBe("pending");
});

it("getCiStatus は fail バケットがあれば failure を返す", async () => {
  const dir = await fakeGhChecks('[{"bucket":"pass"},{"bucket":"fail"}]', 1);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const status = await new GhCliClient().getCiStatus({ path: "/tmp", number: 1 });
  expect(status).toBe("failure");
});

it("getCiStatus は非ゼロ終了で stdout が全く無い場合、チェック無しとして success を返す", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nexit 1\n`);
  chmodSync(join(dir, "gh"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const status = await new GhCliClient().getCiStatus({ path: "/tmp", number: 1 });
  expect(status).toBe("success");
});

/** Stands in for `gh issue view --json title,body,comments`: prints the
 *  given JSON to stdout, same fake-at-the-process-boundary approach as
 *  fakeGhChecks. */
async function fakeGhIssueView(stdout: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const script = join(dir, "gh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s' '${stdout}'\n`);
  chmodSync(script, 0o755);
  return dir;
}

it("getIssue は title / body / 全コメントを返す", async () => {
  const dir = await fakeGhIssueView(
    JSON.stringify({
      title: "ログイン画面のバグ",
      body: "再現手順: ...",
      comments: [{ body: "追加情報です" }, { body: "これも見てください" }],
    }),
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const issue = await new GhCliClient().getIssue({ path: "/tmp", number: 49 });

  expect(issue).toEqual({
    title: "ログイン画面のバグ",
    body: "再現手順: ...",
    comments: ["追加情報です", "これも見てください"],
  });
});

it("mergePullRequest は gh pr merge --merge を呼ぶ", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const logPath = join(dir, "gh-invocations.log");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$@" >> "${logPath}"\n`);
  chmodSync(join(dir, "gh"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  await new GhCliClient().mergePullRequest({ path: "/tmp", number: 7 });

  const invocations = await readFile(logPath, "utf8");
  expect(invocations).toContain("pr merge 7 --merge");
});
