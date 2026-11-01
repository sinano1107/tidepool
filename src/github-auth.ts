import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, rethrowNamingMissingCwd } from "./git.js";
import { parseGitHubRepo } from "./repo-access.js";

/** ADR 0093 (issue #392): the board's GitHub identity is the single GitHub App
 *  `tidepool`. The mode-600 file named by `TIDEPOOL_GITHUB_TOKEN_FILE` holds a
 *  device-flow **user** token; the board presents it to the token broker and
 *  gets back an **installation token scoped to one repository**, which is what
 *  the `gh`/`git` child process actually carries.
 *
 *  ADR 0024's seam is unchanged: the token is injected into each child's env at
 *  the moment of the call, never written to the board's own process.env —
 *  workers inherit that wholesale and hold zero GitHub credentials — and never
 *  committed to the registry. Every board-driven GitHub network call flows
 *  through this module: credentials take effect in exactly one place.
 *
 *  Acquisition and injection are **split** because acquisition is now a network
 *  round trip while injection must stay synchronous: ADR 0066 決定5 requires
 *  `publishWorkspace` to hold zero `await` between `remote add` and the registry
 *  commit. Callers `await ensureToken(repo)` first; `env(repo)` and the `authedGitBounded`
 *  helper then read the cache synchronously and fail closed when it is empty. */
export class GitHubAuth {
  /** `owner/name` → the installation token the broker minted for it. No timer:
   *  the expiry is checked at the moment of use (ADR 0093 決定6). */
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly tokenFile: string,
    private readonly brokerUrl: string = DEFAULT_GITHUB_BROKER_URL,
  ) {}

  /** The user token, read fresh on every call — re-login replaces the file and
   *  takes effect on the next broker request, without a board restart. */
  token(): string {
    return readFileSync(this.tokenFile, "utf8").trim();
  }

  /** The async half: make sure an installation token for `repo` is held and has
   *  more than 5 minutes left (ADR 0093 決定6 — residue-driven, no timer). A
   *  repo the board cannot name (`undefined`: no origin, or a non-GitHub
   *  remote) needs no token and asks for none.
   *
   *  Every failure — connection refused, timeout, 401 from a revoked user
   *  token, 5xx — throws, and the message carries the broker's status and error
   *  code so the quarantine reason a human reads names the cause. The shape is
   *  a git network failure's, so the existing fail-closed paths (registry
   *  reachability, workspace quarantine) catch it unchanged (ADR 0093 決定7). */
  async ensureToken(repo: string | undefined, { fresh = false } = {}): Promise<void> {
    if (repo === undefined) return;
    const held = this.tokens.get(repo);
    // `fresh` は扉(ADR 0067 決定2 の再検査)用: 持っている token を答えにしない
    if (!fresh && held && held.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return;
    let response: Response;
    try {
      response = await fetch(new URL("/token", this.brokerUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repo }),
        // the same limit the board's own git network calls carry: a broker that
        // black-holes must not outlast a GitHub that black-holes
        signal: AbortSignal.timeout(GIT_NETWORK_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`the GitHub token broker could not be reached for ${repo}: ${String(err)}`);
    }
    if (!response.ok) {
      throw new Error(
        `the GitHub token broker refused a token for ${repo} ` +
          `(HTTP ${response.status}: ${await brokerErrorCode(response)})`,
      );
    }
    const issued = await readIssuedToken(response, repo);
    this.tokens.set(repo, issued);
  }

  /** One child call's env: `githubChildEnv()` plus the installation token as
   *  GH_TOKEN. `gh` prefers GH_TOKEN over any keyring login, and
   *  GIT_CREDENTIAL_ARGS's helper echoes it back to git. process.env itself
   *  never holds a token.
   *
   *  **Synchronous**, so it serves only what `ensureToken` already put in the cache.
   *  An unexpired token is good enough here — the 5-minute margin belongs to
   *  acquisition, not to use. Nothing held means the caller skipped `ensureToken`
   *  (or the call outlived its token): throw, fail-closed, the same shape as a
   *  git network failure. */
  env(repo: string | undefined): NodeJS.ProcessEnv {
    const base = githubChildEnv();
    if (repo === undefined) return base;
    const held = this.tokens.get(repo);
    if (!held || held.expiresAt <= Date.now()) {
      throw new Error(`no unexpired GitHub installation token is held for ${repo}`);
    }
    return { ...base, GH_TOKEN: held.token };
  }
}

/** The env of every child the board sends to GitHub (git and `gh`), with or without an identity —
 *  only `GitHubAuth.env` adds GH_TOKEN. ADR 0339 決定1: built, never spread from process.env, so
 *  host git config, askpass, ssh settings and `~/.netrc` never reach the child. GIT_TERMINAL_PROMPT=0
 *  turns a bad token into a fast failure instead of a hung prompt. ADR 0339 帰結: `file:http` is in the
 *  transport allowlist for local-path remotes and loopback `git http-backend`. */
function githubChildEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: boardOwnedHome(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file:http:https",
  };
}

let home: string | undefined;

/** The children's HOME: a private (mkdtemp, mode 700) dir that starts empty and stays writable, since
 *  `gh` may write state there; the board reads nothing from it and only creates and removes its disposable
 *  repos under it (ADR 0339 決定5), and `clone` runs from it. A tmp cleaner deleting it under a long-running
 *  board gets a fresh one at the next call. */
function boardOwnedHome(): string {
  if (home === undefined || !existsSync(home)) home = mkdtempSync(join(tmpdir(), "tidepool-github-home-"));
  return home;
}

/** The official App's broker (ADR 0093 決定1). A public value, not a secret,
 *  and not one of the six board-behaviour keys — unset is the normal state.
 *  Forks override it with `TIDEPOOL_GITHUB_BROKER_URL`. */
const DEFAULT_GITHUB_BROKER_URL = "https://tidepool-token-broker.tidepool.workers.dev";

/** ADR 0093 決定6. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** The broker's JSON body, or null when there is none to read — an unreadable
 *  body and a wrong-shaped one are the same answer at both call sites below. */
async function brokerBody(response: Response): Promise<Record<string, unknown> | null> {
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

/** The broker answers every failure with `{ "error": <code> }` and no token
 *  material. */
async function brokerErrorCode(response: Response): Promise<string> {
  const code = (await brokerBody(response))?.error;
  return typeof code === "string" ? code : "unrecognised broker error";
}

async function readIssuedToken(
  response: Response,
  repo: string,
): Promise<{ token: string; expiresAt: number }> {
  const body = await brokerBody(response);
  const token = body?.token;
  const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
  if (typeof token !== "string" || token === "" || Number.isNaN(expiresAt)) {
    throw new Error(`the GitHub token broker returned an invalid token response for ${repo}`);
  }
  return { token, expiresAt };
}

/** The broker's key for a repo the caller already knows by URL or `owner/name`
 *  — `publish` and `clone` name their destination themselves, before any
 *  checkout with an `origin` exists. Non-GitHub → `undefined` → no token, no
 *  injection. */
export function repoKey(url: string | undefined): string | undefined {
  const ref = parseGitHubRepo(url);
  return ref && `${ref.owner}/${ref.name}`;
}

/** The repo a call made from `cwd` authenticates against: this checkout's
 *  `origin` (ADR 0093 — the installation token is per-repository, so the repo
 *  has to be named before the call). The raw configured value is read, not
 *  `remote get-url`, so a linked worktree — `commitToRegistry`'s landing dir —
 *  resolves through the shared config it actually pushes with.
 *
 *  No origin, not a git checkout, or a non-GitHub remote all read the same:
 *  `undefined`, and the call runs anonymously (ADR 0339 決定2). */
export function originRepo(cwd: string): string | undefined {
  try {
    return repoKey(checkoutOrigin(cwd, "config"));
  } catch {
    return undefined;
  }
}

/** The checkout's raw `remote.origin.url` — the value before any `insteadOf` (ADR 0339 決定4). */
function checkoutOrigin(cwd: string, verb: string): string {
  try {
    return execFileSync("git", ["config", "remote.origin.url"], { cwd, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (err) {
    if ((err as { status?: number }).status === 1) throw new Error(`\`git ${verb}\` has no origin to reach (in ${cwd})`);
    rethrowNamingMissingCwd(err, cwd, [verb]);
  }
}

/** ADR 0339 決定4: the URL the board goes out to, built from an origin value — GitHub in any spelling
 *  becomes the https URL the board's identity exists on, anything else is used as written. */
export function networkUrl(origin: string): string {
  const key = repoKey(origin);
  return key ? `https://github.com/${key}.git` : origin;
}

/** The inline helper serving the injected GH_TOKEN. ADR 0339 決定3: it
 *  answers only `protocol=https host=github.com`, so a checkout's `insteadOf` to another host never gets
 *  the token. The token stays in the child env, never on the command line where `ps` could read it. */
export const GIT_CREDENTIAL_ARGS = [
  "-c",
  'credential.helper=!f() { test "$1" = get || return 0; while read -r l; do case "$l" in protocol=https) p=1;; host=github.com) h=1;; esac; done; ' +
    'test "$p$h" = 11 || return 0; echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f',
] as const;

/** 盤面が GitHub へ出る往復の上限(ADR 0334 決定1): git は転送が止まった時間、`gh`・仲介は総時間として共有する。black-hole した
 *  接続を無界に待ってはならない —— 同期の呼び出し(git)なら実行の糸ごと止まり、ADR 0036 が復旧経路と定めた人間面まで
 *  応答しなくなる(fail-closed より悪い状態、containment.ts)。非同期の呼び出し(`gh`、仲介)なら poll が返らず止まる。
 *  timeout は「到達不能」= fail-closed 側に読む(ADR 0093 決定7: 仲介の不達は GitHub の不達と同じものとして扱う)。
 *
 *  他の probe(`CAPABILITY_PROBE_TIMEOUT_MS` = 5秒)より桁が大きいのは、あれが
 *  ローカルのバイナリを叩くのに対しこちらは実ネットワーク往復だからで、同じ数を
 *  共有すると正常な fetch を落とす。
 *
 *  registry と workspace の refresh、clone、publish・registry・着地の push、`gh` が**同じ1つの上限**を共有するのは、
 *  根拠がどれも「実ネットワーク往復を無界に待ってはならない」1つだから
 *  である —— 資源ごとに数を分けると、片方だけを動かしたときに理由のほうが割れる。 */
export const GIT_NETWORK_TIMEOUT_MS = 30_000;

/** Board-driven git network calls from a checkout (ADR 0339 決定4・5): they never run inside it. The URL is
 *  built from the checkout's origin value and the token is the one `await auth.ensureToken(originRepo(checkout))`
 *  cached; without an identity or a GitHub origin the call is anonymous (ADR 0339 決定2). Each call creates a
 *  disposable board-owned repo that borrows the checkout's objects read-only through `objects/info/alternates`
 *  and removes it at the end, success or failure. `args` are the verb's flags and refspecs — a push names
 *  `<sha>:<ref>`, since the board repo has no refs. `fetch` takes one want and brings it into the checkout's
 *  object store without writing any of its refs (hop2 is local, `git.ts`'s `run`). */
export function authedGitBounded(
  auth: GitHubAuth | undefined,
  checkout: string,
  timeoutMs: number,
  verb: "fetch" | "ls-remote" | "push",
  ...args: string[]
): string {
  const origin = checkoutOrigin(checkout, verb);
  const env = auth ? auth.env(repoKey(origin)) : githubChildEnv();
  const boardRepo = mkdtempSync(join(env.HOME!, "repo-"));
  try {
    execFileSync("git", ["init", "--quiet", "--bare", boardRepo], { env, stdio: ["ignore", "pipe", "pipe"] });
    // ADR 0339 退けた形: GIT_OBJECT_DIRECTORY で借りると、ref を持たない盤面 repo の gc が checkout の objects を全部消す
    const objects = git(checkout, "rev-parse", "--path-format=absolute", "--git-path", "objects");
    writeFileSync(join(boardRepo, "objects", "info", "alternates"), `${objects}\n`);
    const network = { env, boardRepo, where: checkout, timeoutMs, origin };
    if (verb !== "fetch") return networkGit(network, [verb, networkUrl(origin), ...args]);
    // ADR 0339 帰結: 空の盤面 repo は have を言えないので、checkout の写しの sha を交渉の tip に渡す
    const tips = git(checkout, "for-each-ref", "--format=%(objectname)", "refs/remotes/origin").split("\n").filter(Boolean);
    networkGit(network, ["fetch", "--quiet", ...tips.map((tip) => `--negotiation-tip=${tip}`), networkUrl(origin), `${args[0]}:refs/board/fetched`]);
    return git(checkout, "fetch", "--quiet", boardRepo, "refs/board/fetched");
  } finally {
    rmSync(boardRepo, { recursive: true, force: true });
  }
}

/** ADR 0339 決定5: `clone` runs from the board-owned HOME, so no checkout's config — not even a parent of
 *  `dir` — is read; the new checkout's origin is the URL the board built. */
export function authedClone(auth: GitHubAuth | undefined, source: string, dir: string, timeoutMs: number): void {
  const env = auth ? auth.env(repoKey(source)) : githubChildEnv();
  networkGit({ env, boardRepo: undefined, where: dir, timeoutMs, origin: source }, ["clone", "--quiet", networkUrl(source), dir]);
}

/** The one network child (ADR 0339 決定1): the board's own `-c` only — the injected helper, ADR 0334's stall
 *  detection, and no auto maintenance or gc (the `--detach` child they spawn would outlive the stall bound). */
function networkGit(
  call: { env: NodeJS.ProcessEnv; boardRepo: string | undefined; where: string; timeoutMs: number; origin: string },
  args: string[],
): string {
  const { env, boardRepo, where, timeoutMs, origin } = call;
  try {
    return execFileSync(
      "git",
      [
        ...(boardRepo ? [`--git-dir=${boardRepo}`] : []),
        ...(env.GH_TOKEN ? GIT_CREDENTIAL_ARGS : []),
        ...["-c", "http.lowSpeedLimit=1", "-c", `http.lowSpeedTime=${Math.ceil(timeoutMs / 1000)}`],
        ...["-c", "maintenance.auto=false", "-c", "gc.auto=0"],
        ...args,
      ],
      { cwd: boardRepo ?? env.HOME, env, stdio: ["ignore", "pipe", "pipe"] },
    )
      .toString()
      .trim();
  } catch (err) {
    // ADR 0334 決定4: 接続前の無音では curl 28 が無く、Operation too slow だけが出る。
    const stderr = (err as { stderr?: Buffer }).stderr?.toString();
    if (stderr?.includes("Operation too slow")) {
      throw new Error(`\`git ${args[0]}\` stalled: no bytes for ${Math.ceil(timeoutMs / 1000)} s (in ${where})`, { cause: err });
    }
    // ADR 0339 決定4: GitHub はどの綴りでも https に組むので、ssh が出る出所は非 GitHub の origin の値だけ
    if (stderr?.includes("transport 'ssh' not allowed")) {
      throw new Error(
        `\`git ${args[0]}\` failed with \`transport 'ssh' not allowed\` (in ${where}): the board reaches a remote only over https or a local path — ` +
          `the origin \`${origin}\` is an ssh remote outside GitHub`,
        { cause: err },
      );
    }
    // 理由は argv でなく stderr で言う —— argv は呼び出しごとに変わる盤面 repo の path と交渉の tip を持ち、同じ失敗を別の文にする
    throw new Error(`\`git ${args[0]}\` failed (in ${where}): ${stderr?.trim() || String(err)}`, { cause: err });
  }
}

/** The fail-closed checks on the user token file (issue #50, unchanged by ADR
 *  0093 決定4): no path configured, an unreadable or empty file, and
 *  permissions wider than 0600 all mean the board has no GitHub identity.
 *  Spelled once because two surfaces ask — `loadGitHubAuth` (which warns) and
 *  the settings screen's `loggedIn` (which must not). */
function tokenFileProblem(tokenFile: string): string | undefined {
  let mode: number;
  try {
    mode = statSync(tokenFile).mode;
  } catch {
    return `token file not readable — GitHub features off: ${tokenFile}`;
  }
  if ((mode & 0o077) !== 0) {
    return `token file must be mode 600 (is ${(mode & 0o777).toString(8)}) — GitHub features off: ${tokenFile}`;
  }
  // stat succeeding doesn't imply read access (it only needs the directory's
  // x bit — e.g. a root:root 600 file stats fine): prove the read here, or
  // the first per-call injection would crash the board instead of failing
  // closed
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    return `token file not readable — GitHub features off: ${tokenFile}`;
  }
  return token === "" ? `token file is empty — GitHub features off: ${tokenFile}` : undefined;
}

/** Whether the board is logged in to GitHub (ADR 0093 決定5): the user token
 *  file exists and passes every fail-closed check. Re-read per call, not
 *  cached from boot — `npm run github-login` writes the file while the board
 *  runs, and the settings screen has to show that without a restart. */
export function githubLoggedIn(tokenFile: string | undefined): boolean {
  return tokenFile !== undefined && tokenFileProblem(tokenFile) === undefined;
}

/** Resolves the board-config token path to a GitHubAuth, or undefined —
 *  fail-closed (issue #50), the same shape as the existing optional
 *  `deps.github`. */
export function loadGitHubAuth(
  tokenFile: string | undefined,
  brokerUrl?: string,
): GitHubAuth | undefined {
  if (!tokenFile) return undefined;
  const problem = tokenFileProblem(tokenFile);
  if (problem !== undefined) {
    console.warn(`[github-auth] ${problem}`);
    return undefined;
  }
  return new GitHubAuth(tokenFile, brokerUrl);
}
