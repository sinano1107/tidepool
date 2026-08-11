import { execFileSync } from "node:child_process";
import { authedGit, GIT_NETWORK_TIMEOUT_MS, type GitHubAuth } from "./github-auth.js";

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
  /** Looks a repository up by bare name under the authenticated account —
   *  the create mode's idempotent-retry probe (issue #57): an existing
   *  same-name repository is a completed step to reuse, not a conflict.
   *  Null means "no such repository"; every other failure stays untyped. */
  getRepository(name: string): Promise<Repository | null>;
  /** Creates a private repository named `name` under the authenticated
   *  account, WITH an initial commit (issue #57): an empty repository has no
   *  default branch, and branch discipline would die on the first pickup. */
  createRepository(name: string): Promise<Repository>;
  /** The login the token actually belongs to (ADR 0067 決定4) — the single
   *  source of the name the repo-access guidance tells a human to invite. An
   *  observation, never a constant: a stale spelling makes the human invite
   *  someone else and the symptom surfaces far away ("I invited them and it
   *  still doesn't work"). */
  login(): Promise<string>;
  /** The token owner's pending repository invitations (ADR 0067 決定1). The
   *  board never empties this inbox — it reads it to find the one invitation
   *  for the repo it is trying to reach right now. */
  listRepositoryInvitations(): Promise<RepoInvitation[]>;
  /** Accepts one invitation by id. Idempotent in practice: an accepted
   *  invitation leaves the inbox (ADR 0067 実測3). */
  acceptRepositoryInvitation(id: number): Promise<void>;
  /** What the token may do on `ref` — the pass/fail question every ADR 0067
   *  door asks (実測5). Null means **not visible**: no access and no such
   *  repository are indistinguishable at this surface (実測7), and so is a
   *  timeout — all three are read as unreachable, never as fatal. */
  getRepositoryPermission(ref: RepoRepoRef): Promise<RepoPermission | null>;
}

/** Which repository, as GitHub's own `owner/name` (ADR 0067) — distinct from
 *  the bare-name `getRepository` probe, which resolves under the
 *  authenticated account's namespace only. */
export interface RepoRepoRef {
  owner: string;
  name: string;
}

/** `viewerPermission` as GitHub spells it. The board only ever asks whether
 *  it is WRITE or above (ADR 0067 決定3) — READ is what 実測4's read
 *  invitation leaves behind, and it is exactly the case that used to surface
 *  as a 403 at PR promotion. */
export type RepoPermission = "READ" | "TRIAGE" | "WRITE" | "MAINTAIN" | "ADMIN";

/** One pending invitation as the board reads it: the id it would accept, the
 *  `owner/name` it is for, and what it would grant (recorded for the record,
 *  never trusted as the verdict — the verdict is the repo's own
 *  `viewerPermission`, ADR 0067 決定3). */
export interface RepoInvitation {
  id: number;
  fullName: string;
  permissions: string;
}

/** A GitHub repository as the workspace-creation modes see it (issue #57):
 *  just its clone URL — recorded on the entry as `repo` provenance. */
export interface Repository {
  url: string;
}

const PR_URL_RE = /\/pull\/(\d+)\s*$/;

/** Real implementation: shells out to `gh`/`git` as the board's machine user
 *  (ADR 0024) — every call injects the token into the child env fresh via
 *  GitHubAuth, never the host's ambient `gh auth`. `gh` prints the new PR's
 *  URL on stdout; the number is the last path segment. */
export class GhCliClient implements GitHubClient {
  constructor(private readonly auth: GitHubAuth) {}

  async createPullRequest(input: CreatePrInput): Promise<PrResult> {
    // `gh pr create --head <branch>` needs the branch to already exist on the
    // remote — run non-interactively, it cannot fall back to its "push now?"
    // prompt.
    authedGit(this.auth, input.path, "push", "-u", "origin", input.branch);
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
      { cwd: input.path, env: this.auth.env(), stdio: ["ignore", "pipe", "pipe"] },
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
        { cwd: ref.path, env: this.auth.env(), stdio: ["ignore", "pipe", "pipe"] },
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
      env: this.auth.env(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async getIssue(ref: IssueRef): Promise<Issue> {
    let output: string;
    try {
      output = execFileSync(
        "gh",
        ["issue", "view", String(ref.number), "--json", "title,body,comments,state"],
        { cwd: ref.path, env: this.auth.env(), stdio: ["ignore", "pipe", "pipe"] },
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
      { cwd: ref.path, env: this.auth.env(), stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
    return JSON.parse(output) as OpenIssue[];
  }

  async addIssueComment(ref: IssueRef, body: string): Promise<void> {
    execFileSync("gh", ["issue", "comment", String(ref.number), "--body", body], {
      cwd: ref.path,
      env: this.auth.env(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async getRepository(name: string): Promise<Repository | null> {
    // a bare <name> defaults to the authenticating user, same resolution as
    // `gh repo create` documents for its OWNER/ omission
    let output: string;
    try {
      output = execFileSync("gh", ["repo", "view", name, "--json", "url"], {
        env: this.auth.env(),
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
      env: this.auth.env(),
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return { url };
  }

  async login(): Promise<string> {
    return this.gh(["api", "user", "--jq", ".login"]).trim();
  }

  async listRepositoryInvitations(): Promise<RepoInvitation[]> {
    const invitations = JSON.parse(this.gh(["api", "user/repository_invitations"])) as Array<{
      id: number;
      repository: { full_name: string };
      permissions: string;
    }>;
    return invitations.map((i) => ({
      id: i.id,
      fullName: i.repository.full_name,
      permissions: i.permissions,
    }));
  }

  async acceptRepositoryInvitation(id: number): Promise<void> {
    this.gh(["api", "--method", "PATCH", `user/repository_invitations/${id}`]);
  }

  async getRepositoryPermission(ref: RepoRepoRef): Promise<RepoPermission | null> {
    // every failure maps to null, not just not-found: an invisible repo, a
    // repo the token has no access to, and a timed-out call are the same
    // answer here — "cannot confirm WRITE" — and the three doors treat them
    // identically (ADR 0067 実測7 / 決定6). Unlike getRepository above, this
    // one must not re-throw an outage: a probe that throws on the pickup
    // failure path would replace the real cause the human needs to read.
    try {
      const output = this.gh([
        "repo",
        "view",
        `${ref.owner}/${ref.name}`,
        "--json",
        "viewerPermission",
      ]);
      return (JSON.parse(output) as { viewerPermission: RepoPermission }).viewerPermission ?? null;
    } catch {
      return null;
    }
  }

  /** The four ADR 0067 calls' shared shape: no workspace checkout to run from
   *  (they ask about the token itself, or about a repo by `owner/name`), and
   *  **a time limit** — `execFileSync` is synchronous, so a black-holed
   *  connection on the pickup path would stall the event loop and take the
   *  human surface ADR 0036 designates as the recovery path down with it. The
   *  limit is the real-network one (`GIT_NETWORK_TIMEOUT_MS`), not the
   *  local-binary probe's. */
  private gh(args: string[]): string {
    return execFileSync("gh", args, {
      env: this.auth.env(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_NETWORK_TIMEOUT_MS,
    }).toString();
  }
}
