import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GhCliClient, IssueGoneError } from "../src/github.js";
import { GitHubAuth } from "../src/github-auth.js";
import { type FakeBroker, issuedToken, startFakeBroker } from "./fake-broker.js";
import { git } from "./harness.js";

let repoPath: string | undefined;
let remotePath: string | undefined;
let binPath: string | undefined;
let authPath: string | undefined;
let originalPath: string | undefined;
let savedGhToken: string | undefined;
const brokers: FakeBroker[] = [];

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
  for (const broker of brokers.splice(0)) await broker.close();
  repoPath = remotePath = binPath = authPath = originalPath = undefined;
});

/** ADR 0093 の user token ファイルの代役: mode 600 のファイルを実体で作り、
 *  仲介の代役を1つ立てて繋ぐ — GhCliClient は checkout の `origin` が名指す repo
 *  の installation token を各呼び出しの env に都度注入する(process.env には
 *  決して書かない)。 */
async function makeAuth(installationToken = "installation-token"): Promise<GitHubAuth> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-secrets-"));
  authPath = dir;
  const file = join(dir, "github-token");
  writeFileSync(file, "gho_user\n");
  chmodSync(file, 0o600);
  const broker = await startFakeBroker(() => issuedToken(installationToken));
  brokers.push(broker);
  return new GitHubAuth(file, broker.url);
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

it("トークンは gh の子プロセス env にだけ注入され、盤面プロセスの env には載らない(ADR 0093)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const logPath = join(dir, "gh-invocations.log");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "token=$GH_TOKEN" >> "${logPath}"\n`);
  chmodSync(join(dir, "gh"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  // installation token は repo 単位(ADR 0093 決定2)なので、呼び出し元の
  // checkout が github.com の origin を持っていなければ要求する先が無い
  repoPath = await mkdtemp(join(tmpdir(), "tidepool-repo-"));
  git(repoPath, "init", "-b", "main");
  git(repoPath, "remote", "add", "origin", "https://github.com/acme/widget.git");

  await new GhCliClient(await makeAuth()).mergePullRequest({ path: repoPath, number: 7 });

  // gh 側(子プロセス)が見るのは**仲介が発行した installation token**であって
  // ファイルの中身(user token)ではない。worker が丸ごと継承する側の process.env
  // には現れない — issue #50 の「worker は credential ゼロ」
  expect(await readFile(logPath, "utf8")).toContain("token=installation-token");
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

it("isPullRequestMerged は gh pr view --json state を読み、MERGED だけを真とする(ADR 0079)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-fakebin-"));
  binPath = dir;
  const logPath = join(dir, "gh-invocations.log");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh\necho "$@" >> "${logPath}"\ncase "$3" in 7) printf '{"state":"MERGED"}';; *) printf '{"state":"OPEN"}';; esac\n`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;

  const client = new GhCliClient(await makeAuth());
  expect(await client.isPullRequestMerged({ path: "/tmp", number: 7 })).toBe(true);
  expect(await client.isPullRequestMerged({ path: "/tmp", number: 8 })).toBe(false);

  const invocations = await readFile(logPath, "utf8");
  expect(invocations).toContain("pr view 7 --json state");
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

it("tokenRefusal は仲介が token を出せれば null、断られたら status と error code を持つ理由を返す(ADR 0093 決定8)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-secrets-"));
  authPath = dir;
  const file = join(dir, "github-token");
  writeFileSync(file, "gho_user\n");
  chmodSync(file, 0o600);
  const broker = await startFakeBroker((request) =>
    request.repo === "sinano1107/tidepool"
      ? issuedToken("installation-token")
      : { status: 404, body: { error: "repo_unreachable" } },
  );
  brokers.push(broker);
  const client = new GhCliClient(new GitHubAuth(file, broker.url));

  expect(await client.tokenRefusal({ owner: "sinano1107", name: "tidepool" })).toBeNull();
  const reason = await client.tokenRefusal({ owner: "sinano1107", name: "nope" });

  expect(reason).toContain("HTTP 404");
  expect(reason).toContain("repo_unreachable");
});

it("tokenRefusal は持っている token を答えにせず、扉のたびに仲介へ撃ち直す(再検査)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-secrets-"));
  authPath = dir;
  const file = join(dir, "github-token");
  writeFileSync(file, "gho_user\n");
  chmodSync(file, 0o600);
  let installed = true;
  const broker = await startFakeBroker(() =>
    installed ? issuedToken("installation-token") : { status: 404, body: { error: "repo_unreachable" } },
  );
  brokers.push(broker);
  const client = new GhCliClient(new GitHubAuth(file, broker.url));
  const ref = { owner: "sinano1107", name: "tidepool" };

  expect(await client.tokenRefusal(ref)).toBeNull();
  installed = false; // 1 時間有効な token をキャッシュに持ったまま、App が外された

  expect(await client.tokenRefusal(ref)).toContain("repo_unreachable");
});
