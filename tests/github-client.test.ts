import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GhCliClient, IssueGoneError } from "../src/github.js";
import { GitHubAuth } from "../src/github-auth.js";
import { git } from "./harness.js";

let repoPath: string | undefined;
let remotePath: string | undefined;
let binPath: string | undefined;
let authPath: string | undefined;
let originalPath: string | undefined;
let savedGhToken: string | undefined;

beforeEach(() => {
  savedGhToken = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(async () => {
  if (savedGhToken !== undefined) {
    process.env.GH_TOKEN = savedGhToken;
  } else {
    delete process.env.GH_TOKEN;
  }
  if (originalPath !== undefined) process.env.PATH = originalPath;
  for (const p of [repoPath, remotePath, binPath, authPath]) {
    if (p) await rm(p, { recursive: true, force: true });
  }
  repoPath = remotePath = binPath = authPath = originalPath = undefined;
});

/** ADR 0024 の secrets ファイルの代役: mode 600 のトークンファイルを実体で
 *  作る — GhCliClient はここから読んだトークンを各呼び出しの env に都度
 *  注入する(process.env には決して書かない)。 */
async function makeAuth(token = "test-token"): Promise<GitHubAuth> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-secrets-"));
  authPath = dir;
  const file = join(dir, "github-token");
  writeFileSync(file, `${token}\n`);
  chmodSync(file, 0o600);
  return new GitHubAuth(file);
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

  const client = new GhCliClient(await makeAuth());
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

it("トークンは gh の子プロセス env にだけ注入され、盤面プロセスの env には載らない(ADR 0024)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const logPath = join(dir, "gh-invocations.log");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "token=$GH_TOKEN" >> "${logPath}"\n`);
  chmodSync(join(dir, "gh"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  await new GhCliClient(await makeAuth()).mergePullRequest({ path: "/tmp", number: 7 });

  // gh 側(子プロセス)はトークンを見え、worker が丸ごと継承する側の
  // process.env には現れない — issue #50 の「worker は credential ゼロ」
  expect(await readFile(logPath, "utf8")).toContain("token=test-token");
  expect(process.env.GH_TOKEN).toBeUndefined();
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

  const status = await new GhCliClient(await makeAuth()).getCiStatus({ path: "/tmp", number: 1 });
  expect(status).toBe("success");
});

it("getCiStatus は pending なチェックが残っていれば(非ゼロ終了でも)pending を返す", async () => {
  const dir = await fakeGhChecks('[{"bucket":"pending"}]', 8);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const status = await new GhCliClient(await makeAuth()).getCiStatus({ path: "/tmp", number: 1 });
  expect(status).toBe("pending");
});

it("getCiStatus は fail バケットがあれば failure を返す", async () => {
  const dir = await fakeGhChecks('[{"bucket":"pass"},{"bucket":"fail"}]', 1);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const status = await new GhCliClient(await makeAuth()).getCiStatus({ path: "/tmp", number: 1 });
  expect(status).toBe("failure");
});

it("getCiStatus は非ゼロ終了で stdout が全く無い場合、チェック無しとして success を返す", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nexit 1\n`);
  chmodSync(join(dir, "gh"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const status = await new GhCliClient(await makeAuth()).getCiStatus({ path: "/tmp", number: 1 });
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

  const issue = await new GhCliClient(await makeAuth()).getIssue({ path: "/tmp", number: 49 });

  expect(issue).toEqual({
    title: "ログイン画面のバグ",
    body: "再現手順: ...",
    comments: ["追加情報です", "これも見てください"],
  });
});

it("getIssue は close 済み issue に対して IssueGoneError(closed) を投げる(issue #49 設計点5: 確定的失敗)", async () => {
  const dir = await fakeGhIssueView(
    JSON.stringify({
      title: "解決済みのバグ",
      body: "もう直っている",
      comments: [],
      state: "CLOSED",
    }),
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const err = await new GhCliClient(await makeAuth())
    .getIssue({ path: "/tmp", number: 49 })
    .then(() => null)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(IssueGoneError);
  expect((err as IssueGoneError).reason).toBe("closed");
});

/** Stands in for a failing `gh issue view`: writes the given stderr and
 *  exits 1, the process-boundary shape of both a not-found issue and an
 *  outage — the classifier has only this surface to tell them apart. */
async function fakeGhIssueViewFailure(stderr: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const script = join(dir, "gh");
  writeFileSync(script, `#!/bin/sh\necho '${stderr}' >&2\nexit 1\n`);
  chmodSync(script, 0o755);
  return dir;
}

it("getIssue は存在しない issue に対して IssueGoneError(not_found) を投げ、その他の失敗は素通しする(issue #49 設計点5)", async () => {
  const dir = await fakeGhIssueViewFailure(
    "GraphQL: Could not resolve to an issue or pull request with the number of 9999. (repository.issue)",
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const notFound = await new GhCliClient(await makeAuth())
    .getIssue({ path: "/tmp", number: 9999 })
    .then(() => null)
    .catch((e: unknown) => e);
  expect(notFound).toBeInstanceOf(IssueGoneError);
  expect((notFound as IssueGoneError).reason).toBe("not_found");

  // ネットワーク断など、それ以外の失敗は分類せずそのまま伝播する(一時的失敗)
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho 'error connecting to api.github.com' >&2\nexit 1\n`);
  const outage = await new GhCliClient(await makeAuth())
    .getIssue({ path: "/tmp", number: 49 })
    .then(() => null)
    .catch((e: unknown) => e);
  expect(outage).not.toBeInstanceOf(IssueGoneError);
  expect(outage).toBeInstanceOf(Error);
});

it("listIssues は gh issue list --state open --limit 100 --json number,title を呼び、結果を返す(issue #67)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const logPath = join(dir, "gh-invocations.log");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh\necho "$@" >> "${logPath}"\nprintf '%s' '${JSON.stringify([
      { number: 12, title: "ログイン画面のバグ" },
      { number: 7, title: "テストを直す" },
    ])}'\n`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const issues = await new GhCliClient(await makeAuth()).listIssues({ path: "/tmp" });

  expect(issues).toEqual([
    { number: 12, title: "ログイン画面のバグ" },
    { number: 7, title: "テストを直す" },
  ]);
  const invocations = await readFile(logPath, "utf8");
  expect(invocations).toContain("issue list --state open --limit 100 --json number,title");
});

it("mergePullRequest は gh pr merge --merge を呼ぶ", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const logPath = join(dir, "gh-invocations.log");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$@" >> "${logPath}"\n`);
  chmodSync(join(dir, "gh"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  await new GhCliClient(await makeAuth()).mergePullRequest({ path: "/tmp", number: 7 });

  const invocations = await readFile(logPath, "utf8");
  expect(invocations).toContain("pr merge 7 --merge");
});

it("addIssueComment は gh issue comment --body を呼ぶ(issue #49 設計点4: 承認済みサジェストの追記)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const logPath = join(dir, "gh-invocations.log");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$@" >> "${logPath}"\n`);
  chmodSync(join(dir, "gh"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  await new GhCliClient(await makeAuth()).addIssueComment(
    { path: "/tmp", number: 49 },
    "## Completion criteria\n- the login form submits cleanly",
  );

  const invocations = await readFile(logPath, "utf8");
  expect(invocations).toContain("issue comment 49 --body");
  expect(invocations).toContain("the login form submits cleanly");
});
