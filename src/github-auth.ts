import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { git, localGitEnv, readOriginConfig, rethrowNamingMissingCwd } from "./git.js";
import type { RepoSlug } from "./github.js";
import { parseGitHubRepo, repositoryLabel, sameRepository } from "./repo-access.js";
import type { WorkspaceConfig } from "./workspace.js";

/** ADR 0093 (issue #392): the board's GitHub identity is the single GitHub App
 *  `tidepool`. The mode-600 file named by `TIDEPOOL_GITHUB_TOKEN_FILE` holds a
 *  device-flow **user** token; the board presents it to the token broker and
 *  gets back an **installation token scoped to one repository**, which is what
 *  the `gh`/`git` child process actually carries.
 *
 *  ADR 0024's seam is unchanged: the token is injected into each child's env at
 *  the moment of the call, never written to the board's own process.env —
 *  which the `/usage` scrape still inherits (outside ADR 0358 決定1); workers
 *  hold zero GitHub credentials — and never committed to the registry. Every
 *  board-driven GitHub network call flows through this module, with two
 *  exceptions that call GitHub with `fetch` directly: opening a PR, which
 *  `github.ts` sends in process with the user token (ADR 0396 決定3), and the
 *  device-flow login in `github-login.ts`, which obtains that user token.
 *
 *  Acquisition and injection are **split** because acquisition is now a network
 *  round trip while injection must stay synchronous: ADR 0066 決定5 requires
 *  `publishWorkspace` to hold zero `await` between `remote add` and the registry
 *  commit. Callers `await ensureToken(repo)` first; `env(repo)` and the authenticated Git
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
  return githubKey(parseGitHubRepo(url));
}

/** GitHub's `owner/name` for a parsed repository. */
export function githubKey(ref: RepoSlug): string;
export function githubKey(ref: RepoSlug | undefined): string | undefined;
export function githubKey(ref: RepoSlug | undefined): string | undefined {
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
  return repoKey(originValue(cwd));
}

/** The checkout's raw `remote.origin.url` — the value before any `insteadOf` (ADR 0339 決定4), read as the registry's
 *  network calls read it. `undefined` with no origin or outside a checkout. */
export function originValue(cwd: string): string | undefined {
  try {
    return checkoutOrigin(cwd, "config");
  } catch {
    return undefined;
  }
}

/** `originValue` for a network call: no origin, or a missing `cwd`, throws naming `verb`. */
function checkoutOrigin(cwd: string, verb: string): string {
  try {
    const origin = readOriginConfig((args) =>
      execFileSync("git", args, { cwd, env: localGitEnv(), stdio: ["ignore", "pipe", "pipe"] }),
    );
    if (origin === undefined) throw new Error(`\`git ${verb}\` has no origin to reach (in ${cwd})`);
    return origin.trim();
  } catch (err) {
    rethrowNamingMissingCwd(err, cwd, [verb]);
  }
}

/** A non-GitHub value naming a local repository by a relative path. The board's network git runs outside the
 *  checkout and `clone` from the board-owned HOME (ADR 0339 決定5), so such a path would resolve somewhere else.
 *  URLs and scp spellings put a `:` before the first `/`. */
export function isRelativeLocalPath(value: string): boolean {
  return repoKey(value) === undefined && !isAbsolute(value) && !/^[^/]*:/.test(value);
}

/** ADR 0339 決定4: GitHub in any spelling becomes the
 *  https URL the board's identity exists on; a relative local path is resolved against `base`, where git itself would
 *  have resolved it; anything else is used as written. */
export function networkDestination(source: string, base: string) {
  const github = parseGitHubRepo(source);
  const key = githubKey(github);
  const url = key ? `https://github.com/${key}.git` : isRelativeLocalPath(source) ? resolve(base, source) : source;
  return { github, key, url, source };
}

/** ADR 0378 決定1: use the declaration even when Git runs from a task checkout, which has no origin of its own. */
export function workspaceNetworkDestination(workspace: WorkspaceConfig & { namedPlace?: WorkspaceConfig }) {
  return declaredDestination(workspace, "repo");
}

/** ADR 0378 決定1 / ADR 0395 決定1・2: the head repo's destination also comes from the rechecked declaration, never from the
 *  checkout's remote. */
export function workspaceHeadRepoDestination(workspace: WorkspaceConfig & { namedPlace?: WorkspaceConfig }) {
  return declaredDestination(workspace, "head_repo");
}

/** The destination `field` of the rechecked declaration (ADR 0378 決定7). A read that reaches one compares the record of the task it
 *  carries first (ADR 0399 決定3); a purely-local declaration reaches no network and compares nothing. */
function declaredDestination(workspace: WorkspaceConfig & { namedPlace?: WorkspaceConfig }, field: "repo" | "head_repo") {
  const place = workspace.namedPlace ?? workspace;
  const declaration = place.checkRememberedRepo?.(place) ?? place;
  const value = declaration[field];
  if (value === undefined) return undefined;
  place.checkDestination?.({ ...declaration, name: place.name });
  return networkDestination(value, declaration.path);
}

/** ADR 0395 決定1・2: a landing uses the same fork from observation through push and PR creation. */
export function landingHeadRepo(workspace: WorkspaceConfig) {
  const destination = workspaceHeadRepoDestination(workspace);
  if (destination === undefined) {
    throw new Error(`workspace ${workspace.name} has no declared head repo (head_repo). Set its fork in workspace settings to land task branches.`);
  }
  if (!sameRepository(workspace.head_repo, destination.source)) {
    throw new Error(`workspace ${workspace.name}'s head repo changed to ${repositoryLabel(destination.source)} during landing. Retry with the current workspace settings.`);
  }
  return destination;
}

/** A workspace declaration or the path of the board's registry checkout (ADR 0378 決定1・2). */
export type GitSource = WorkspaceConfig | string;

/** The checkout a source's Git runs in. */
export function sourceCheckout(source: GitSource): string {
  return typeof source === "string" ? source : source.path;
}

/** リモート側のブランチを指す remote-tracking ref(写し)の**綴り**。ADR 0052 のもとで「リモートの正本を読む」は registry の役
 *  (`registryRef` の下)と workspace の役(`protectedBranchRef`)の2箇所に現れる。出元 repo へ送ったタスクブランチの写しは
 *  `remote` に head repo の remote を渡した `refs/remotes/head-repo/task/*`(ADR 0395 決定1)。書くのは push の後の `authedPush` と
 *  `fetchBranchCopy` —— 綴りそのものは1つでなければならない(2つ持つと、片方だけを直したときに黙ってずれる)。どちらの ref を
 *  読むかの判断は各役の宣言が持ち、ここは綴りだけを持つ。 */
export function remoteTrackingRef(branch: string, remote: GitRemote = "origin"): string {
  return `refs/remotes/${remote}/${branch}`;
}

/** The checkout's remote for the PR head repo (ADR 0395 決定2). */
export const HEAD_REPO_REMOTE = "head-repo";

/** Which declared repo an operation reaches (ADR 0395 決定1). */
export type GitRemote = "origin" | typeof HEAD_REPO_REMOTE;

/** The inline helper serving the injected GH_TOKEN. ADR 0339 決定3: it answers only `protocol=https host=github.com`,
 *  so the token goes out only to the https URL the board built for a GitHub origin (決定4) and never to a non-GitHub
 *  URL, which a GitHub origin cannot become. The token stays in the child env, never on the command line where `ps`
 *  could read it. */
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

/** One network child's surroundings: its built env, the board repo it runs in (none for `clone`), the place a human
 *  reads in the error, the stall bound, and the origin value the URL was built from. */
type AuthedCall = { env: NodeJS.ProcessEnv; boardRepo: string | undefined; where: string; timeoutMs: number; origin: string; remote?: GitRemote };

/** ADR 0339 決定5: a network call from a checkout never runs inside it. One disposable board-owned repo per call
 *  (`--git-dir`, never env) borrows the checkout's objects read-only through `objects/info/alternates`, and is
 *  removed at the end, success or failure. The caller warms the repo-scoped token before the call. */
function inBoardRepo<T>(
  auth: GitHubAuth | undefined,
  source: GitSource,
  timeoutMs: number,
  verb: string,
  run: (call: AuthedCall & { boardRepo: string }, url: string) => T,
  remote: GitRemote = "origin",
): T {
  const checkout = sourceCheckout(source);
  // a registry checkout (a string source) has no head repo: it reaches no destination rather than origin under head-repo copies
  const destination = typeof source !== "string"
    ? remote === "origin" ? workspaceNetworkDestination(source) : landingHeadRepo(source)
    : remote === "origin" ? networkDestination(checkoutOrigin(source, verb), source) : undefined;
  if (destination === undefined) throw new Error(`\`git ${verb}\` has no declared repo to reach (in ${checkout})`);
  const env = auth ? auth.env(destination.key) : githubChildEnv();
  const boardRepo = mkdtempSync(join(env.HOME!, "repo-"));
  try {
    execFileSync("git", ["init", "--quiet", "--bare", boardRepo], { env, stdio: ["ignore", "pipe", "pipe"] });
    // ADR 0339 退けた形: GIT_OBJECT_DIRECTORY で借りると、ref を持たない盤面 repo の gc が checkout の objects を全部消す
    const objects = git(checkout, "rev-parse", "--path-format=absolute", "--git-path", "objects");
    writeFileSync(join(boardRepo, "objects", "info", "alternates"), `${objects}\n`);
    return run({ env, boardRepo, where: checkout, timeoutMs, origin: destination.source, remote }, destination.url);
  } finally {
    rmSync(boardRepo, { recursive: true, force: true });
  }
}

export function authedLsRemote(
  auth: GitHubAuth | undefined,
  source: GitSource,
  timeoutMs: number,
  ref: string,
  remote: GitRemote = "origin",
): string {
  return inBoardRepo(auth, source, timeoutMs, "ls-remote", (call, url) => runAuthedGit(call, ["ls-remote", "--", url, ref]), remote);
}

/** ADR 0339 決定5: brings the commit `want` into the checkout's object store without writing any of its refs, in two
 *  hops — hop1 fetches it from the network into the board repo's `refs/board/fetched`, hop2 takes it from there into
 *  the checkout. */
export function authedFetch(auth: GitHubAuth | undefined, source: GitSource, timeoutMs: number, want: string, remote: GitRemote = "origin"): void {
  inBoardRepo(auth, source, timeoutMs, "fetch", (call, url) => {
    const checkout = call.where;
    // ADR 0339 帰結: 空の盤面 repo は have を言えないので、checkout の写しの sha を交渉の tip に渡す
    const tips = git(checkout, "for-each-ref", "--format=%(objectname)", remoteTrackingRef("", remote)).split("\n").filter(Boolean);
    runAuthedGit(call, ["fetch", "--quiet", ...tips.map((tip) => `--negotiation-tip=${tip}`), "--", url, `${want}:refs/board/fetched`]);
    // ADR 0339 決定5: hop2 は網に出ない —— checkout の insteadOf が盤面 repo の path を書き換えても local の転送しか通らず(`git` の床)、submodule も辿らない
    // ADR 0356 決定5: the named checkout disables auto-GC explicitly. The network runner already disables it under ADR 0339 決定1.
    git(checkout, "fetch", "--quiet", "--no-auto-gc", "--no-recurse-submodules", "--", call.boardRepo, "refs/board/fetched");
  }, remote);
}

/** Pushes each `[branch, sha]` to `remote`'s declared repo — atomically when there is more than one — and, once the push
 *  succeeded, writes each copy `refs/remotes/<remote>/<branch>` to its sha. ADR 0052 Status 追記(#2827): a push from the
 *  board repo does not move the checkout's copies, so the board writes them, inside the caller's ADR 0243 口. The sha is
 *  the caller's — the value it announced — never re-read here. */
export function authedPush(
  auth: GitHubAuth | undefined,
  source: GitSource,
  timeoutMs: number,
  branches: ReadonlyArray<readonly [branch: string, sha: string]>,
  remote: GitRemote = "origin",
): void {
  const refspecs = branches.map(([branch, sha]) => `${sha}:refs/heads/${branch}`);
  const flags = branches.length > 1 ? ["--atomic"] : [];
  inBoardRepo(auth, source, timeoutMs, "push", (call, url) => runAuthedGit(call, ["push", ...flags, "--", url, ...refspecs]), remote);
  const checkout = sourceCheckout(source);
  for (const [branch, sha] of branches) git(checkout, "update-ref", remoteTrackingRef(branch, remote), sha);
}

/** ADR 0339 決定5: `clone` runs from the board-owned HOME, so no checkout's config — not even a parent of
 *  `dir` — is read; the new checkout's origin is the URL the board built. */
export function authedClone(auth: GitHubAuth | undefined, source: string, dir: string, timeoutMs: number): void {
  // cwd が置き場でなくなったので git clone は無い親を自分で作る —— 置き場が無ければ撃たずに名指す(issue #2722 の文)
  if (!existsSync(dirname(dir))) throw new Error(`\`git clone\` cannot run: the directory ${dirname(dir)} does not exist`);
  const env = auth ? auth.env(repoKey(source)) : githubChildEnv();
  runAuthedGit({ env, boardRepo: undefined, where: dir, timeoutMs, origin: source }, ["clone", "--quiet", "--", networkDestination(source, env.HOME!).url, dir]);
}

/** spec #3273 text A12(N2)の、ssh の origin を ref を動かさずに直す道。 */
const SSH_OUTSIDE_GITHUB_REPAIR =
  " To declare it over https or as a local path instead, delete the workspace, point its checkout's `origin` at that value " +
  "and register it again with that value as `repo:` — the board refuses an edited `repo:` of a registered workspace.";

/** The one network child (ADR 0339 決定1): the board's own `-c` only — the injected helper, ADR 0334's stall
 *  detection, and no auto maintenance or gc (the `--detach` child they spawn would outlive the stall bound). */
function runAuthedGit(call: AuthedCall, args: string[]): string {
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
    const target = call.remote === HEAD_REPO_REMOTE ? ` on head repo ${repositoryLabel(origin)}` : "";
    // ADR 0334 決定4: 接続前の無音では curl 28 が無く、Operation too slow だけが出る。
    const stderr = (err as { stderr?: Buffer }).stderr?.toString();
    if (stderr?.includes("Operation too slow")) {
      throw new Error(`\`git ${args[0]}\` stalled: no bytes for ${Math.ceil(timeoutMs / 1000)} s (in ${where})${target}`, { cause: err });
    }
    // ADR 0339 決定4: GitHub はどの綴りでも https に組むので、ssh が出る出所は非 GitHub の origin の値だけ
    if (stderr?.includes("transport 'ssh' not allowed")) {
      throw new Error(
        `\`git ${args[0]}\` failed with \`transport 'ssh' not allowed\` (in ${where}): the board reaches a remote only over https or a local path — ` +
          // ADR 0373 決定16 / spec #3273 text A12(N2): ref を動かさない直し方 —— 覚えた repo は書き換えた `repo:` を拒む(ADR 0378 決定6〜8)ので、削除と登録し直し
          `the origin \`${origin}\` is an ssh remote outside GitHub.${SSH_OUTSIDE_GITHUB_REPAIR}`,
        { cause: err },
      );
    }
    // 理由は argv でなく stderr で言う —— argv は呼び出しごとに変わる盤面 repo の path と交渉の tip を持ち、同じ失敗を別の文にする
    throw new Error(`\`git ${args[0]}\` failed (in ${where})${target}: ${stderr?.trim() || String(err)}`, { cause: err });
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
