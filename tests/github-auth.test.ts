import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authedGitBounded,
  GIT_CREDENTIAL_ARGS,
  GIT_NETWORK_TIMEOUT_MS,
  GitHubAuth,
  githubLoggedIn,
  loadGitHubAuth,
  originRepo,
} from "../src/github-auth.js";
import { type FakeBroker, issuedToken, startFakeBroker } from "./fake-broker.js";
import { startDenyingHttpRemote } from "./git-http-remote.js";
import { git } from "./harness.js";
import { tempDir } from "./temp-dir.js";

const brokers: FakeBroker[] = [];
let savedGhToken: string | undefined;

async function makeTokenFile(token: string, mode: number): Promise<string> {
  const dir = await tempDir("tidepool-secrets-");
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
  vi.unstubAllEnvs();
  for (const broker of brokers.splice(0)) await broker.close();
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

    await auth.ensureToken("acme/one");
    await auth.ensureToken("acme/two");

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

  // ADR 0339 決定1: 子の env は継承ではなく組み立てる —— host の ambient な身元の経路を子に見せない
  it("子の env は組み立てたもので、process.env の askpass・ssh・git 設定・gh の host を運ばない(認証の有無で違うのは GH_TOKEN だけ)", async () => {
    for (const name of ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH_COMMAND", "GIT_CONFIG_PARAMETERS", "GH_HOST"]) {
      vi.stubEnv(name, "ambient");
    }
    const broker = await openBroker(() => issuedToken("inst", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await auth.ensureToken("acme/one");

    const built = auth.env(undefined);
    expect({ built, authed: auth.env("acme/one"), home: readdirSync(built.HOME!) }).toEqual({
      built: {
        PATH: process.env.PATH,
        HOME: expect.any(String),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "file:http:https",
      },
      authed: { ...built, GH_TOKEN: "inst" },
      home: [],
    });
  });

  it("長く走る盤面で tmp の掃除に子の HOME を消されても、次の呼び出しで作り直す", async () => {
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600));
    rmSync(auth.env(undefined).HOME!, { recursive: true });

    expect(existsSync(auth.env(undefined).HOME!)).toBe(true);
  });

  it("残り5分を切った token は撃ち直し、余裕のある token は撃ち直さない(タイマー無しの残余駆動)", async () => {
    const broker = await openBroker((request, index) =>
      // 最初の要求だけ「あと2分」で返す — 次の呼び出しはその場で撃ち直す
      issuedToken(`${request.repo}-${index}`, request.repo === "acme/expiring" ? 2 : 60),
    );
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);

    await auth.ensureToken("acme/expiring");
    await auth.ensureToken("acme/fresh");
    await auth.ensureToken("acme/expiring");
    await auth.ensureToken("acme/fresh");

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

    await auth.ensureToken("acme/one");
    writeFileSync(file, "new-user-token\n");
    await auth.ensureToken("acme/one");

    expect(broker.requests.map((r) => r.bearer)).toEqual(["old-user-token", "new-user-token"]);
  });

  it("repo を名指しできない呼び出し(非 GitHub の remote)は仲介を叩かず、token も載せない", async () => {
    const broker = await openBroker(() => issuedToken("inst", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);

    await auth.ensureToken(undefined);

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

    await expect(auth.ensureToken("acme/one")).rejects.toThrow(
      new RegExp(`acme/one \\(HTTP ${status}: ${(body as { error: string }).error}\\)`),
    );
  });

  it("接続が切られた / そもそも繋がらない場合も同じ到達失敗として投げる", async () => {
    const broker = await openBroker(() => ({ destroy: true }));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await expect(auth.ensureToken("acme/one")).rejects.toThrow(/could not be reached for acme\/one/);

    const refused = new GitHubAuth(
      await makeTokenFile("gho_user\n", 0o600),
      "http://127.0.0.1:1/",
    );
    await expect(refused.ensureToken("acme/one")).rejects.toThrow(/could not be reached for acme\/one/);
  });

  it("token / expires_at の欠けた応答は成功として扱わない", async () => {
    const broker = await openBroker(() => ({ body: { token: "inst" } }));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await expect(auth.ensureToken("acme/one")).rejects.toThrow(/invalid token response/);
  });
});

describe("originRepo: 呼び出し元 checkout の origin から repo を決める(ADR 0093)", () => {
  it("github.com の origin は owner/name に、非 GitHub と origin 無しは undefined になる", async () => {
    const repo = await tempDir("tidepool-repo-");
    git(repo, "init", "-b", "main");
    expect(originRepo(repo)).toBeUndefined();

    git(repo, "remote", "add", "origin", "https://github.com/acme/widget.git");
    expect(originRepo(repo)).toBe("acme/widget");

    git(repo, "remote", "set-url", "origin", "/srv/mirrors/widget.git");
    expect(originRepo(repo)).toBeUndefined();
    expect(originRepo("/no/such/checkout")).toBeUndefined();
  });
});

describe("authedGitBounded: 認証つき git 実行(ADR 0024 の唯一の注入経路)", () => {
  it("キャッシュ済みの installation token を子プロセスに渡し、ホストの helper を先に消す", async () => {
    const remote = await tempDir("tidepool-remote-");
    git(remote, "init", "--bare", "-b", "main");
    const repo = await tempDir("tidepool-repo-");
    git(repo, "init", "-b", "main");
    writeFileSync(join(repo, "readme.md"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "initial");
    git(repo, "remote", "add", "origin", remote);

    const broker = await openBroker(() => issuedToken("inst-token", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await auth.ensureToken("acme/widget");
    // ローカル remote では credential helper は無害(実物の git で通ることを見る)
    authedGitBounded(auth, repo, "acme/widget", GIT_NETWORK_TIMEOUT_MS, "push", "origin", "main");

    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "main"));
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it("repo を名指しできない呼び出しは素の git で走る — 非 GitHub の remote に credential を渡さない", async () => {
    const upstream = await tempDir("tidepool-upstream-");
    git(upstream, "init", "-b", "main");
    writeFileSync(join(upstream, "readme.md"), "hi\n");
    git(upstream, "add", "-A");
    git(upstream, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "initial");

    const base = await tempDir("tidepool-ws-base-");
    const broker = await openBroker(() => issuedToken("inst-token", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    authedGitBounded(auth, base, undefined, GIT_NETWORK_TIMEOUT_MS, "clone", upstream, join(base, "ws"));

    expect(git(join(base, "ws"), "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(broker.requests.length).toBe(0);
  });

  /** origin を持つだけの checkout。 */
  async function checkoutWithOrigin(origin: string): Promise<string> {
    const repo = await tempDir("tidepool-repo-");
    git(repo, "init", "-b", "main");
    git(repo, "remote", "add", "origin", origin);
    return repo;
  }

  /** 401 を返す loopback remote を origin に持つ checkout —— git が差し出した身元を remote 側の記録で見る。 */
  async function checkoutOfDenyingRemote(): Promise<{ repo: string; url: string; requests: () => Record<string, string>[] }> {
    const remote = await startDenyingHttpRemote();
    return { repo: await checkoutWithOrigin(remote.url), ...remote };
  }

  /** 呼ばれたら印を残して失敗するだけの実行ファイル —— 呼ばれなかったことを見る。 */
  function tripwire(dir: string, name: string): { path: string; tripped: () => boolean } {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\ntouch "${path}.called"\nexit 1\n`);
    chmodSync(path, 0o755);
    return { path, tripped: () => existsSync(`${path}.called`) };
  }

  // ADR 0339 決定4: 人間の checkout の ssh 綴りの origin は盤面の https に解決し、綴りの記録は変えない
  it.each([
    ["git@github.com:o/r.git", "https://github.com/o/r.git"],
    ["ssh://git@github.com/o/r", "https://github.com/o/r"],
  ])("ssh 綴りの GitHub origin %s は https の %s に書き換えて撃つ", async (origin, resolved) => {
    const repo = await checkoutWithOrigin(origin);

    expect({
      resolved: authedGitBounded(undefined, repo, undefined, GIT_NETWORK_TIMEOUT_MS, "ls-remote", "--get-url", "origin"),
      recorded: git(repo, "config", "remote.origin.url"),
    }).toEqual({ resolved, recorded: origin });
  });

  // ADR 0339 決定1: 転送の床 —— ssh 鍵という身元では網に出ない(checkout の core.sshCommand があっても)
  it("非 GitHub の ssh 綴りの remote は ssh を起こさずに止まる", async () => {
    const repo = await checkoutWithOrigin("git@example.com:o/r");
    const ssh = tripwire(repo, "fake-ssh");
    git(repo, "config", "core.sshCommand", ssh.path);

    expect(() => authedGitBounded(undefined, repo, undefined, GIT_NETWORK_TIMEOUT_MS, "ls-remote", "origin")).toThrow(
      /transport 'ssh' not allowed/,
    );
    expect(ssh.tripped()).toBe(false);
  });

  // ADR 0339 決定1(転送の床)/ #2801: checkout の insteadOf が https を ssh にしても床で止まり、人間が直す場所を文で名指す
  it("https を ssh へ書き換える checkout の insteadOf は ssh を撃たずに止まり、insteadOf と origin の綴りを確かめよと言う", async () => {
    const repo = await checkoutWithOrigin("https://github.com/o/r.git");
    git(repo, "config", "url.git@github.com:.insteadOf", "https://github.com/");

    expect(() => authedGitBounded(undefined, repo, undefined, GIT_NETWORK_TIMEOUT_MS, "fetch", "origin")).toThrow(
      `\`git fetch\` failed with \`transport 'ssh' not allowed\` (in ${repo}): the board reaches GitHub only over https as itself — check this checkout's \`url.*.insteadOf\` rules and the spelling of its origin`,
    );
  });

  // ADR 0339 決定1: VS Code が立てる GIT_ASKPASS は保存済みの GitHub 資格情報を答えうる
  it("process.env の GIT_ASKPASS は子に届かず、401 にも呼ばれない", async () => {
    const { repo, requests } = await checkoutOfDenyingRemote();
    const askpass = tripwire(repo, "askpass");
    vi.stubEnv("GIT_ASKPASS", askpass.path);

    expect(() => authedGitBounded(undefined, repo, undefined, GIT_NETWORK_TIMEOUT_MS, "fetch", "origin")).toThrow();
    expect({ askpass: askpass.tripped(), offered: requests().map((r) => r.authorization) }).toEqual({
      askpass: false,
      offered: [undefined],
    });
  });

  // GIT_TERMINAL_PROMPT=0 は askpass を止めない —— checkout の core.askPass は reset で消す
  it("checkout の core.askPass は 401 にも呼ばれない", async () => {
    const { repo, requests } = await checkoutOfDenyingRemote();
    const askpass = tripwire(repo, "askpass");
    git(repo, "config", "core.askPass", askpass.path);

    expect(() => authedGitBounded(undefined, repo, undefined, GIT_NETWORK_TIMEOUT_MS, "fetch", "origin")).toThrow();
    expect({ askpass: askpass.tripped(), offered: requests().map((r) => r.authorization) }).toEqual({
      askpass: false,
      offered: [undefined],
    });
  });

  it("host の HOME の ~/.netrc は子に届かず、Authorization を出さない", async () => {
    const { repo, requests } = await checkoutOfDenyingRemote();
    const hostHome = await tempDir("tidepool-home-");
    writeFileSync(join(hostHome, ".netrc"), "machine 127.0.0.1 login u password netrc-secret\n", { mode: 0o600 });
    vi.stubEnv("HOME", hostHome);

    expect(() => authedGitBounded(undefined, repo, undefined, GIT_NETWORK_TIMEOUT_MS, "fetch", "origin")).toThrow();
    expect(requests().map((r) => r.authorization)).toEqual([undefined]);
  });

  it("checkout の http.extraHeader は reset されて届かない", async () => {
    const { repo, requests } = await checkoutOfDenyingRemote();
    git(repo, "config", "http.extraHeader", "X-Leak: header-secret");

    expect(() => authedGitBounded(undefined, repo, undefined, GIT_NETWORK_TIMEOUT_MS, "fetch", "origin")).toThrow();
    expect(requests().map((r) => r["x-leak"])).toEqual([undefined]);
  });

  // ADR 0339 決定5: URL 付きの extraHeader は reset より特定度が高く勝つので、撃つ前に述語で拒む
  it("checkout の URL 付き http.<url>.extraHeader があれば撃たずに投げ、理由に key を載せる", async () => {
    const { repo, url, requests } = await checkoutOfDenyingRemote();
    git(repo, "config", `http.${url}.extraHeader`, "X-Leak: header-secret");

    expect(() => authedGitBounded(undefined, repo, undefined, GIT_NETWORK_TIMEOUT_MS, "fetch", "origin")).toThrow(
      `http.${url}.extraheader`,
    );
    expect(requests()).toEqual([]);
  });

  it("worktree 単位の設定にある URL 付き http.<url>.extraHeader も撃たずに投げる", async () => {
    const { repo, url, requests } = await checkoutOfDenyingRemote();
    git(repo, "config", "extensions.worktreeConfig", "true");
    git(repo, "config", "--worktree", `http.${url}.extraHeader`, "X-Leak: header-secret");

    expect(() => authedGitBounded(undefined, repo, undefined, GIT_NETWORK_TIMEOUT_MS, "fetch", "origin")).toThrow(
      `http.${url}.extraheader`,
    );
    expect(requests()).toEqual([]);
  });

  // ADR 0339 帰結: token は検証済みの TLS にだけ —— URL 付きの sslVerify は -c http.sslVerify=true に勝つ
  it("checkout の URL 付き http.<url>.sslVerify があれば撃たずに投げ、理由に key を載せる", async () => {
    const { repo, requests } = await checkoutOfDenyingRemote();
    git(repo, "config", "http.https://github.com/.sslVerify", "false");

    expect(() => authedGitBounded(undefined, repo, undefined, GIT_NETWORK_TIMEOUT_MS, "fetch", "origin")).toThrow(
      "http.https://github.com/.sslverify",
    );
    expect(requests()).toEqual([]);
  });

  // ADR 0339 決定3: 注入 helper は https の github.com にだけ token を答える
  it("注入 helper は https の github.com には token を答える", async () => {
    const broker = await openBroker(() => issuedToken("inst-token", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await auth.ensureToken("acme/widget");

    const answer = execFileSync("git", [...GIT_CREDENTIAL_ARGS, "credential", "fill"], {
      cwd: await tempDir("tidepool-cred-"),
      env: auth.env("acme/widget"),
      input: "protocol=https\nhost=github.com\n\n",
    }).toString();

    expect(answer).toContain("password=inst-token");
  });

  it("注入 helper は github.com 以外の host には token を答えない", async () => {
    const { repo, requests } = await checkoutOfDenyingRemote();
    const broker = await openBroker(() => issuedToken("inst-token", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await auth.ensureToken("acme/widget");

    expect(() => authedGitBounded(auth, repo, "acme/widget", GIT_NETWORK_TIMEOUT_MS, "fetch", "origin")).toThrow();
    expect(requests().map((r) => r.authorization)).toEqual([undefined]);
  });

  it("cwd が無い呼び出しは上限つきの面でも subcommand と在り処を名指して投げる(issue #2722)", async () => {
    const missing = join(await tempDir("tidepool-authed-"), "gone");
    const expected = `\`git fetch\` cannot run: the directory ${missing} does not exist`;

    expect(() => authedGitBounded(undefined, missing, undefined, GIT_NETWORK_TIMEOUT_MS, "fetch")).toThrow(expected);
  });
});
