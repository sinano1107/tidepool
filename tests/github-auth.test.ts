import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authedGit, GitHubAuth, loadGitHubAuth } from "../src/github-auth.js";
import { git } from "./harness.js";

const dirs: string[] = [];

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function makeTokenFile(token: string, mode: number): Promise<string> {
  const dir = await makeDir("tidepool-secrets-");
  const file = join(dir, "github-token");
  writeFileSync(file, token);
  chmodSync(file, mode);
  return file;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 各 fail-closed ケースは戻り値(undefined = GitHub 身元なし)だけを断言
 *  する — 警告はここでは黙らせるだけ(console を汚さない)。 */
function silenceWarn(): void {
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("loadGitHubAuth: fail-closed(issue #50 完了基準)", () => {
  it("パス未設定なら undefined — GitHub 機能は不在のまま", () => {
    expect(loadGitHubAuth(undefined)).toBeUndefined();
  });

  it("ファイル不在なら undefined", () => {
    silenceWarn();
    expect(loadGitHubAuth("/no/such/secrets-file")).toBeUndefined();
  });

  it("mode 600 より広い権限のファイルは拒否する — secrets は盤面ユーザーだけが読める前提", async () => {
    silenceWarn();
    const file = await makeTokenFile("tok\n", 0o644);
    expect(loadGitHubAuth(file)).toBeUndefined();
  });

  it("stat は通るが read できないファイルも undefined — 起動クラッシュではなく fail-closed", async () => {
    silenceWarn();
    // mode 000: group/other ビットなしで mode 検査は通るが、所有者にも読めない
    const file = await makeTokenFile("tok\n", 0o000);
    expect(loadGitHubAuth(file)).toBeUndefined();
  });

  it("空ファイルは undefined — 空トークンで ambient 認証に落ちる事故を防ぐ", async () => {
    silenceWarn();
    const file = await makeTokenFile("\n", 0o600);
    expect(loadGitHubAuth(file)).toBeUndefined();
  });

  it("mode 600 のトークンファイルなら GitHubAuth を返し、末尾改行は落とす", async () => {
    const file = await makeTokenFile("ghp_secret\n", 0o600);
    const auth = loadGitHubAuth(file);
    expect(auth?.token()).toBe("ghp_secret");
  });
});

describe("GitHubAuth.env: per-call 注入(ADR 0024)", () => {
  it("子プロセス env にだけ GH_TOKEN を載せ、process.env は汚さない — worker が継承する側にトークンは存在しない", async () => {
    const file = await makeTokenFile("ghp_secret\n", 0o600);
    const auth = new GitHubAuth(file);

    const env = auth.env();

    expect(env.GH_TOKEN).toBe("ghp_secret");
    expect(env.PATH).toBe(process.env.PATH);
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it("トークンは呼び出しごとにファイルから読み直す — 差し替え(ローテーション)に再起動は要らない", async () => {
    const file = await makeTokenFile("old-token\n", 0o600);
    const auth = new GitHubAuth(file);
    expect(auth.env().GH_TOKEN).toBe("old-token");

    writeFileSync(file, "new-token\n");
    expect(auth.env().GH_TOKEN).toBe("new-token");
  });
});

describe("authedGit: 認証つき git 実行(ADR 0024 の唯一の注入経路)", () => {
  it("credential helper の上書き込みで push が通る(ローカル remote では helper は無害)", async () => {
    const remote = await makeDir("tidepool-remote-");
    git(remote, "init", "--bare", "-b", "main");
    const repo = await makeDir("tidepool-repo-");
    git(repo, "init", "-b", "main");
    writeFileSync(join(repo, "readme.md"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "initial");
    git(repo, "remote", "add", "origin", remote);

    const auth = new GitHubAuth(await makeTokenFile("tok\n", 0o600));
    authedGit(auth, repo, "push", "origin", "main");

    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "main"));
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it("clone も同じ経路で通る(workspace-create の clone モード)", async () => {
    const upstream = await makeDir("tidepool-upstream-");
    git(upstream, "init", "-b", "main");
    writeFileSync(join(upstream, "readme.md"), "hi\n");
    git(upstream, "add", "-A");
    git(upstream, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "initial");

    const base = await makeDir("tidepool-ws-base-");
    const auth = new GitHubAuth(await makeTokenFile("tok\n", 0o600));
    authedGit(auth, base, "clone", upstream, join(base, "ws"));

    expect(git(join(base, "ws"), "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
  });
});
