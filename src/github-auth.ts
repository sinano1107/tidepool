import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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
 *  commit. Callers `await ensureToken(repo)` first; `env(repo)` and the `authedGit`
 *  helpers then read the cache synchronously and fail closed when it is empty. */
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

  /** One child call's env: the parent env plus the installation token as
   *  GH_TOKEN. `gh` prefers GH_TOKEN over any keyring login, and
   *  GIT_CREDENTIAL_ARGS's helper echoes it back to git. The spread copies —
   *  process.env itself never holds a token. GIT_TERMINAL_PROMPT=0 turns a bad
   *  token into a fast failure instead of a hung username prompt.
   *
   *  **Synchronous**, so it serves only what `ensureToken` already put in the cache.
   *  An unexpired token is good enough here — the 5-minute margin belongs to
   *  acquisition, not to use. Nothing held means the caller skipped `ensureToken`
   *  (or the call outlived its token): throw, fail-closed, the same shape as a
   *  git network failure. */
  env(repo: string | undefined): NodeJS.ProcessEnv {
    const base = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (repo === undefined) return base;
    const held = this.tokens.get(repo);
    if (!held || held.expiresAt <= Date.now()) {
      throw new Error(`no unexpired GitHub installation token is held for ${repo}`);
    }
    return { ...base, GH_TOKEN: held.token };
  }
}

/** The official App's broker (ADR 0093 決定1). A public value, not a secret,
 *  and not one of the six board-behaviour keys — unset is the normal state.
 *  Forks override it with `TIDEPOOL_GITHUB_BROKER_URL`. */
const DEFAULT_GITHUB_BROKER_URL = "https://registration-pending-issue-424.invalid";

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
 *  `undefined`, and the call runs unauthenticated as it does today. */
export function originRepo(cwd: string): string | undefined {
  try {
    return repoKey(
      execFileSync("git", ["config", "remote.origin.url"], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      })
        .toString()
        .trim(),
    );
  } catch {
    return undefined;
  }
}

/** `-c` flags for one authenticated git network call: the empty helper first
 *  clears every configured credential helper (osxkeychain, `gh auth
 *  setup-git` — exactly the ambient identities ADR 0024 abolishes), then an
 *  inline helper serves the injected GH_TOKEN. The token stays in the child
 *  env, never on the command line where `ps` could read it. */
export const GIT_CREDENTIAL_ARGS = [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f',
] as const;

/** The authenticated twin of workspace.ts's `git()`, for the board's git
 *  network calls (push, clone). Local plumbing keeps using the plain helper;
 *  anything that must reach GitHub as `tidepool[bot]` comes through here.
 *
 *  `repo` names which installation token to serve and must already be in the
 *  cache (`await auth.ensureToken(repo)`). Without an identity (`auth` absent) or
 *  without a GitHub repo to authenticate against (`repo` undefined — a
 *  non-GitHub remote) the call runs bare: no credential override, no env
 *  injection, deferring to whatever git config remains. */
export function authedGit(
  auth: GitHubAuth | undefined,
  cwd: string,
  repo: string | undefined,
  ...args: string[]
): string {
  return runAuthedGit(auth, cwd, repo, args);
}

/** ネットワークへ出る git 呼び出しの上限(ADR 0052)。`execFileSync` は同期なので、
 *  black-hole した接続を無制限に待つと event loop ごと止まり、ADR 0036 が復旧経路と
 *  定めた人間面まで応答しなくなる —— fail-closed より悪い状態(containment.ts)。
 *  timeout は「到達不能」= fail-closed 側に読む。仲介への往復も同じ上限を分け合う
 *  (ADR 0093 決定7: 仲介の不達は GitHub の不達と同じものとして扱う)。
 *
 *  他の probe(`CAPABILITY_PROBE_TIMEOUT_MS` = 5秒)より桁が大きいのは、あれが
 *  ローカルのバイナリを叩くのに対しこちらは実ネットワーク往復だからで、同じ数を
 *  共有すると正常な fetch を落とす。
 *
 *  registry の refresh と workspace の refresh が**同じ1つの上限**を共有するのは、
 *  根拠がどちらも「同期の実ネットワーク往復が poll を止めてはならない」1つだから
 *  である —— 資源ごとに数を分けると、片方だけを動かしたときに理由のほうが割れる。 */
export const GIT_NETWORK_TIMEOUT_MS = 30_000;

/** `authedGit` の上限つきの面。ネットワークへ出る refresh(registry: ADR 0052 決定2、
 *  workspace: issue #211)が使う —— どちらも pickup ゲートの手前に立つ probe なので、
 *  詰まったら poll ごと止めてはならない(`GIT_NETWORK_TIMEOUT_MS`)。
 *
 *  別関数にしてでも `runAuthedGit` を共有するのは、この module の約束
 *  ——「credentials take effect in exactly one place」—— を守るためである。
 *  呼び出し側で credential 引数を組み直せば、ambient な identity を消す責務が
 *  2箇所に分かれ、片方が欠けても誰も気づかない。 */
export function authedGitBounded(
  auth: GitHubAuth | undefined,
  cwd: string,
  repo: string | undefined,
  timeoutMs: number,
  ...args: string[]
): string {
  return runAuthedGit(auth, cwd, repo, args, timeoutMs);
}

function runAuthedGit(
  auth: GitHubAuth | undefined,
  cwd: string,
  repo: string | undefined,
  args: string[],
  timeoutMs?: number,
): string {
  const authenticated = auth !== undefined && repo !== undefined;
  return execFileSync("git", authenticated ? [...GIT_CREDENTIAL_ARGS, ...args] : args, {
    cwd,
    env: authenticated ? auth.env(repo) : undefined,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  })
    .toString()
    .trim();
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
