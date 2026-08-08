import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/** ADR 0024 (issue #50): the board's GitHub identity is a machine user whose
 *  token lives in a mode-600 secrets file and is injected into each `gh`/`git`
 *  child process's env at the moment of the call. It is never written to the
 *  board's own process.env — workers inherit that wholesale, and the worker
 *  holds zero GitHub credentials — and never committed to the registry. Every
 *  board-driven GitHub network call flows through this module: credentials
 *  take effect in exactly one place. */
export class GitHubAuth {
  constructor(private readonly tokenFile: string) {}

  /** Read fresh on every call — the token rotates by replacing the file,
   *  without a board restart. */
  token(): string {
    return readFileSync(this.tokenFile, "utf8").trim();
  }

  /** One child call's env: the parent env plus GH_TOKEN. `gh` prefers
   *  GH_TOKEN over any keyring login, and GIT_CREDENTIAL_ARGS's helper echoes
   *  it back to git. The spread copies — process.env itself never holds the
   *  token. GIT_TERMINAL_PROMPT=0 turns a bad token into a fast failure
   *  instead of a hung username prompt. */
  env(): NodeJS.ProcessEnv {
    return { ...process.env, GH_TOKEN: this.token(), GIT_TERMINAL_PROMPT: "0" };
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
 *  anything that must reach GitHub as the machine user comes through here.
 *  Without an identity (`auth` absent) the call runs bare — no credential
 *  override, no env injection — deferring to whatever git config remains,
 *  so a board without a secrets file keeps its pre-#50 behavior. */
export function authedGit(auth: GitHubAuth | undefined, cwd: string, ...args: string[]): string {
  return runAuthedGit(auth, cwd, args);
}

/** ネットワークへ出る git 呼び出しの上限(ADR 0052)。`execFileSync` は同期なので、
 *  black-hole した接続を無制限に待つと event loop ごと止まり、ADR 0036 が復旧経路と
 *  定めた人間面まで応答しなくなる —— fail-closed より悪い状態(containment.ts)。
 *  timeout は「到達不能」= fail-closed 側に読む。
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
 *  詰まったら poll ごと止めてはならない(sandbox.ts の probe 境界の規律)。
 *
 *  別関数にしてでも `runAuthedGit` を共有するのは、この module の約束
 *  ——「credentials take effect in exactly one place」—— を守るためである。
 *  呼び出し側で credential 引数を組み直せば、ambient な identity を消す責務が
 *  2箇所に分かれ、片方が欠けても誰も気づかない。 */
export function authedGitBounded(
  auth: GitHubAuth | undefined,
  cwd: string,
  timeoutMs: number,
  ...args: string[]
): string {
  return runAuthedGit(auth, cwd, args, timeoutMs);
}

function runAuthedGit(
  auth: GitHubAuth | undefined,
  cwd: string,
  args: string[],
  timeoutMs?: number,
): string {
  return execFileSync("git", auth ? [...GIT_CREDENTIAL_ARGS, ...args] : args, {
    cwd,
    env: auth?.env(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  })
    .toString()
    .trim();
}

/** Resolves the board-config secrets path to a GitHubAuth, or undefined —
 *  fail-closed (issue #50): no path configured, an unreadable or empty file,
 *  and permissions wider than 0600 all mean the board has no GitHub identity,
 *  the same shape as the existing optional `deps.github`. */
export function loadGitHubAuth(tokenFile: string | undefined): GitHubAuth | undefined {
  if (!tokenFile) return undefined;
  let mode: number;
  try {
    mode = statSync(tokenFile).mode;
  } catch {
    console.warn(`[github-auth] token file not readable — GitHub features off: ${tokenFile}`);
    return undefined;
  }
  if ((mode & 0o077) !== 0) {
    console.warn(
      `[github-auth] token file must be mode 600 (is ${(mode & 0o777).toString(8)}) — GitHub features off: ${tokenFile}`,
    );
    return undefined;
  }
  const auth = new GitHubAuth(tokenFile);
  // stat succeeding doesn't imply read access (it only needs the directory's
  // x bit — e.g. a root:root 600 file stats fine): prove the read here, or
  // the first per-call injection would crash the board instead of failing
  // closed
  let token: string;
  try {
    token = auth.token();
  } catch {
    console.warn(`[github-auth] token file not readable — GitHub features off: ${tokenFile}`);
    return undefined;
  }
  if (token === "") {
    console.warn(`[github-auth] token file is empty — GitHub features off: ${tokenFile}`);
    return undefined;
  }
  return auth;
}
