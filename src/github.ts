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

/** The three-way state gh's per-check "bucket" aggregates to: any failing or
 *  cancelled check is a "failure", any still running is "pending", otherwise
 *  (including a PR with no checks configured at all) "success" — there is
 *  nothing left to block on. */
export type CiStatus = "pending" | "success" | "failure";

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
}
