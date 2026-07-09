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

/** The GitHub-facing seam (issue #19): promoting a task branch's work to a PR
 *  is never entrusted to the worker, only to tidepool itself — this is what
 *  it calls through. An external API is a system boundary (mocking.md):
 *  faked in tests, shelled out to `gh` for real. */
export interface GitHubClient {
  createPullRequest(input: CreatePrInput): Promise<PrResult>;
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
}
