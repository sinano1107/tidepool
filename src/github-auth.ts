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
  return execFileSync("git", auth ? [...GIT_CREDENTIAL_ARGS, ...args] : args, {
    cwd,
    env: auth?.env(),
    stdio: ["ignore", "pipe", "pipe"],
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
