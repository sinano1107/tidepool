import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DomainError } from "./domain-error.js";
import { assertGhVersion, GH_CLI_VERSION, GhVersionError } from "./gh-cli-version.js";
import { authedPush, GIT_NETWORK_TIMEOUT_MS, type GitHubAuth, githubKey, HEAD_REPO_REMOTE, landingHeadRepo, workspaceNetworkDestination } from "./github-auth.js";
import { GITHUB_APP_SLUG } from "./github-login.js";
import { parseGitHubRepo, repositoryLabel } from "./repo-access.js";
import type { WorkspaceConfig } from "./workspace.js";

const execFileAsync = promisify(execFile);

/** どの checkout のどのタスクブランチを出元 repo へ push するか。 */
export interface PushBranchInput extends RepoRef {
  branch: string;
}

/** ADR 0376 Status 追記(#3605): the convergence push carries the head ADR 0376 決定2 judged as its lease —— `""` when the read
 *  found no branch. */
export interface PreparePushInput extends PushBranchInput {
  expected: string;
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
export interface PrRef extends RepoRef {
  number: number;
}

/** Which workspace checkout to run `gh` from, and which issue (issue #49) —
 *  same shape as PrRef, one per resource. */
export interface IssueRef extends RepoRef {
  number: number;
}

/** Which workspace checkout to run `gh` from — listIssues' only input (issue
 *  #67): unlike PrRef/IssueRef there is no specific number, the listing
 *  covers the whole repository. */
export interface RepoRef {
  workspace: WorkspaceConfig;
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

export interface PrBase {
  branch: string;
  sha: string;
}

export interface PrHeadRef {
  branch: string;
  repo: string;
}

/** The PR's state, who merged it, head and live base, read together (ADR 0265 決定5 / ADR 0376 決定1 / ADR 0395 決定4).
 *  `mergedBy` is `gh`'s `mergedBy.login`, null unless merged. */
export interface PrStateRead {
  state: PrState;
  mergedBy: string | null;
  head: string;
  headRef?: PrHeadRef;
  base?: PrBase;
}

/** The PR found on a task branch, whatever its state (ADR 0241 決定4). */
export interface FoundPr extends Pick<PrStateRead, "state" | "head" | "base" | "headRef"> {
  number: number;
}

/** One read of a PR, CI, state, merger and head together (ADR 0229 決定2 / ADR 0231
 *  決定1 / ADR 0265 決定5): `head` is the commit the CI was read on, the one a merge pins to. A
 *  read that failed is CI "pending" and state "unreadable" with no head —
 *  never a state the caller would act on. The gh version gate's refusal is thrown instead (ADR 0402 決定3). */
export type PrStatus =
  | (PrStateRead & { ci: CiStatus })
  | { ci: "pending"; state: "unreadable" };

type GhPrState = {
  state: PrState;
  headRefOid: string;
  headRefName?: string;
  headRepository?: { nameWithOwner?: string } | null;
  mergedBy: { login: string } | null;
  baseRefName?: string | null;
  baseRefOid?: string | null;
};

function prStateRead(parsed: GhPrState): PrStateRead {
  const { state, mergedBy, headRefOid, headRefName, headRepository, baseRefName, baseRefOid } = parsed;
  return {
    state,
    mergedBy: mergedBy?.login ?? null,
    head: headRefOid,
    ...(headRefName && headRepository?.nameWithOwner && { headRef: { branch: headRefName, repo: headRepository.nameWithOwner } }),
    ...(baseRefName && baseRefOid && { base: { branch: baseRefName, sha: baseRefOid } }),
  };
}

/** ADR 0016's 確定的失敗 (permanent failure) of an issue-backed task's live
 *  reference, as part of getIssue's contract: the referenced issue is gone
 *  for good — deleted/never existed (`not_found`) or already closed
 *  (`closed`). Callers route this to the retry/abandon failure question;
 *  every other getIssue error is 一時的 (temporary — network, GitHub outage)
 *  and passes through untyped, handled as a pickup-cycle skip instead. */
export class IssueGoneError extends Error {
  constructor(
    ref: Pick<IssueRef, "number">,
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
  /** push 済みのタスクブランチに、出元 repo を head にした PR を開く(ADR 0395 決定1)。開くのは盤面にログインした人間の
   *  user token である(ADR 0396 決定1)。push は呼び手が `preparePush` で先に撃つ ——
   *  盤面の push は基準への予告で包む口を通る(ADR 0243)。 */
  createPullRequest(input: CreatePrInput): Promise<PrResult>;
  /** タスクブランチを出元 repo へ push する。
   *  PR 作成の前段であると同時に、**既に開いている PR の更新**でもある: 付帯子の
   *  修理が merge back されたタスクブランチを押し直すと、その PR が黙って更新される
   *  (ADR 0053 / issue #400)。
   *
   *  token の取得(仲介への往復)だけをここで済ませ、push そのものは返した同期の関数が撃つ —— 盤面は push を
   *  基準への予告と畳みの同期区間の中で撃つ(ADR 0243)。返した関数は予告した sha を受け、その sha を押して写しに書く ——
   *  予告の後にブランチが進んでも、口が知らない値は書かない(ADR 0243 決定1)。push は `expected` を lease として載せ、出元 repo の
   *  ブランチが判断した値から動いていれば落ちる(ADR 0376 Status 追記、#3605)。 */
  preparePush(input: PreparePushInput): Promise<(sha: string) => void>;
  readPullRequest(ref: PrRef): Promise<PrStatus>;
  /** Merges only while the PR's head is still `head` — the one whose CI was
   *  read (ADR 0231 決定1); GitHub refuses it once the head has moved.
   *  `beforeMerge` may refuse in the same synchronous section as spawn, after token acquisition (ADR 0330 決定1). */
  mergePullRequest(ref: PrRef, head: string, beforeMerge?: () => void): Promise<void>;
  /** The PR's state and who merged it (ADR 0079 決定3 / ADR 0229 / ADR 0265 決定5) — the read the board needs to
   *  tell "the merge is still mine to make" from "someone merged or closed it
   *  outside the board". Only asked on the two surfaces the board holds a
   *  decision on (an open merge question, the auto-merge queue) and before
   *  pushing a repair onto a still-open PR (issue #400), never as a standing
   *  watch over every open PR. The same read gives the head convergence checks before that push (ADR 0376 決定1).
   *  Throws when it cannot be read. */
  getPullRequestState(ref: PrRef): Promise<PrStateRead>;
  /** The PR whose head is `branch` in the declared head repo, or null. Read before opening one (ADR 0241 決定4) and,
   *  with a number, before updating that PR. The author is the human who opened it (ADR 0396 帰結).
   *  Throws when it cannot be read. */
  findPullRequestByHead(input: PushBranchInput & { number?: number }): Promise<FoundPr | null>;
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
  /** The repository `ref` was forked from, or null when it is no fork (ADR 0395 決定2). Read with `ref`'s own token: a token for
   *  the base cannot see a private fork (#3558). Throws when it cannot be read. */
  repositoryParent(ref: RepoSlug): Promise<RepoSlug | null>;
  /** The declared repo's fork pull request workflow settings that send credentials to a fork PR's workflows and are on; empty
   *  when none is on or the repo is public (which has no such setting and sends none). ADR 0395 決定6 and its 2026-11-22 Status
   *  line (#3564): read with the declared repo's installation token, which the App's Administration: read lets read them.
   *  Throws when it cannot be read. */
  forkPrCredentialSettings(ref: RepoRef): Promise<ForkPrCredentialSetting[]>;
}

/** The fork PR workflow settings that send credentials to a fork PR's workflows (ADR 0395 決定6). */
const FORK_PR_CREDENTIAL_SETTINGS = ["send_write_tokens_to_workflows", "send_secrets_and_variables"] as const;
export type ForkPrCredentialSetting = (typeof FORK_PR_CREDENTIAL_SETTINGS)[number];

/** Each setting's label on GitHub's settings page, for the refusal a human reads. */
const FORK_PR_CREDENTIAL_LABELS: Record<ForkPrCredentialSetting, string> = {
  send_write_tokens_to_workflows: "Send write tokens to workflows from fork pull requests",
  send_secrets_and_variables: "Send secrets and variables to workflows from fork pull requests",
};

/** ADR 0395 決定6 and its 2026-11-22 Status line (#3564): why the board must not push to the head repo of `workspace`, or null.
 *  A private declared repo that sends write tokens or secrets to fork PRs' workflows would hand the pushed content its
 *  credentials; an unreadable setting refuses too (fail-closed). Landing's push and the declaration's task-branch send both ask
 *  this. A DomainError from the read (the declaration changed under it) is that stop, not a failed read, and is rethrown. */
export async function forkPrCredentialRefusal(github: GitHubClient, workspace: WorkspaceConfig, headRepoLabel: string): Promise<string | null> {
  const repo = repositoryLabel(workspace.repo ?? workspace.name);
  const where = `${repo}'s Settings → Actions → General → "Fork pull request workflows in private repositories"`;
  let settings: ForkPrCredentialSetting[];
  try {
    settings = await github.forkPrCredentialSettings({ workspace });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const cause = error instanceof Error ? error.message : String(error);
    // only a refusal of the token says the permission is missing; a timeout, an outage or a malformed answer keeps its own cause
    const permission = /HTTP 403|Resource not accessible by integration/.test(cause)
      ? ` The ${GITHUB_APP_SLUG} App needs the Administration: read repository permission to read them (${where}).`
      : "";
    return `could not read declared repo ${repo}'s fork pull request workflow settings (${cause}), so the board did not push to head repo ${headRepoLabel}.${permission}`;
  }
  if (settings.length === 0) return null;
  return `declared repo ${repo} sends credentials to workflows from fork pull requests (${settings.map((key) => FORK_PR_CREDENTIAL_LABELS[key]).join("; ")}), ` +
    `so the board did not push to head repo ${headRepoLabel}. Turn them off in ${where}.`;
}

/** Which repository, as GitHub's own `owner/name` (ADR 0067). */
export interface RepoSlug {
  owner: string;
  name: string;
}

/** ADR 0396 決定5: 作者が人間になる PR を、人間が手で開いた PR と見分ける手がかり。 */
const PR_OPENED_BY = "Opened by the tidepool board.";

/** The declared GitHub repo, read from the rechecked declaration (ADR 0378 決定1); `call` names what cannot run without it. */
function declaredRepo(workspace: WorkspaceConfig, call: string): RepoSlug {
  const repo = workspaceNetworkDestination(workspace)?.github;
  if (repo === undefined) throw new Error(`\`${call}\` cannot run: workspace ${workspace.name} has no declared GitHub repo`);
  return repo;
}

/** ADR 0395 決定1・2: create/find use a head in the declared fork. */
function headRepoOf(workspace: WorkspaceConfig, call: string): RepoSlug {
  const headRepo = landingHeadRepo(workspace);
  if (headRepo.github === undefined) throw new Error(`\`${call}\` cannot run: workspace ${workspace.name}'s head repo ${repositoryLabel(headRepo.source)} is not a GitHub repo`);
  return headRepo.github;
}

/** At most the first 300 characters of a GitHub answer that is not GitHub's JSON (a gateway's HTML page), for a human's question. */
function excerpt(text: string): string {
  return text.trim().slice(0, 300);
}

/** A GitHub answer's JSON, or undefined when its body is not JSON (a proxy's error page). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

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
 *  fresh via GitHubAuth, never the host's ambient `gh auth`. The one exception is
 *  opening a PR: the board sends that REST request itself, in process, with the logged-in human's user token
 *  (ADR 0396 決定1・3). */
export class GhCliClient implements GitHubClient {
  private readonly timeoutMs: number;
  private readonly apiUrl: string;
  /** 版の門(ADR 0402 決定2)の `gh --version` の読み。「gh の版」の回答の受理も同じこれを読む(合成 root が渡す)。 */
  readonly readGhVersion: () => Promise<string>;
  private readonly ghVersion: string;

  /** `timeoutMs` はテストが上限を短くするためだけにある —— 本番の呼び手は既定のまま(#2726 の完了基準、釘は ADR 0107 の domain 層)。
   *  `apiUrl` もテストだけのもので、PR の作成の REST を loopback の GitHub の代役へ向ける。
   *  `readGhVersion` と `ghVersion` もテストだけのもので、版の門の読みと宣言を差し替える —— 本番は既定(本体と同じ PATH の
   *  `gh --version` と `gh-cli-version`)。 */
  constructor(
    private readonly auth: GitHubAuth,
    { timeoutMs = GIT_NETWORK_TIMEOUT_MS, apiUrl = "https://api.github.com", readGhVersion, ghVersion = GH_CLI_VERSION }: {
      timeoutMs?: number;
      apiUrl?: string;
      readGhVersion?: () => Promise<string>;
      ghVersion?: string;
    } = {},
  ) {
    this.timeoutMs = timeoutMs;
    this.apiUrl = apiUrl;
    this.ghVersion = ghVersion;
    this.readGhVersion = readGhVersion ?? (async () => {
      try {
        return (await execFileAsync("gh", ["--version"], { env: this.auth.env(undefined), timeout: this.timeoutMs })).stdout;
      } catch (err) {
        if ((err as { killed?: boolean }).killed) throw new Error(`\`gh --version\` timed out after ${this.timeoutMs} ms`, { cause: err });
        throw err;
      }
    });
  }

  /** 宣言の repo への `-R` を取る `gh`(`gh pr`・`gh issue`)はここを通る。`-R` を取らない `gh api` は `warmDeclaredRepo` と `run` を
   *  直に使う(`findPullRequestByHead`)。どちらも上限は `run` の1箇所で効く(ADR 0330 決定4)。宣言の repo の token を温め(ADR 0378 決定1)、
   *  `gh` を非同期の子として撃つ —— 待つ間も盤面の実行の糸は止まらない(ADR 0330 決定1)。
   *  上限超過は untyped の一時的失敗で、どの呼び出しが何 ms で切れたかを人間が読める文で持つ(決定2)。それ以外の失敗は
   *  `stderr` を持ったまま投げ直す(not-found の判定が読む)。 */
  private async gh(workspace: WorkspaceConfig, args: string[], beforeSpawn?: () => void): Promise<string> {
    const repo = await this.warmDeclaredRepo(workspace, `gh ${args[0]} ${args[1]}`);
    return this.run([...args, "-R", repo], repo, workspace, beforeSpawn);
  }

  /** The declared repo, with its token warmed. */
  private async warmDeclaredRepo(workspace: WorkspaceConfig, call: string): Promise<string> {
    const repo = githubKey(declaredRepo(workspace, call));
    await this.auth.ensureToken(repo);
    return repo;
  }

  /** ADR 0330 決定1・4 / ADR 0399 決定3: recheck the destination and the caller's guard in the same synchronous section as spawning `gh`.
   *  ADR 0402 決定2: every call reads gh's version first; the read awaits, so it sits before that section. */
  private async run(args: string[], repo: string, workspace?: WorkspaceConfig, beforeSpawn?: () => void): Promise<string> {
    await assertGhVersion(this.readGhVersion, this.ghVersion);
    if (workspace && workspaceNetworkDestination(workspace)?.key !== repo) throw new Error(`workspace ${workspace.name}'s GitHub destination changed while acquiring its token`);
    beforeSpawn?.();
    const cwd = workspace?.path;
    try {
      return (await execFileAsync("gh", args, { cwd, env: this.auth.env(repo), timeout: this.timeoutMs })).stdout;
    } catch (err) {
      // `killed` は Node 自身が上限で殺したときだけ立つ —— 非ゼロ終了・maxBuffer 超過・外からの signal では立たない
      if ((err as { killed?: boolean }).killed) {
        throw new Error(`\`gh ${args[0]} ${args[1]}\` timed out after ${this.timeoutMs} ms${cwd === undefined ? "" : ` (in ${cwd})`}`, { cause: err });
      }
      throw err;
    }
  }

  async repositoryParent(ref: RepoSlug): Promise<RepoSlug | null> {
    const repo = githubKey(ref);
    await this.auth.ensureToken(repo);
    // `gh api` takes no `-R`; the path names the repository
    const parent = (await this.run(["api", `repos/${repo}`, "--jq", ".parent.full_name // empty"], repo)).trim();
    return parent === "" ? null : (parseGitHubRepo(parent) ?? null);
  }

  async forkPrCredentialSettings({ workspace }: RepoRef): Promise<ForkPrCredentialSetting[]> {
    const repo = await this.warmDeclaredRepo(workspace, "gh api");
    const visibility = (await this.run(["api", `repos/${repo}`, "--jq", ".private"], repo, workspace)).trim();
    // ADR 0395 決定6 / 2026-11-22 Status line (#3564): a public repo has no such setting and answers its read with 422 —
    // decide by visibility, and read nothing else as public
    if (visibility === "false") return [];
    if (visibility !== "true") throw new Error(`\`gh api repos/${repo}\` returned no visibility: ${excerpt(visibility) || "empty output"}`);
    const path = `repos/${repo}/actions/permissions/fork-pr-workflows-private-repos`;
    const text = await this.run(["api", path], repo, workspace);
    const settings = parseJson(text) as Record<string, unknown> | undefined;
    if (FORK_PR_CREDENTIAL_SETTINGS.some((key) => typeof settings?.[key] !== "boolean")) throw new Error(`\`gh api ${path}\` returned an unexpected response: ${excerpt(text)}`);
    return FORK_PR_CREDENTIAL_SETTINGS.filter((key) => settings![key]);
  }

  async preparePush(input: PreparePushInput): Promise<(sha: string) => void> {
    await this.auth.ensureToken(landingHeadRepo(input.workspace).key);
    return (sha) => authedPush(this.auth, input.workspace, this.timeoutMs, [[input.branch, sha, input.expected]], HEAD_REPO_REMOTE);
  }

  /** ADR 0396 決定3: the user token reaches only this in-process request, never a `gh` or git child's env (ADR 0093 決定4).
   *  ADR 0330 決定1: nothing is awaited between reading the declaration and sending the request, so it is sent to the
   *  declaration it read. */
  async createPullRequest(input: CreatePrInput): Promise<PrResult> {
    const call = "POST pulls";
    const repo = declaredRepo(input.workspace, call);
    const prHead = `${headRepoOf(input.workspace, call).owner}:${input.branch}`;
    const target = `\`${call}\` on ${githubKey(repo)}`;
    const token = this.auth.token();
    let status: number;
    let text: string;
    try {
      const response = await fetch(new URL(`/repos/${githubKey(repo)}/pulls`, this.apiUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "tidepool-board",
        },
        body: JSON.stringify({
          head: prHead,
          base: input.base,
          title: input.title,
          body: `${input.body}\n\n${PR_OPENED_BY}`,
          // ADR 0396 決定4: 宣言の repo の maintainer に PR の head への push を開かない
          maintainer_can_modify: false,
        }),
        // fetch cannot go through `run`: the same bound value as `run`'s, ADR 0330 決定4's single limit
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (err) {
      if ((err as { name?: string }).name === "TimeoutError") throw new Error(`${target} timed out after ${this.timeoutMs} ms`, { cause: err });
      throw new Error(`${target} could not reach GitHub: ${String(err)}`, { cause: err });
    }
    const parsed = parseJson(text) as { html_url?: unknown; number?: unknown; message?: unknown; errors?: Array<{ message?: unknown; code?: unknown }> } | undefined;
    if (status < 200 || status >= 300) {
      const detail = parsed ? [parsed.message, ...(parsed.errors ?? []).map((e) => e.message ?? e.code)].filter(Boolean).join("; ") : excerpt(text);
      throw new Error(`${target} was refused for head ${prHead} (HTTP ${status}: ${detail || "no error text"})`);
    }
    if (typeof parsed?.html_url !== "string" || typeof parsed.number !== "number") throw new Error(`${target} returned an unexpected response: ${excerpt(text)}`);
    return { url: parsed.html_url, number: parsed.number };
  }

  async readPullRequest(ref: PrRef): Promise<PrStatus> {
    // `gh pr checks` はチェック未設定でも「非ゼロ終了 + stdout 空」で、認証・
    // ネットワーク失敗と区別がつかない —— 取得失敗が緑に化ける(issue #427)。
    // `gh pr view --json statusCheckRollup` は未設定なら exit 0 + 空配列を返し、
    // 非ゼロ終了は「読めなかった」だけを意味する。token 取得(仲介への往復)も
    // 同じ try に入れて、どちらの失敗も pending / unreadable に倒す。
    let parsed: GhPrState & { statusCheckRollup?: RollupEntry[] };
    try {
      parsed = JSON.parse(
        await this.gh(ref.workspace, ["pr", "view", String(ref.number), "--json", "state,statusCheckRollup,headRefOid,mergedBy,baseRefName,baseRefOid,headRefName,headRepository"]),
      );
    } catch (err) {
      // ADR 0402 決定3: 版の門の拒否は読めなかったのではなく止まった —— 呼び手が待つか拒むかを決める
      if (err instanceof GhVersionError) throw err;
      return { ci: "pending", state: "unreadable" };
    }
    return {
      ci: ciStatusOf(parsed.statusCheckRollup ?? []),
      ...prStateRead(parsed),
    };
  }

  async mergePullRequest(ref: PrRef, head: string, beforeMerge?: () => void): Promise<void> {
    await this.gh(ref.workspace, ["pr", "merge", String(ref.number), "--merge", "--match-head-commit", head], beforeMerge);
  }

  async getPullRequestState(ref: PrRef): Promise<PrStateRead> {
    const output = await this.gh(ref.workspace, ["pr", "view", String(ref.number), "--json", "state,mergedBy,headRefOid,baseRefName,baseRefOid,headRefName,headRepository"]);
    return prStateRead(JSON.parse(output) as GhPrState);
  }

  /** ADR 0396 帰結: the author is the human who opened it, so the board's PR is matched by its head repo, never its author.
   *  Read with the declared repo's installation token, which also sees a private head repo's PR here (#3558). */
  async findPullRequestByHead(input: PushBranchInput & { number?: number }): Promise<FoundPr | null> {
    const { workspace, branch, number } = input;
    const call = "gh api";
    const repo = await this.warmDeclaredRepo(workspace, call);
    // ADR 0330 決定1: the head repo is read after the await, from the rechecked declaration
    const headRepo = headRepoOf(workspace, call);
    const headRepoKey = githubKey(headRepo);
    const output = await this.run(
      ["api", `repos/${repo}/pulls`, "--method", "GET", "-f", `head=${headRepo.owner}:${branch}`, "-f", "state=all"],
      repo,
      workspace,
    );
    // a PR from another fork's same-named branch is not the board's; a deleted fork leaves `head.repo` null
    const prs = (
      JSON.parse(output) as Array<{ number: number; state: string; merged_at: string | null; head: { ref: string; sha: string; repo: { full_name: string } | null }; base?: { ref: string; sha: string } }>
    )
      .filter((p) => (number === undefined || p.number === number) && p.head.ref === branch && p.head.repo?.full_name.toLowerCase() === headRepoKey)
      .map((p): FoundPr => ({
        number: p.number, state: p.merged_at ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED", head: p.head.sha,
        headRef: { branch: p.head.ref, repo: p.head.repo!.full_name },
        ...(p.base && { base: { branch: p.base.ref, sha: p.base.sha } }),
      }));
    // an open PR wins, then a merged one, over closed ones on the same branch
    return prs.find((p) => p.state === "OPEN") ?? prs.find((p) => p.state === "MERGED") ?? prs[0] ?? null;
  }

  async getIssue(ref: IssueRef): Promise<Issue> {
    const { state, ...issue } = await this.getIssueWithState(ref);
    if (state === "closed") throw new IssueGoneError(ref, "closed");
    return issue;
  }

  async getIssueWithState(ref: IssueRef): Promise<Issue & { state: "open" | "closed" }> {
    let output: string;
    try {
      output = await this.gh(ref.workspace, ["issue", "view", String(ref.number), "--json", "title,body,comments,state"]);
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
    const output = await this.gh(ref.workspace, [
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
    await this.gh(ref.workspace, ["issue", "comment", String(ref.number), "--body", body]);
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
