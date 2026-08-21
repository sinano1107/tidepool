import type { Clock } from "../src/clock.js";
import type {
  ChildDraftContext,
  DraftClient,
  HandoffDraft,
  IssueInspection,
  TaskDraft,
} from "../src/draft.js";
import type {
  CiStatus,
  CreatePrInput,
  GitHubClient,
  Issue,
  IssueRef,
  OpenIssue,
  PrRef,
  PrResult,
  RepoRef,
  RepoSlug,
} from "../src/github.js";
import type { PushClient, PushPayload, PushSubscription } from "../src/push.js";
import type { Task } from "../src/tasks.js";
import type { TranslationClient, TranslationResult } from "../src/translate.js";
import type { KillSignal, WorkerAdapter } from "../src/worker.js";

/** A reading well under the default threshold — the harness default so tests
 *  unrelated to throttling never need to script usage themselves. Exported
 *  so other hand-rolled WorkerAdapter fakes (e.g. worker-failure.test.ts)
 *  don't each carry their own copy of the panel text. */
/** Renders a Date the way the /usage panel renders the session window's
 *  reset (ADR 0028): no date, 12-hour clock, e.g. "5:59pm". */
export function formatSessionResetTime(d: Date): string {
  let hour = Number(d.toLocaleString("en-US", { timeZone: "UTC", hour: "numeric", hour12: false }));
  const minute = d.toLocaleString("en-US", { timeZone: "UTC", minute: "2-digit" });
  const meridiem = hour >= 12 ? "pm" : "am";
  hour = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour}:${minute.padStart(2, "0")}${meridiem}`;
}

/** Renders a Date the way the /usage panel renders the week window's reset:
 *  no year, English month, 12-hour clock, e.g. "Jul 9 at 5:59pm". */
export function formatUsageDate(d: Date): string {
  const month = d.toLocaleString("en-US", { timeZone: "UTC", month: "short" });
  const day = d.toLocaleString("en-US", { timeZone: "UTC", day: "numeric" });
  return `${month} ${day} at ${formatSessionResetTime(d)}`;
}

/** /usage パネルの1ウィンドウ分の観測値 — usagePanelText の入力。 */
export interface PanelWindow {
  percent: number;
  resetsAt: Date;
}

/** /usage パネルのテキストを1箇所で組み立てる(UTC 表記)— 行の書式
 *  (`N% used` / `Resets …`)がテストごとに複製されて実パネルとドリフト
 *  するのを防ぐ。fable は per-model 行なので省略可(Pro プラン形)。 */
export function usagePanelText(w: {
  session: PanelWindow;
  week: PanelWindow;
  fable?: PanelWindow;
}): string {
  const line = (label: string, percent: number, resets: string) =>
    `${label}\n${percent}% used\nResets ${resets} (UTC)\n`;
  return (
    line("Current session", w.session.percent, formatSessionResetTime(w.session.resetsAt)) +
    line("Current week (all models)", w.week.percent, formatUsageDate(w.week.resetsAt)) +
    (w.fable ? line("Current week (Fable)", w.fable.percent, formatUsageDate(w.fable.resetsAt)) : "")
  );
}

/** ペース基準 (ADR 0030) の「健全」は now に相対 — 経過割合はリセット時刻から
 *  逆算されるため、固定の panel 文字列は clock の前進でいずれ逆算不整合
 *  (fail-closed)に化ける。checkUsage のたびに now から生成することで、
 *  throttle と無関係なテストがどれだけ clock を進めても健全なままになる。
 *  session は3時間後リセット(経過40%、0% used はどのオフセットでも線の下)、
 *  week は2日後リセット(経過71%)。 */
export function healthyUsageText(now: Date): string {
  return usagePanelText({
    session: { percent: 0, resetsAt: new Date(now.getTime() + 3 * 60 * 60 * 1000) },
    week: { percent: 0, resetsAt: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000) },
  });
}

interface ScheduledInterval {
  fn: () => void;
  ms: number;
  nextAt: number;
  cancelled: boolean;
}

/** Deterministic clock: time moves only when the test calls advance(). */
export class FakeClock implements Clock {
  private t = 0;
  private intervals: ScheduledInterval[] = [];

  now(): Date {
    return new Date(this.t);
  }

  setInterval(fn: () => void, ms: number): () => void {
    const entry: ScheduledInterval = { fn, ms, nextAt: this.t + ms, cancelled: false };
    this.intervals.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = this.intervals
        .filter((i) => !i.cancelled && i.nextAt <= target)
        .sort((a, b) => a.nextAt - b.nextAt)[0];
      if (!due) break;
      this.t = due.nextAt;
      due.nextAt += due.ms;
      due.fn();
      // let async effects of the tick settle before firing the next one
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.t = target;
  }
}

/** Scripted stand-in at the WorkerAdapter seam: records what it was asked to
 *  start and killed, in call order. */
export class ScriptedWorker implements WorkerAdapter {
  readonly started: Task[] = [];
  readonly killed: Array<{ taskId: string; signal: KillSignal }> = [];
  /** undefined = 未スクリプト(checkUsage 時点の now から健全 text を生成)。
   *  null はスクリプトされた観測失敗(fail-closed)。 */
  private usageText: string | null | undefined = undefined;
  private usageGate: Promise<void> | null = null;

  constructor(
    private readonly clock: Clock,
    readonly id = "fake-worker",
  ) {}

  start(task: Task): void {
    this.started.push(task);
  }

  kill(taskId: string, signal: KillSignal): void {
    this.killed.push({ taskId, signal });
  }

  async checkUsage(): Promise<string | null> {
    if (this.usageGate) await this.usageGate;
    return this.usageText === undefined ? healthyUsageText(this.clock.now()) : this.usageText;
  }

  /** Scripts what the next checkUsage() call(s) return (ADR 0008) — the same
   *  seam the real ClaudeCodeWorker's `/usage` JIT poll returns through. Pass
   *  null to script a check failure (fail-closed). */
  scriptUsage(resultText: string | null): void {
    this.usageText = resultText;
  }

  /** Holds checkUsage in flight so tests observe the real PTY-latency race. */
  scriptUsageGate(gate: Promise<void>): void {
    this.usageGate = gate;
  }
}

/** Scripted stand-in at the GitHubClient seam (issue #19): records every PR
 *  request in call order; scriptFailure lets a test make the call throw
 *  without touching a real GitHub API. */
export class FakeGitHubClient implements GitHubClient {
  readonly requests: CreatePrInput[] = [];
  readonly issueFetches: IssueRef[] = [];
  readonly issueComments: Array<{ ref: IssueRef; body: string }> = [];
  readonly ciChecks: PrRef[] = [];
  readonly merged: PrRef[] = [];
  readonly mergeChecks: PrRef[] = [];
  private mergedOutside = new Set<number>();
  private mergeCheckFailures = new Map<number, Error>();
  private failure: Error | null = null;
  private issueFailure: Error | null = null;
  private issueFailures = new Map<number, Error>();
  private issueGate: Promise<void> | null = null;
  private nextNumber = 1;
  private ciStatus: CiStatus = "success";
  private issues = new Map<number, Issue>();
  readonly issueListFetches: RepoRef[] = [];
  private issueList: OpenIssue[] | null = null;
  private issueListFailure: Error | null = null;

  async createPullRequest(input: CreatePrInput): Promise<PrResult> {
    this.requests.push(input);
    if (this.failure) throw this.failure;
    const number = this.nextNumber++;
    return { url: `https://github.com/example/repo/pull/${number}`, number };
  }

  async getCiStatus(ref: PrRef): Promise<CiStatus> {
    this.ciChecks.push(ref);
    return this.ciStatus;
  }

  async mergePullRequest(ref: PrRef): Promise<void> {
    // GitHub refuses a merge on an already-merged PR; the fake must too, or
    // the poll's retry hole (ADR 0079 決定3) can't be reproduced here
    if (this.mergedOutside.has(ref.number)) {
      throw new Error(`PR #${ref.number} is already merged`);
    }
    this.merged.push(ref);
  }

  async isPullRequestMerged(ref: PrRef): Promise<boolean> {
    this.mergeChecks.push(ref);
    const failure = this.mergeCheckFailures.get(ref.number);
    if (failure) throw failure;
    return this.mergedOutside.has(ref.number);
  }

  /** Makes the merged read on one PR throw — an offline Pi, a repo the token
   *  lost, a GitHub outage. `gh` exits non-zero and the real client rethrows. */
  scriptMergeCheckFailure(number: number, err: Error): void {
    this.mergeCheckFailures.set(number, err);
  }

  /** Scripts the PR as merged by someone on GitHub's own surface, behind the
   *  board's back (ADR 0079) — every later merge attempt on it fails. */
  scriptMergedOutside(number: number): void {
    this.mergedOutside.add(number);
  }

  async getIssue(ref: IssueRef): Promise<Issue> {
    this.issueFetches.push(ref);
    if (this.issueGate) await this.issueGate;
    const perNumberFailure = this.issueFailures.get(ref.number);
    if (perNumberFailure) throw perNumberFailure;
    if (this.issueFailure) throw this.issueFailure;
    const issue = this.issues.get(ref.number);
    if (!issue) throw new Error(`no issue scripted for #${ref.number}`);
    return issue;
  }

  scriptFailure(err: Error | null): void {
    this.failure = err;
  }

  async listIssues(ref: RepoRef): Promise<OpenIssue[]> {
    this.issueListFetches.push(ref);
    if (this.issueListFailure) throw this.issueListFailure;
    return this.issueList ?? [];
  }

  /** Scripts what listIssues returns from here on (issue #67). */
  scriptIssueList(issues: OpenIssue[]): void {
    this.issueList = issues;
  }

  /** Makes listIssues throw from here on (issue #67). Pass null to clear. */
  scriptIssueListFailure(err: Error | null): void {
    this.issueListFailure = err;
  }

  /** Scripts what getCiStatus returns from here on (issue #11) — default
   *  "success" so tests unrelated to the merge dial never need to script it. */
  scriptCiStatus(status: CiStatus): void {
    this.ciStatus = status;
  }

  async addIssueComment(ref: IssueRef, body: string): Promise<void> {
    this.issueComments.push({ ref, body });
  }

  /** Scripts what getIssue(ref) returns for a given issue number (issue #49). */
  scriptIssue(number: number, issue: Issue): void {
    this.issues.set(number, issue);
  }

  /** Makes every getIssue call throw from here on (issue #49 §6: a live
   *  fetch failing mid-flight). Pass null to clear. */
  scriptIssueFailure(err: Error | null): void {
    this.issueFailure = err;
  }

  /** Makes getIssue throw for one specific issue number only, leaving every
   *  other number unaffected — for scenarios needing more than one live
   *  outcome at once (e.g. the issue-states preview script: #102 stuck
   *  failing while #104 still succeeds). Pass null to clear. */
  scriptIssueFailureFor(number: number, err: Error | null): void {
    if (err) this.issueFailures.set(number, err);
    else this.issueFailures.delete(number);
  }

  /** Holds every getIssue response until the given promise resolves (issue
   *  #49 §6: keeping a fetch in flight so a test can overlap requests). The
   *  call is still recorded in issueFetches immediately. */
  scriptIssueGate(gate: Promise<void>): void {
    this.issueGate = gate;
  }

  /** 修復経路の面(ADR 0093 決定8)が撃たれた回数。「正常時のネットワーク呼び出しを
   *  1つも増やさない」は数でしか確かめられない —— 到達できている pickup ではこれが
   *  0 のままである。 */
  repoAccessCalls = 0;
  private unreachable = new Map<string, string>();

  async canReach(ref: RepoSlug): Promise<string | null> {
    this.repoAccessCalls++;
    return this.unreachable.get(`${ref.owner}/${ref.name}`.toLowerCase()) ?? null;
  }

  /** 仲介が token を出せない repo と、その理由(仲介の HTTP status + error code)。
   *  既定は「出せる」—— App が install 済みで push を持つ、盤面が普段見る状態である。 */
  scriptUnreachable(
    fullName: string,
    reason = "the GitHub token broker refused a token for " +
      `${fullName} (HTTP 404: repo_unreachable)`,
  ): void {
    this.unreachable.set(fullName.toLowerCase(), reason);
  }
}

/** Scripted stand-in at the PushClient seam (issue #14): records every send
 *  in call order, no real network — the real WebPushClient talks to an
 *  actual push service, an external API a test never touches directly. */
export class FakePushClient implements PushClient {
  readonly sent: Array<{ subscription: PushSubscription; payload: PushPayload }> = [];
  private failingEndpoints = new Set<string>();

  async send(subscription: PushSubscription, payload: PushPayload): Promise<void> {
    if (this.failingEndpoints.has(subscription.endpoint)) {
      throw new Error(`push service rejected ${subscription.endpoint} (simulated 410 Gone)`);
    }
    this.sent.push({ subscription, payload });
  }

  /** Simulates a dead/expired subscription (410/404) for one endpoint —
   *  other endpoints keep succeeding. */
  scriptFailure(endpoint: string): void {
    this.failingEndpoints.add(endpoint);
  }
}

/** Scripted stand-in at the DraftClient seam (issue #12): records every dump
 *  it was asked to draft, in call order; scriptFailure lets a test simulate
 *  an LLM outage without touching a real model. */
export class FakeDraftClient implements DraftClient {
  readonly dumps: string[] = [];
  readonly languages: string[] = [];
  readonly contexts: (ChildDraftContext | undefined)[] = [];
  readonly handoffDumps: string[] = [];
  readonly handoffLanguages: string[] = [];
  readonly inspected: Issue[] = [];
  private response: TaskDraft = {
    title: "drafted title",
    purpose: "drafted purpose",
    completion_criteria: "drafted completion criteria",
  };
  private handoffResponse: HandoffDraft = {};
  private failure: Error | null = null;
  private handoffFailure: Error | null = null;
  // default pass, so tests unrelated to the gate never need to script it
  private inspection: IssueInspection = { ok: true };
  private inspectionByTitle = new Map<string, IssueInspection>();
  private inspectionFailure: Error | null = null;

  async draftTask(dump: string, language: string, context?: ChildDraftContext): Promise<TaskDraft> {
    this.dumps.push(dump);
    this.languages.push(language);
    this.contexts.push(context);
    if (this.failure) throw this.failure;
    return this.response;
  }

  async draftHandoff(dump: string, language: string): Promise<HandoffDraft> {
    this.handoffDumps.push(dump);
    this.handoffLanguages.push(language);
    if (this.handoffFailure) throw this.handoffFailure;
    return this.handoffResponse;
  }

  async inspectIssue(issue: Issue): Promise<IssueInspection> {
    this.inspected.push(issue);
    if (this.inspectionFailure) throw this.inspectionFailure;
    return this.inspectionByTitle.get(issue.title) ?? this.inspection;
  }

  scriptDraft(draft: TaskDraft): void {
    this.response = draft;
  }

  scriptHandoffDraft(draft: HandoffDraft): void {
    this.handoffResponse = draft;
  }

  /** Scripts the registration gate's verdict (issue #49 設計点4). */
  scriptInspection(inspection: IssueInspection): void {
    this.inspection = inspection;
    this.inspectionFailure = null;
  }

  /** Scripts the gate's verdict for one specific issue (matched by title),
   *  overriding the blanket scriptInspection default for that issue only —
   *  Issue carries no number (github.ts's Issue), so title is the seam's
   *  natural key. Lets a scenario show more than one verdict at once (e.g.
   *  the issue-states preview script: one issue rejected, another passing). */
  scriptInspectionForTitle(title: string, inspection: IssueInspection): void {
    this.inspectionByTitle.set(title, inspection);
  }

  scriptInspectionFailure(err: Error): void {
    this.inspectionFailure = err;
  }

  scriptFailure(err: Error): void {
    this.failure = err;
  }

  scriptHandoffFailure(err: Error): void {
    this.handoffFailure = err;
  }
}

const DEFAULT_TRANSLATION_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  estimated_cost_usd: 0.0001,
};

/** Scripted stand-in at the TranslationClient seam (issue #47): records every
 *  (source, language) pair it was asked to translate, in call order — tests
 *  assert on `.calls.length` to prove a cache hit skipped a real call. */
export class FakeTranslationClient implements TranslationClient {
  readonly calls: Array<{ source: string; language: string }> = [];
  private response: string | ((source: string) => string) = (source) => `[translated] ${source}`;
  private failure: Error | null = null;

  async translate(source: string, language: string): Promise<TranslationResult> {
    this.calls.push({ source, language });
    if (this.failure) throw this.failure;
    const text = typeof this.response === "function" ? this.response(source) : this.response;
    return { text, usage: DEFAULT_TRANSLATION_USAGE };
  }

  scriptTranslation(text: string | ((source: string) => string)): void {
    this.response = text;
  }

  scriptFailure(err: Error): void {
    this.failure = err;
  }
}
