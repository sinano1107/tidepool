import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authedGit,
  GitHubAuth,
  githubLoggedIn,
  loadGitHubAuth,
  originRepo,
} from "../src/github-auth.js";
import { type FakeBroker, issuedToken, startFakeBroker } from "./fake-broker.js";
import { git } from "./harness.js";

const dirs: string[] = [];
const brokers: FakeBroker[] = [];
let savedGhToken: string | undefined;

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
  vi.restoreAllMocks();
  for (const broker of brokers.splice(0)) await broker.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 立てた仲介は afterEach で必ず閉じる。 */
async function openBroker(reply: Parameters<typeof startFakeBroker>[0]): Promise<FakeBroker> {
  const started = await startFakeBroker(reply);
  brokers.push(started);
  return started;
}

/** 各 fail-closed ケースは戻り値(undefined = GitHub 身元なし)だけを断言
 *  する — 警告はここでは黙らせるだけ(console を汚さない)。 */
function silenceWarn(): void {
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("loadGitHubAuth: fail-closed(issue #50 完了基準、ADR 0093 決定4 でも据え置き)", () => {
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
    if (process.getuid && process.getuid() === 0) {
      return;
    }
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
    const file = await makeTokenFile("gho_user_token\n", 0o600);
    const auth = loadGitHubAuth(file);
    expect(auth?.token()).toBe("gho_user_token");
  });
});

/** ADR 0093 決定5 の settings 表示が読む述語。`loadGitHubAuth` と**同じ**検査を
 *  共有していることが要点である —— 別々に綴ると「ログイン済みと出ているのに
 *  GitHub 機能は不在」がありうる。 */
describe("githubLoggedIn: settings が読むログイン状態", () => {
  it("ファイルの有無で切り替わり、盤面の再起動を要さない", async () => {
    const file = await makeTokenFile("gho_user_token\n", 0o600);
    expect(githubLoggedIn(file)).toBe(true);
    expect(githubLoggedIn(undefined)).toBe(false);
    expect(githubLoggedIn(join(file, "..", "absent"))).toBe(false);
  });

  it("mode が 600 より広ければ未ログイン扱い — fail-closed の線と一致する", async () => {
    expect(githubLoggedIn(await makeTokenFile("gho_user_token\n", 0o644))).toBe(false);
  });
});

describe("GitHubAuth: 仲介経由の installation token(ADR 0093 決定2/6)", () => {
  it("repo ごとに別の token を取り、子プロセス env の GH_TOKEN に載せる — process.env は汚さない", async () => {
    const broker = await openBroker((request) => issuedToken(`inst-${request.repo}`, 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);

    await auth.ensure("acme/one");
    await auth.ensure("acme/two");

    expect({
      one: auth.env("acme/one").GH_TOKEN,
      two: auth.env("acme/two").GH_TOKEN,
      asked: broker.requests.map((r) => r.repo),
      bearer: broker.requests[0]?.bearer,
      leaked: process.env.GH_TOKEN,
      noPrompt: auth.env("acme/one").GIT_TERMINAL_PROMPT,
    }).toEqual({
      one: "inst-acme/one",
      two: "inst-acme/two",
      asked: ["acme/one", "acme/two"],
      bearer: "gho_user",
      leaked: undefined,
      noPrompt: "0",
    });
  });

  it("残り5分を切った token は撃ち直し、余裕のある token は撃ち直さない(タイマー無しの残余駆動)", async () => {
    const broker = await openBroker((request, index) =>
      // 最初の要求だけ「あと2分」で返す — 次の呼び出しはその場で撃ち直す
      issuedToken(`${request.repo}-${index}`, request.repo === "acme/expiring" ? 2 : 60),
    );
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);

    await auth.ensure("acme/expiring");
    await auth.ensure("acme/fresh");
    await auth.ensure("acme/expiring");
    await auth.ensure("acme/fresh");

    expect(broker.requests.map((r) => r.repo)).toEqual([
      "acme/expiring",
      "acme/fresh",
      "acme/expiring",
    ]);
  });

  it("user token ファイルを差し替えると次の要求から新しい bearer が飛ぶ — 再ログインに再起動は要らない", async () => {
    const broker = await openBroker(() => issuedToken("inst", 0));
    const file = await makeTokenFile("old-user-token\n", 0o600);
    const auth = new GitHubAuth(file, broker.url);

    await auth.ensure("acme/one");
    writeFileSync(file, "new-user-token\n");
    await auth.ensure("acme/one");

    expect(broker.requests.map((r) => r.bearer)).toEqual(["old-user-token", "new-user-token"]);
  });

  it("repo を名指しできない呼び出し(非 GitHub の remote)は仲介を叩かず、token も載せない", async () => {
    const broker = await openBroker(() => issuedToken("inst", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);

    await auth.ensure(undefined);

    expect({ asked: broker.requests.length, token: auth.env(undefined).GH_TOKEN }).toEqual({
      asked: 0,
      token: undefined,
    });
  });

  it("ensure を通っていない repo の env は投げる — 同期の注入は fail-closed(ADR 0066 決定5)", async () => {
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600));

    expect(() => auth.env("acme/one")).toThrow(/no unexpired GitHub installation token/);
  });

  // ADR 0093 決定7: 仲介の不達も user token の失効も「GitHub が遠い」1つの症状に
  // 畳む —— 新しい語彙を盤面側に足さないための線であり、既存の fail-closed
  // (registry reachability / workspace quarantine)がそのまま受ける。timeout は
  // 接続断と同じ catch 節に落ちる(`AbortSignal.timeout`)ので個別には撃たない。
  it.each([
    ["失効した user token(401)", 401, { error: "invalid_user_token" }],
    ["push を持たない(403)", 403, { error: "push_denied" }],
    ["App 未 install / 不可視(404)", 404, { error: "repo_unreachable" }],
    ["GitHub 側の障害(502)", 502, { error: "github_error" }],
  ])("仲介の %s は到達失敗として投げ、理由に status と code を載せる", async (_name, status, body) => {
    const broker = await openBroker(() => ({ status, body }));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);

    await expect(auth.ensure("acme/one")).rejects.toThrow(
      new RegExp(`acme/one \\(HTTP ${status}: ${(body as { error: string }).error}\\)`),
    );
  });

  it("接続が切られた / そもそも繋がらない場合も同じ到達失敗として投げる", async () => {
    const broker = await openBroker(() => ({ destroy: true }));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await expect(auth.ensure("acme/one")).rejects.toThrow(/could not be reached for acme\/one/);

    const refused = new GitHubAuth(
      await makeTokenFile("gho_user\n", 0o600),
      "http://127.0.0.1:1/",
    );
    await expect(refused.ensure("acme/one")).rejects.toThrow(/could not be reached for acme\/one/);
  });

  it("token / expires_at の欠けた応答は成功として扱わない", async () => {
    const broker = await openBroker(() => ({ body: { token: "inst" } }));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await expect(auth.ensure("acme/one")).rejects.toThrow(/invalid token response/);
  });
});

describe("originRepo: 呼び出し元 checkout の origin から repo を決める(ADR 0093)", () => {
  it("github.com の origin は owner/name に、非 GitHub と origin 無しは undefined になる", async () => {
    const repo = await makeDir("tidepool-repo-");
    git(repo, "init", "-b", "main");
    expect(originRepo(repo)).toBeUndefined();

    git(repo, "remote", "add", "origin", "https://github.com/acme/widget.git");
    expect(originRepo(repo)).toBe("acme/widget");

    git(repo, "remote", "set-url", "origin", "/srv/mirrors/widget.git");
    expect(originRepo(repo)).toBeUndefined();
    expect(originRepo("/no/such/checkout")).toBeUndefined();
  });
});

describe("authedGit: 認証つき git 実行(ADR 0024 の唯一の注入経路)", () => {
  it("キャッシュ済みの installation token を子プロセスに渡し、ホストの helper を先に消す", async () => {
    const remote = await makeDir("tidepool-remote-");
    git(remote, "init", "--bare", "-b", "main");
    const repo = await makeDir("tidepool-repo-");
    git(repo, "init", "-b", "main");
    writeFileSync(join(repo, "readme.md"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "initial");
    git(repo, "remote", "add", "origin", remote);

    const broker = await openBroker(() => issuedToken("inst-token", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await auth.ensure("acme/widget");
    // ローカル remote では credential helper は無害(実物の git で通ることを見る)
    authedGit(auth, repo, "acme/widget", "push", "origin", "main");

    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "main"));
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it("repo を名指しできない呼び出しは素の git で走る — 非 GitHub の remote に credential を渡さない", async () => {
    const upstream = await makeDir("tidepool-upstream-");
    git(upstream, "init", "-b", "main");
    writeFileSync(join(upstream, "readme.md"), "hi\n");
    git(upstream, "add", "-A");
    git(upstream, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "initial");

    const base = await makeDir("tidepool-ws-base-");
    const broker = await openBroker(() => issuedToken("inst-token", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    authedGit(auth, base, undefined, "clone", upstream, join(base, "ws"));

    expect(git(join(base, "ws"), "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(broker.requests.length).toBe(0);
  });
});
