import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authedGitBounded, GIT_NETWORK_TIMEOUT_MS, type GitHubAuth, originRepo } from "./github-auth.js";

const execFileAsync = promisify(execFile);

/** どの checkout のどのブランチを `origin` へ push するか。 */
export interface PushBranchInput {
  /** The workspace path — the real git checkout `gh`/`git` run from. */
  path: string;
  branch: string;
}

/** Everything a PR needs to exist, independent of how it's actually opened
 *  (issue #19): which task branch, onto which base, with what title/body. */
export interface CreatePrInput extends PushBranchInput {
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

/** An issue-backed task's live content (issue #49, GLOSSARY.md): "issue" means
 *  the title, body, and the full comment thread — every element a live
 *  reference needs to derive title/purpose/completion_criteria from. */
export interface Issue {
  title: string;
  body: string;
  comments: string[];
}

/** The state a PR's checks aggregate to: any failing or cancelled check is a
 *  "failure", any still running is "pending", all passed is "success". A PR
 *  with no check reported at all is "unreported" — neither green nor pending,
 *  since "this repo has no CI" and "the checks have not reported yet" look the
 *  same from here; callers wait a grace from when the board first knew that head before
 *  treating it as unobservable (ADR 0227). A check state that could not be
 *  **read** is "pending", never "success" and never "failure" (issue #427): an
 *  unobservable CI is not a green light (ADR 0052's fail-closed), and inventing
 *  a failure would write a false observation into the human's failure question
 *  (ADR 0079). */
export type CiStatus = "pending" | "success" | "failure" | "unreported";

/** GitHub's own PR state (ADR 0229 決定2). */
export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** The PR's state and who merged it, read in one call (ADR 0265 決定5): `mergedBy` is `gh`'s `mergedBy.login`, null
 *  unless merged. */
export interface PrStateRead {
  state: PrState;
  mergedBy: string | null;
}

/** The PR found on a task branch, whatever its state (ADR 0241 決定4). */
export interface FoundPr {
  number: number;
  state: PrState;
  head: string;
}

/** One read of a PR, CI, state, merger and head together (ADR 0229 決定2 / ADR 0231
 *  決定1 / ADR 0265 決定5): `head` is the commit the CI was read on, the one a merge pins to. A
 *  read that failed is CI "pending" and state "unreadable" with no head —
 *  never a state the caller would act on. */
export type PrStatus =
  | (PrStateRead & { ci: CiStatus; head: string })
  | { ci: "pending"; state: "unreadable" };

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
 *  faked in tests, shelled out to `gh` for real. `readPullRequest`/
 *  `mergePullRequest` (issue #11) back the merge dial: the actual merge is
 *  never performed until a live CI check reports "success" immediately
 *  beforehand — or, on a human's merge answer only, still reports
 *  "unreported" past ADR 0227's grace — and only on the head that read was
 *  taken on (ADR 0231 決定1). */
export interface GitHubClient {
  /** push 済みのタスクブランチに PR を開く(`gh pr create` だけ)。push は呼び手が `preparePush` で先に撃つ ——
   *  盤面の push は基準への予告で包む口を通る(ADR 0243)。 */
  createPullRequest(input: CreatePrInput): Promise<PrResult>;
  /** タスクブランチを `origin` へ push する —— 盤面がタスクブランチをリモートへ書く唯一の操作。
   *  PR 作成の前段であると同時に、**既に開いている PR の更新**でもある: 付帯子の
   *  修理が merge back されたタスクブランチを押し直すと、その PR が黙って更新される
   *  (ADR 0053 / issue #400)。
   *
   *  token の取得(仲介への往復)だけをここで済ませ、push そのものは返した同期の関数が撃つ —— 盤面は push を
   *  基準への予告と畳みの同期区間の中で撃つ(ADR 0243)。 */
  preparePush(input: PushBranchInput): Promise<() => void>;
  readPullRequest(ref: PrRef): Promise<PrStatus>;
  /** Merges only while the PR's head is still `head` — the one whose CI was
   *  read (ADR 0231 決定1); GitHub refuses it once the head has moved. */
  mergePullRequest(ref: PrRef, head: string): Promise<void>;
  /** The PR's state and who merged it (ADR 0079 決定3 / ADR 0229 / ADR 0265 決定5) — the read the board needs to
   *  tell "the merge is still mine to make" from "someone merged or closed it
   *  outside the board". Only asked on the two surfaces the board holds a
   *  decision on (an open merge question, the auto-merge queue) and before
   *  pushing a repair onto a still-open PR (issue #400), never as a standing
   *  watch over every open PR. Throws when it cannot be read. */
  getPullRequestState(ref: PrRef): Promise<PrStateRead>;
  /** The PR whose head is `branch`, in any state, or null (ADR 0241 決定4) — read
   *  before opening one, so a PR the board opened but never recorded is not
   *  opened twice. Throws when it cannot be read. */
  findPullRequestByHead(input: PushBranchInput): Promise<FoundPr | null>;
  getIssue(ref: IssueRef): Promise<Issue>;
  /** 親の briefing は closed でも読む(ADR 0321 決定5)。not_found と一時失敗は getIssue と同じ。 */
  getIssueWithState(ref: IssueRef): Promise<Issue & { state: "open" | "closed" }>;
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
   *  (ADR 0093 決定8). `null` is GLOSSARY.md's "書ける" verdict: the token
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

/** One entry of `gh pr view --json statusCheckRollup`: a CheckRun carries its
 *  verdict in `conclusion`, a StatusContext in `state`. Only those two fields
 *  are read — `status` is implied by an empty `conclusion`. */
interface RollupEntry {
  conclusion?: string | null;
  state?: string | null;
}

/** 緑と読める判定値 / 赤と読める判定値(GitHub の CheckConclusionState と
 *  StatusState)。どちらにも無い値は未完了か未知で、pending。 */
const CI_PASSED = ["SUCCESS", "SKIPPED", "NEUTRAL"];
const CI_FAILED = [
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
];

function ciStatusOf(checks: RollupEntry[]): CiStatus {
  if (checks.length === 0) return "unreported";
  // CheckRun は完了時の `conclusion`、StatusContext は `state` に判定を持つ。
  // どちらも空 = まだ完了していない。知らない判定値は pending 側に落とす。
  const verdicts = checks.map((c) => c.conclusion || c.state || "");
  if (verdicts.some((v) => CI_FAILED.includes(v))) return "failure";
  if (verdicts.some((v) => !CI_PASSED.includes(v))) return "pending";
  return "success";
}

/** Real implementation: shells out to `gh`/`git` as `tidepool-board[bot]` (ADR 0093)
 *  — every call injects a repo-scoped installation token into the child env
 *  fresh via GitHubAuth, never the host's ambient `gh auth`. `gh` prints the
 *  new PR's URL on stdout; the number is the last path segment. */
export class GhCliClient implements GitHubClient {
  private readonly timeoutMs: number;

  /** `timeoutMs` はテストが上限を短くするためだけにある —— 本番の呼び手は既定のまま(#2726 の完了基準、釘は ADR 0107 の domain 層)。 */
  constructor(
    private readonly auth: GitHubAuth,
    { timeoutMs = GIT_NETWORK_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = timeoutMs;
  }

  /** 盤面の `gh` はすべてここを通る(ADR 0330 決定4)。installation token は repo 単位(ADR 0093 決定2)なので checkout の
   *  `origin` から repo を読んで仲介へ往復し、`gh` を非同期の子として撃つ —— 待つ間も盤面の実行の糸は止まらない(決定1)。
   *  上限超過は untyped の一時的失敗で、どの呼び出しが何 ms で切れたかを人間が読める文で持つ(決定2)。それ以外の失敗は
   *  `stderr` を持ったまま投げ直す(not-found の判定が読む)。 */
  private async gh(cwd: string, args: string[]): Promise<string> {
    const repo = originRepo(cwd);
    await this.auth.ensureToken(repo);
    try {
      return (await execFileAsync("gh", args, { cwd, env: this.auth.env(repo), timeout: this.timeoutMs })).stdout;
    } catch (err) {
      // `killed` は Node 自身が上限で殺したときだけ立つ —— 非ゼロ終了・maxBuffer 超過・外からの signal では立たない
      if ((err as { killed?: boolean }).killed) {
        throw new Error(`\`gh ${args[0]} ${args[1]}\` timed out after ${this.timeoutMs} ms (in ${cwd})`, { cause: err });
      }
      throw err;
    }
  }

  async preparePush(input: PushBranchInput): Promise<() => void> {
    const repo = originRepo(input.path);
    await this.auth.ensureToken(repo);
    return () => authedGitBounded(this.auth, input.path, repo, this.timeoutMs, "push", "-u", "origin", input.branch);
  }

  async createPullRequest(input: CreatePrInput): Promise<PrResult> {
    const url = (
      await this.gh(input.path, [
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
      ])
    ).trim();
    const match = url.match(PR_URL_RE);
    if (!match) throw new Error(`unexpected gh pr create output: ${url}`);
    return { url, number: Number(match[1]) };
  }

  async readPullRequest(ref: PrRef): Promise<PrStatus> {
    // `gh pr checks` はチェック未設定でも「非ゼロ終了 + stdout 空」で、認証・
    // ネットワーク失敗と区別がつかない —— 取得失敗が緑に化ける(issue #427)。
    // `gh pr view --json statusCheckRollup` は未設定なら exit 0 + 空配列を返し、
    // 非ゼロ終了は「読めなかった」だけを意味する。token 取得(仲介への往復)も
    // 同じ try に入れて、どちらの失敗も pending / unreadable に倒す。
    let parsed: { state: PrState; statusCheckRollup?: RollupEntry[]; headRefOid: string; mergedBy: { login: string } | null };
    try {
      parsed = JSON.parse(
        await this.gh(ref.path, ["pr", "view", String(ref.number), "--json", "state,statusCheckRollup,headRefOid,mergedBy"]),
      );
    } catch {
      return { ci: "pending", state: "unreadable" };
    }
    return {
      ci: ciStatusOf(parsed.statusCheckRollup ?? []),
      state: parsed.state,
      head: parsed.headRefOid,
      mergedBy: parsed.mergedBy?.login ?? null,
    };
  }

  async mergePullRequest(ref: PrRef, head: string): Promise<void> {
    await this.gh(ref.path, ["pr", "merge", String(ref.number), "--merge", "--match-head-commit", head]);
  }

  async getPullRequestState(ref: PrRef): Promise<PrStateRead> {
    const output = await this.gh(ref.path, ["pr", "view", String(ref.number), "--json", "state,mergedBy"]);
    const { state, mergedBy } = JSON.parse(output) as { state: PrState; mergedBy: { login: string } | null };
    return { state, mergedBy: mergedBy?.login ?? null };
  }

  async findPullRequestByHead(input: PushBranchInput): Promise<FoundPr | null> {
    const output = await this.gh(input.path, [
      "pr",
      "list",
      "--head",
      input.branch,
      "--state",
      "all",
      "--limit",
      "10",
      "--json",
      "number,state,headRefOid,isCrossRepository",
    ]);
    // --head matches the branch name alone: a fork's PR from a same-named branch is not the board's
    const prs = (
      JSON.parse(output) as Array<{ number: number; state: PrState; headRefOid: string; isCrossRepository: boolean }>
    ).filter((p) => !p.isCrossRepository);
    // gh does not document its order: an open PR wins, then a merged one, over closed ones on the same branch
    const pr = prs.find((p) => p.state === "OPEN") ?? prs.find((p) => p.state === "MERGED") ?? prs[0];
    return pr ? { number: pr.number, state: pr.state, head: pr.headRefOid } : null;
  }

  async getIssue(ref: IssueRef): Promise<Issue> {
    const { state, ...issue } = await this.getIssueWithState(ref);
    if (state === "closed") throw new IssueGoneError(ref, "closed");
    return issue;
  }

  async getIssueWithState(ref: IssueRef): Promise<Issue & { state: "open" | "closed" }> {
    let output: string;
    try {
      output = await this.gh(ref.path, ["issue", "view", String(ref.number), "--json", "title,body,comments,state"]);
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
    return {
      title: parsed.title,
      body: parsed.body,
      comments: parsed.comments.map((c) => c.body),
      state: parsed.state === "CLOSED" ? "closed" : "open",
    };
  }

  async listIssues(ref: RepoRef): Promise<OpenIssue[]> {
    const output = await this.gh(ref.path, [
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      String(OPEN_ISSUES_LIMIT),
      "--json",
      "number,title",
    ]);
    return JSON.parse(output) as OpenIssue[];
  }

  async addIssueComment(ref: IssueRef, body: string): Promise<void> {
    await this.gh(ref.path, ["issue", "comment", String(ref.number), "--body", body]);
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
