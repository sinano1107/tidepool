import { execFileSync } from "node:child_process";

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
  getIssue(ref: IssueRef): Promise<Issue>;
  /** Appends a comment to the referenced issue — the write half of issue
   *  #49's registration gate: a human-approved suggestion lands on the
   *  issue (GitHub stays the sole source of truth, ADR 0016), never on the
   *  board. */
  addIssueComment(ref: IssueRef, body: string): Promise<void>;
  /** Looks a repository up by bare name under the authenticated account —
   *  the create mode's idempotent-retry probe (issue #57): an existing
   *  same-name repository is a completed step to reuse, not a conflict.
   *  Null means "no such repository"; every other failure stays untyped. */
  getRepository(name: string): Promise<Repository | null>;
  /** Creates a private repository named `name` under the authenticated
   *  account, WITH an initial commit (issue #57): an empty repository has no
   *  default branch, and branch discipline would die on the first pickup. */
  createRepository(name: string): Promise<Repository>;
}

/** A GitHub repository as the workspace-creation modes see it (issue #57):
 *  just its clone URL — recorded on the entry as `repo` provenance. */
export interface Repository {
  url: string;
}

const PR_URL_RE = /\/pull\/(\d+)\s*$/;

/** Real implementation: `gh pr create` under the host's own `gh auth` session
 *  — the same ambient-credential shape the worker already runs under (no
 *  separate tidepool identity in v1). `gh` prints the new PR's URL on stdout;
 *  the number is the last path segment. */
export class GhCliClient implements GitHubClient {
  async createPullRequest(input: CreatePrInput): Promise<PrResult> {
    // `gh pr create --head <branch>` needs the branch to already exist on the
    // remote — run non-interactively, it cannot fall back to its "push now?"
    // prompt.
    execFileSync("git", ["push", "-u", "origin", input.branch], {
      cwd: input.path,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      { cwd: input.path, stdio: ["ignore", "pipe", "pipe"] },
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
        { cwd: ref.path, stdio: ["ignore", "pipe", "pipe"] },
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
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async getIssue(ref: IssueRef): Promise<Issue> {
    let output: string;
    try {
      output = execFileSync(
        "gh",
        ["issue", "view", String(ref.number), "--json", "title,body,comments,state"],
        { cwd: ref.path, stdio: ["ignore", "pipe", "pipe"] },
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

  async addIssueComment(ref: IssueRef, body: string): Promise<void> {
    execFileSync("gh", ["issue", "comment", String(ref.number), "--body", body], {
      cwd: ref.path,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async getRepository(name: string): Promise<Repository | null> {
    // a bare <name> defaults to the authenticating user, same resolution as
    // `gh repo create` documents for its OWNER/ omission
    let output: string;
    try {
      output = execFileSync("gh", ["repo", "view", name, "--json", "url"], {
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
    } catch (err) {
      // not-found is the probe's negative answer, not a failure; every other
      // non-zero exit (network, auth) propagates untyped — same split as
      // getIssue's
      const stderr = (err as { stderr?: Buffer | string }).stderr?.toString() ?? "";
      if (/could not resolve/i.test(stderr)) return null;
      throw err;
    }
    return { url: (JSON.parse(output) as { url: string }).url };
  }

  async createRepository(name: string): Promise<Repository> {
    // --add-readme is what makes the initial commit exist (issue #57: an
    // empty repository has no default branch); gh prints the new repo's URL
    const url = execFileSync("gh", ["repo", "create", name, "--private", "--add-readme"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return { url };
  }
}
