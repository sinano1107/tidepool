import { execFileSync } from "node:child_process";
import { authedGit, type GitHubAuth, originRepo } from "./github-auth.js";

/** Everything a PR needs to exist, independent of how it's actually opened
 *  (issue #19): which task branch, onto which base, with what title/body. */
export interface CreatePrInput {
  /** The workspace path — the real git checkout `gh` runs from. */
  path: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}

export interface PrResult {
  url: string;
  number: number;
}

/** Which workspace checkout to run `gh` from, and which PR (issue #11) — the
 *  merge dial's CI-check and merge calls both key off just these two. */
export interface PrRef {
  path: string;
  number: number;
}

/** Which workspace checkout to run `gh` from, and which issue (issue #49) —
 *  same shape as PrRef, one per resource. */
export interface IssueRef {
  path: string;
  number: number;
}

/** Which workspace checkout to run `gh` from — listIssues' only input (issue
 *  #67): unlike PrRef/IssueRef there is no specific number, the listing
 *  covers the whole repository. */
export interface RepoRef {
  path: string;
}

/** One open issue as the issue-number picker sees it (issue #67): just
 *  enough to render a "#N — title" row and confirm a number. */
export interface OpenIssue {
  number: number;
  title: string;
}

/** listIssues' own `--limit` (issue #67 grilling: no paging). The API layer
 *  reuses this same value to tell the picker whether the list was cut off
 *  (`issues.length === OPEN_ISSUES_LIMIT`), so the "older issues exist" hint
 *  and the actual `gh` call never drift apart. */
export const OPEN_ISSUES_LIMIT = 100;

/** An issue-backed task's live content (issue #49, CONTEXT.md): "issue" means
 *  the title, body, and the full comment thread — every element a live
 *  reference needs to derive title/purpose/completion_criteria from. */
export interface Issue {
  title: string;
  body: string;
  comments: string[];
}

/** The three-way state gh's per-check "bucket" aggregates to: any failing or
 *  cancelled check is a "failure", any still running is "pending", otherwise
 *  (including a PR with no checks configured at all) "success" — there is
 *  nothing left to block on. */
export type CiStatus = "pending" | "success" | "failure";

/** ADR 0016's 確定的失敗 (permanent failure) of an issue-backed task's live
 *  reference, as part of getIssue's contract: the referenced issue is gone
 *  for good — deleted/never existed (`not_found`) or already closed
 *  (`closed`). Callers route this to the retry/abandon failure question;
 *  every other getIssue error is 一時的 (temporary — network, GitHub outage)
 *  and passes through untyped, handled as a pickup-cycle skip instead. */
export class IssueGoneError extends Error {
  constructor(
    ref: IssueRef,
    readonly reason: "not_found" | "closed",
  ) {
    super(`issue #${ref.number} is gone (${reason})`);
    this.name = "IssueGoneError";
  }
}

/** The GitHub-facing seam (issue #19): promoting a task branch's work to a PR
 *  is never entrusted to the worker, only to tidepool itself — this is what
 *  it calls through. An external API is a system boundary (mocking.md):
 *  faked in tests, shelled out to `gh` for real. `getCiStatus`/
 *  `mergePullRequest` (issue #11) back the merge dial: the actual merge is
 *  never performed until a live CI check reports "success" immediately
 *  beforehand. */
export interface GitHubClient {
  createPullRequest(input: CreatePrInput): Promise<PrResult>;
  getCiStatus(ref: PrRef): Promise<CiStatus>;
  mergePullRequest(ref: PrRef): Promise<void>;
  /** Whether this PR is already merged (ADR 0079 決定3) — the read the board
   *  needs to tell "the merge is still mine to make" from "someone merged it
   *  outside the board". Only asked on the two surfaces the board holds a
   *  decision on (an open merge question, the auto-merge queue), never as a
   *  standing watch over every open PR. */
  isPullRequestMerged(ref: PrRef): Promise<boolean>;
  getIssue(ref: IssueRef): Promise<Issue>;
  /** Lists the repository's open issues (issue #67) — the issue-number
   *  picker's data source. No paging/search-term filter/cache: `--limit 100`,
   *  gh's default (newest-first) order, one call per workspace selection. */
  listIssues(ref: RepoRef): Promise<OpenIssue[]>;
  /** Appends a comment to the referenced issue — the write half of issue
   *  #49's registration gate: a human-approved suggestion lands on the
   *  issue (GitHub stays the sole source of truth, ADR 0016), never on the
   *  board. */
  addIssueComment(ref: IssueRef, body: string): Promise<void>;
  /** Why the broker refused a token for `ref`, or `null` when it minted one
   *  (ADR 0093 決定8). `null` is CONTEXT.md's "書ける" verdict: the token
   *  broker issued an installation token for that one
   *  repository, which it does only when the tidepool App is installed on it
   *  **and** the logged-in user can push to it (ADR 0067 決定3's "can write",
   *  now the broker's own gate). A string is why it could not, carrying the
   *  broker's HTTP status and error code — the diagnostic material the human
   *  guidance quotes. Not installed, not visible, and no such repository are
   *  indistinguishable here (#419), and so is a timeout: all of them read as
   *  unreachable, never as fatal.
   *
   *  The board's only repo-access probe, fired on failure paths alone. */
  tokenRefusal(ref: RepoSlug): Promise<string | null>;
}

/** Which repository, as GitHub's own `owner/name` (ADR 0067). */
export interface RepoSlug {
  owner: string;
  name: string;
}

const PR_URL_RE = /\/pull\/(\d+)\s*$/;

/** Real implementation: shells out to `gh`/`git` as `tidepool[bot]` (ADR 0093)
 *  — every call injects a repo-scoped installation token into the child env
 *  fresh via GitHubAuth, never the host's ambient `gh auth`. `gh` prints the
 *  new PR's URL on stdout; the number is the last path segment. */
export class GhCliClient implements GitHubClient {
  constructor(private readonly auth: GitHubAuth) {}

  /** One call's env, for a `gh`/`git` invocation that runs inside a workspace
   *  checkout: the installation token is per-repository (ADR 0093 決定2), so
   *  the repo is read off that checkout's `origin` and the broker round trip
   *  happens here, before the synchronous `execFileSync`. */
  private async envFor(cwd: string): Promise<NodeJS.ProcessEnv> {
    const repo = originRepo(cwd);
    await this.auth.ensureToken(repo);
    return this.auth.env(repo);
  }

  async createPullRequest(input: CreatePrInput): Promise<PrResult> {
    // `gh pr create --head <branch>` needs the branch to already exist on the
    // remote — run non-interactively, it cannot fall back to its "push now?"
    // prompt.
    const repo = originRepo(input.path);
    await this.auth.ensureToken(repo);
    authedGit(this.auth, input.path, repo, "push", "-u", "origin", input.branch);
    const url = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--head",
        input.branch,
        "--base",
        input.base,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      { cwd: input.path, env: this.auth.env(repo), stdio: ["ignore", "pipe", "pipe"] },
    )
      .toString()
      .trim();
    const match = url.match(PR_URL_RE);
    if (!match) throw new Error(`unexpected gh pr create output: ${url}`);
    return { url, number: Number(match[1]) };
  }

  async getCiStatus(ref: PrRef): Promise<CiStatus> {
    // `gh pr checks` exits non-zero while any check is pending or failing
    // (its own documented exit codes) — the JSON it printed to stdout before
    // exiting is still what we want, so a thrown error's captured stdout is
    // the fallback, not a propagated failure.
    let output: string;
    try {
      output = execFileSync(
        "gh",
        ["pr", "checks", String(ref.number), "--json", "bucket"],
        { cwd: ref.path, env: await this.envFor(ref.path), stdio: ["ignore", "pipe", "pipe"] },
      ).toString();
    } catch (err) {
      output = (err as { stdout?: Buffer }).stdout?.toString() ?? "[]";
    }
    const checks = JSON.parse(output.trim() || "[]") as Array<{ bucket: string }>;
    if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "failure";
    if (checks.some((c) => c.bucket === "pending")) return "pending";
    return "success";
  }

  async mergePullRequest(ref: PrRef): Promise<void> {
    execFileSync("gh", ["pr", "merge", String(ref.number), "--merge"], {
      cwd: ref.path,
      env: await this.envFor(ref.path),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async isPullRequestMerged(ref: PrRef): Promise<boolean> {
    const output = execFileSync("gh", ["pr", "view", String(ref.number), "--json", "state"], {
      cwd: ref.path,
      env: await this.envFor(ref.path),
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    return (JSON.parse(output) as { state: string }).state === "MERGED";
  }

  async getIssue(ref: IssueRef): Promise<Issue> {
    let output: string;
    try {
      output = execFileSync(
        "gh",
        ["issue", "view", String(ref.number), "--json", "title,body,comments,state"],
        { cwd: ref.path, env: await this.envFor(ref.path), stdio: ["ignore", "pipe", "pipe"] },
      ).toString();
    } catch (err) {
      // gh's not-found failure ("GraphQL: Could not resolve to an issue or
      // pull request …") is the only permanent one at this surface — every
      // other non-zero exit (network, auth, outage) stays untyped/temporary
      const stderr = (err as { stderr?: Buffer | string }).stderr?.toString() ?? "";
      if (/could not resolve/i.test(stderr)) throw new IssueGoneError(ref, "not_found");
      throw err;
    }
    const parsed = JSON.parse(output) as {
      title: string;
      body: string;
      comments: Array<{ body: string }>;
      state: string;
    };
    if (parsed.state === "CLOSED") throw new IssueGoneError(ref, "closed");
    return {
      title: parsed.title,
      body: parsed.body,
      comments: parsed.comments.map((c) => c.body),
    };
  }

  async listIssues(ref: RepoRef): Promise<OpenIssue[]> {
    const output = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        String(OPEN_ISSUES_LIMIT),
        "--json",
        "number,title",
      ],
      { cwd: ref.path, env: await this.envFor(ref.path), stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
    return JSON.parse(output) as OpenIssue[];
  }

  async addIssueComment(ref: IssueRef, body: string): Promise<void> {
    execFileSync("gh", ["issue", "comment", String(ref.number), "--body", body], {
      cwd: ref.path,
      env: await this.envFor(ref.path),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async tokenRefusal(ref: RepoSlug): Promise<string | null> {
    try {
      // 扉は再検査である: キャッシュに残る token で「書ける」と答えてはならない
      // (install が外された直後でも 1 時間は出せたことになる)。仲介に撃ち直す。
      await this.auth.ensureToken(`${ref.owner}/${ref.name}`, { fresh: true });
      return null;
    } catch (err) {
      // 仲介の断り(status + code)も到達失敗も同じ「まだ出せない」であり、
      // どちらも人間の案内にそのまま載る材料である
      return err instanceof Error ? err.message : String(err);
    }
  }
}
