import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authedClone,
  authedFetch,
  authedGitBounded,
  authedPush,
  GIT_CREDENTIAL_ARGS,
  GIT_NETWORK_TIMEOUT_MS,
  GitHubAuth,
  githubLoggedIn,
  loadGitHubAuth,
  originRepo,
} from "../src/github-auth.js";
import { type FakeBroker, issuedToken, startFakeBroker } from "./fake-broker.js";
import { startDenyingHttpRemote, startRecordingHttpRemote } from "./git-http-remote.js";
import { git, shimGit } from "./harness.js";
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

describe("authedGitBounded: 盤面の網に出る git(ADR 0024 の唯一の注入経路、ADR 0339)", () => {
  it("installation token を持つ盤面の push もローカル remote に届き、token は process.env に残らない", async () => {
    const { remote, repo } = await checkoutOfBareRemote();
    git(repo, "commit", "--allow-empty", "-m", "next");

    const broker = await openBroker(() => issuedToken("inst-token", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await auth.ensureToken("acme/widget");
    authedPush(auth, repo, GIT_NETWORK_TIMEOUT_MS, [["main", git(repo, "rev-parse", "HEAD")]]);

    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "main"));
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it("repo を名指しできない clone は素の git で走る — 非 GitHub の remote に credential を渡さない", async () => {
    const { remote } = await checkoutOfBareRemote();
    const base = await tempDir("tidepool-ws-base-");
    const broker = await openBroker(() => issuedToken("inst-token", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    authedClone(auth, remote, join(base, "ws"), GIT_NETWORK_TIMEOUT_MS);

    expect(git(join(base, "ws"), "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "main"));
    expect(broker.requests.length).toBe(0);
  });

  /** origin を持つだけの checkout。 */
  async function checkoutWithOrigin(origin: string): Promise<string> {
    const repo = await tempDir("tidepool-repo-");
    git(repo, "init", "-b", "main");
    git(repo, "remote", "add", "origin", origin);
    return repo;
  }

  /** 1 commit の main を持つ bare remote と、それを origin に持つ checkout。 */
  async function checkoutOfBareRemote(): Promise<{ remote: string; repo: string; sha: string }> {
    const remote = join(await tempDir("tidepool-remote-"), "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remote]);
    const repo = await checkoutWithOrigin(remote);
    writeFileSync(join(repo, "readme.md"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "initial");
    git(repo, "push", "origin", "main");
    return { remote, repo, sha: git(repo, "rev-parse", "HEAD") };
  }

  /** remote の main に別の clone から 1 commit 足す(= GitHub 上の merge)。足した sha を返す。 */
  async function commitOnRemote(remote: string): Promise<string> {
    const publisher = await tempDir("tidepool-publisher-");
    execFileSync("git", ["clone", "--quiet", remote, publisher]);
    git(publisher, "commit", "--allow-empty", "-m", "merged on remote");
    git(publisher, "push", "origin", "main");
    return git(publisher, "rev-parse", "HEAD");
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

  /** 盤面の子の HOME —— 盤面所有の repo はその下に作られ、呼び出しの終わりに消える。 */
  function boardHome(): string {
    return new GitHubAuth("/unused").env(undefined).HOME!;
  }

  // ADR 0339 決定4: 人間の checkout の ssh 綴りの origin は盤面の https に解決し、綴りの記録は変えない —— git が受けた URL を見る
  it.each([
    ["git@github.com:o/r.git", "https://github.com/o/r.git"],
    ["ssh://git@github.com/o/r", "https://github.com/o/r.git"],
    ["https://github.com/o/r", "https://github.com/o/r.git"],
    ["http://127.0.0.1:8080/o/r.git", "http://127.0.0.1:8080/o/r.git"],
    ["/srv/mirrors/r.git", "/srv/mirrors/r.git"],
  ])("origin の値 %s の checkout から、網に出る git は %s を受ける", async (origin, url) => {
    const repo = await checkoutWithOrigin(origin);
    const calls = await shimGit({ fake: ["ls-remote"] });

    authedGitBounded(undefined, repo, GIT_NETWORK_TIMEOUT_MS, "ls-remote", "refs/heads/main");

    const { args } = calls().find((call) => call.args.includes("ls-remote"))!;
    expect({ url: args[args.indexOf("ls-remote") + 1], recorded: git(repo, "config", "remote.origin.url") }).toEqual({ url, recorded: origin });
  });

  // 盤面所有の repo は checkout の外にあるので、相対 path の origin は checkout を起点に解いてから渡す
  it("非 GitHub の相対 path の origin は checkout を起点に解かれ、fetch が届く", async () => {
    const parent = await tempDir("tidepool-relative-");
    const remote = join(parent, "up.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remote]);
    const seed = await checkoutWithOrigin(remote);
    git(seed, "commit", "--allow-empty", "-m", "seed");
    git(seed, "push", "origin", "main");
    const repo = join(parent, "checkout");
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "remote", "add", "origin", "../up.git");
    const sha = git(remote, "rev-parse", "main");

    authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, sha);

    expect(git(repo, "cat-file", "-t", sha)).toBe("commit");
  });

  // ADR 0339 決定5: hop2 は網に出ない —— checkout の insteadOf が盤面 repo の path を http へ書き換えても、local の転送しか許さない
  it("checkout の insteadOf が盤面所有の repo の path を http へ向けても、hop2 は網に出ない", async () => {
    const { remote, repo } = await checkoutOfBareRemote();
    const merged = await commitOnRemote(remote);
    const decoy = await startDenyingHttpRemote();
    git(repo, "config", `url.${decoy.url}/.insteadOf`, `${boardHome()}/`);
    vi.stubEnv("GIT_TERMINAL_PROMPT", "0");

    expect(() => authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, merged)).toThrow();
    expect(decoy.requests()).toEqual([]);
  });

  // ADR 0339 決定4・5: 網に出る git は checkout の中で走らず、URL は盤面が組む —— checkout の config は身元も経路も運ばない
  it("checkout の cookieFile・include・extraHeader・insteadOf・pushurl があっても、fetch / ls-remote / push は盤面が組んだ URL に Cookie 無しで届く", async () => {
    const { remote, repo } = await checkoutOfBareRemote();
    const merged = await commitOnRemote(remote);
    const reached = await startRecordingHttpRemote(remote);
    const decoy = await startDenyingHttpRemote();
    git(repo, "remote", "set-url", "origin", reached.url);
    const cookies = join(await tempDir("tidepool-cookies-"), "cookies.txt");
    writeFileSync(cookies, "127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\tcookie-secret\n");
    const included = join(await tempDir("tidepool-include-"), "host.gitconfig");
    writeFileSync(included, `[http]\n\tcookieFile = ${cookies}\n`);
    git(repo, "config", "http.cookieFile", cookies);
    git(repo, "config", "include.path", included);
    git(repo, "config", "http.extraHeader", "X-Leak: header-secret");
    git(repo, "config", `http.${reached.url}.extraHeader`, "X-Leak: header-secret");
    git(repo, "config", `url.${decoy.url}.insteadOf`, reached.url);
    git(repo, "config", "remote.origin.pushurl", decoy.url);
    git(repo, "commit", "--allow-empty", "-m", "topic");
    const topic = git(repo, "rev-parse", "HEAD");

    authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, merged);
    authedGitBounded(undefined, repo, GIT_NETWORK_TIMEOUT_MS, "ls-remote", "refs/heads/main");
    authedPush(undefined, repo, GIT_NETWORK_TIMEOUT_MS, [["topic", topic]]);

    const requests = reached.requests();
    expect({
      pushed: git(remote, "rev-parse", "topic"),
      decoy: decoy.requests(),
      verbs: [...new Set(requests.map((r) => r.path.split("/").pop()))].sort(),
      leaked: requests.filter((r) => r.headers.cookie !== undefined || r.headers["x-leak"] !== undefined),
    }).toEqual({ pushed: topic, decoy: [], verbs: ["git-receive-pack", "git-upload-pack", "refs"], leaked: [] });
  });

  // ADR 0339 決定5: fetch は盤面所有の repo の refs/board/fetched に落ち、checkout は local に取る(hop2)
  it("fetch の後、want した commit は checkout の object store にあり、checkout の ref は動かない", async () => {
    const { remote, repo } = await checkoutOfBareRemote();
    const merged = await commitOnRemote(remote);
    const refs = git(repo, "for-each-ref");

    authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, merged);

    expect({ type: git(repo, "cat-file", "-t", merged), refs: git(repo, "for-each-ref") }).toEqual({ type: "commit", refs });
  });

  // ADR 0339 帰結: 空の盤面 repo は have を言えない —— checkout の写しの sha を交渉の tip に渡さなければ、1 commit の fetch が全履歴を受ける
  it("200 commit の履歴に 1 commit 増えた fetch の upload-pack 応答は、全履歴の pack の 10% 未満", async () => {
    const remote = join(await tempDir("tidepool-remote-"), "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remote]);
    const stream = Array.from({ length: 200 }, (_, i) => {
      const body = `${randomBytes(1024).toString("hex")}\n`;
      return `commit refs/heads/main\ncommitter t <t@example.com> ${1_700_000_000 + i} +0000\ndata 2\nc\nM 644 inline file.txt\ndata ${body.length}\n${body}`;
    }).join("");
    execFileSync("git", ["fast-import", "--quiet"], { cwd: remote, input: stream });
    const repo = await tempDir("tidepool-repo-");
    execFileSync("git", ["clone", "--quiet", remote, repo]);
    const merged = await commitOnRemote(remote);
    const reached = await startRecordingHttpRemote(remote);
    git(repo, "remote", "set-url", "origin", reached.url);
    const empty = await checkoutWithOrigin(reached.url);
    const packBytes = (from: number) =>
      reached.requests().slice(from).filter((r) => r.path.endsWith("/git-upload-pack")).reduce((sum, r) => sum + r.bytes, 0);

    authedFetch(undefined, empty, GIT_NETWORK_TIMEOUT_MS, merged);
    const seen = reached.requests().length;
    authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, merged);

    const [whole, incremental] = [packBytes(0) - packBytes(seen), packBytes(seen)];
    expect({ whole: whole > 200 * 1024, ratio: incremental / whole < 0.1 }).toEqual({ whole: true, ratio: true });
  }, 20_000);

  it("fetch / ls-remote / push は成功でも失敗でも盤面所有の repo を残さない", async () => {
    const { repo, sha } = await checkoutOfBareRemote();
    // 全 0 の oid は push では「消す」と読まれるので、どこにも無い別の oid を使う
    const missing = "1".repeat(40);

    authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, sha);
    authedGitBounded(undefined, repo, GIT_NETWORK_TIMEOUT_MS, "ls-remote", "refs/heads/main");
    authedPush(undefined, repo, GIT_NETWORK_TIMEOUT_MS, [["copy", sha]]);
    expect(() => authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, missing)).toThrow();
    expect(() => authedPush(undefined, repo, GIT_NETWORK_TIMEOUT_MS, [["copy", missing]])).toThrow();
    git(repo, "remote", "set-url", "origin", (await startDenyingHttpRemote()).url);
    expect(() => authedGitBounded(undefined, repo, GIT_NETWORK_TIMEOUT_MS, "ls-remote", "refs/heads/main")).toThrow();

    expect(readdirSync(boardHome())).toEqual([]);
  });

  // ADR 0339 決定1・5: GIT_OBJECT_DIRECTORY で借りると盤面 repo の gc が checkout の objects を消す。fetch が起こす auto maintenance は上限の外に出る
  it("盤面所有の repo は alternates で checkout の objects を借り、GIT_OBJECT_DIRECTORY を使わず、hop1 の fetch は写しの sha を交渉の tip に渡し auto maintenance と gc を止める", async () => {
    const { repo, sha } = await checkoutOfBareRemote();
    const calls = await shimGit();

    authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, sha);

    const hop1 = calls().find(({ args }) => args.some((a) => a.startsWith("--git-dir=")) && args.includes("fetch"))!;
    const flags = hop1.args.join(" ");
    expect({
      alternates: realpathSync(hop1.alternates!),
      objectDirectory: calls().map((c) => c.env.GIT_OBJECT_DIRECTORY).filter(Boolean),
      tips: hop1.args.filter((a) => a.startsWith("--negotiation-tip=")),
      maintenance: flags.includes("-c maintenance.auto=false"),
      gc: flags.includes("-c gc.auto=0"),
    }).toEqual({
      alternates: realpathSync(join(repo, ".git", "objects")),
      objectDirectory: [],
      tips: [`--negotiation-tip=${sha}`],
      maintenance: true,
      gc: true,
    });
  });

  // ADR 0339 決定1: 転送の床 —— ssh 鍵という身元では網に出ない(checkout の core.sshCommand があっても)
  it("非 GitHub の ssh 綴りの remote は ssh を起こさずに止まる", async () => {
    const repo = await checkoutWithOrigin("git@example.com:o/r");
    const ssh = tripwire(repo, "fake-ssh");
    git(repo, "config", "core.sshCommand", ssh.path);

    expect(() => authedGitBounded(undefined, repo, GIT_NETWORK_TIMEOUT_MS, "ls-remote", "refs/heads/main")).toThrow(
      /transport 'ssh' not allowed/,
    );
    expect(ssh.tripped()).toBe(false);
  });

  // ADR 0339 決定4: insteadOf はもう読まれない —— ssh が出る出所は非 GitHub の origin の値だけなので、文はその値を名指す
  it("非 GitHub の ssh origin で止まった文は、人間が直す origin の値を名指す", async () => {
    const repo = await checkoutWithOrigin("git@example.com:o/r");

    expect(() => authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, "main")).toThrow(
      `\`git fetch\` failed with \`transport 'ssh' not allowed\` (in ${repo}): the board reaches a remote only over https or a local path — ` +
        "the origin `git@example.com:o/r` is an ssh remote outside GitHub",
    );
  });

  // ADR 0339 決定1: VS Code が立てる GIT_ASKPASS は保存済みの GitHub 資格情報を答えうる
  it("process.env の GIT_ASKPASS は子に届かず、401 にも呼ばれない", async () => {
    const { repo, requests } = await checkoutOfDenyingRemote();
    const askpass = tripwire(repo, "askpass");
    vi.stubEnv("GIT_ASKPASS", askpass.path);

    expect(() => authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, "main")).toThrow();
    expect({ askpass: askpass.tripped(), offered: requests().map((r) => r.authorization) }).toEqual({
      askpass: false,
      offered: [undefined],
    });
  });

  // GIT_TERMINAL_PROMPT=0 は askpass を止めない —— checkout の core.askPass は、網に出る git が checkout の config を読まないので届かない
  it("checkout の core.askPass は 401 にも呼ばれない", async () => {
    const { repo, requests } = await checkoutOfDenyingRemote();
    const askpass = tripwire(repo, "askpass");
    git(repo, "config", "core.askPass", askpass.path);

    expect(() => authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, "main")).toThrow();
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

    expect(() => authedFetch(undefined, repo, GIT_NETWORK_TIMEOUT_MS, "main")).toThrow();
    expect(requests().map((r) => r.authorization)).toEqual([undefined]);
  });

  // ADR 0339 決定3: 注入 helper は https の github.com にだけ token を答える
  it.each([
    ["https の github.com", "github.com", true],
    ["github.com 以外の host", "127.0.0.1", false],
  ])("注入 helper は %s に token を答えるか", async (_name, host, answers) => {
    const broker = await openBroker(() => issuedToken("inst-token", 60));
    const auth = new GitHubAuth(await makeTokenFile("gho_user\n", 0o600), broker.url);
    await auth.ensureToken("acme/widget");

    // 答えが無ければ GIT_TERMINAL_PROMPT=0 の fill は非ゼロで終わる —— stdout だけを見る
    const { stdout } = spawnSync("git", [...GIT_CREDENTIAL_ARGS, "credential", "fill"], {
      cwd: await tempDir("tidepool-cred-"),
      env: auth.env("acme/widget"),
      input: `protocol=https\nhost=${host}\n\n`,
    });

    expect(stdout.toString().includes("password=inst-token")).toBe(answers);
  });

  it("cwd が無い呼び出しは上限つきの面でも subcommand と在り処を名指して投げる(issue #2722)", async () => {
    const missing = join(await tempDir("tidepool-authed-"), "gone");
    const expected = `\`git fetch\` cannot run: the directory ${missing} does not exist`;

    expect(() => authedFetch(undefined, missing, GIT_NETWORK_TIMEOUT_MS, "main")).toThrow(expected);
  });
});
