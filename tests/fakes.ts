import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import type {
  AllocationClient,
  AllocationJudgment,
  AllocationReviewInput,
} from "../src/allocation-review.js";
import type {
  AttributionClient,
  AttributionInput,
  AttributionJudgment,
  BehaviorDraft,
  BehaviorDraftClient,
  BehaviorDraftInput,
} from "../src/attribution.js";
import { type BoardCall, createBoardCalls } from "../src/board-call.js";
import type { Clock } from "../src/clock.js";
import type { CodexAppServerProbeResult } from "../src/codex-app-server.js";
import type {
  ChildDraftContext,
  DraftClient,
  HandoffDraft,
  IssueInspection,
  TaskDraft,
} from "../src/draft.js";
import type { ExecutionSetting, ExecutionSettingRow } from "../src/execution-setting.js";
import type {
  CiStatus,
  CreatePrInput,
  GitHubClient,
  Issue,
  IssueRef,
  OpenIssue,
  PrRef,
  PrResult,
  PushBranchInput,
  RepoRef,
  RepoSlug,
} from "../src/github.js";
import type { Landing } from "../src/landing.js";
import {
  type ContainedProcess,
  type ContainerRuntime,
  type ContainerRuntimeCapability,
  type ContainerSpawn,
  defaultSpawn,
  isSpawnFailure,
  type ProcessContainer,
  ProcessContainers,
  type PtyFn,
} from "../src/process-container.js";
import type { PushClient, PushPayload, PushSubscription } from "../src/push.js";
import type { Task } from "../src/tasks.js";
import type { TranslationClient, TranslationResult } from "../src/translate.js";
import { RECLAIM_TIMEOUT } from "../src/watchdog.js";
import type { WorkerAdapter } from "../src/worker.js";

/** Required landing dependency for tests whose exercised door cannot reach a
 * landing path. A mistaken land call fails loudly; ancestor re-fire is a
 * legitimate no-op when the fixture has no completed work ancestor. */
export const unusedLanding: Landing = {
  async land() {
    throw new Error("unexpected landing call");
  },
  async relandAncestors() {
    return [];
  },
  async observeMergedPullRequest() {
    return false;
  },
  async tick() {},
};

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

interface ScheduledTimer {
  fn: () => void;
  ms: number;
  nextAt: number;
  cancelled: boolean;
  /** false = one-shot (setTimeout): marks itself done instead of rescheduling. */
  repeat: boolean;
}

/** Deterministic clock: time moves only when the test calls advance(). */
export class FakeClock implements Clock {
  private t = 0;
  private timers: ScheduledTimer[] = [];

  now(): Date {
    return new Date(this.t);
  }

  setInterval(fn: () => void, ms: number): () => void {
    return this.schedule(fn, ms, true);
  }

  setTimeout(fn: () => void, ms: number): () => void {
    return this.schedule(fn, ms, false);
  }

  private schedule(fn: () => void, ms: number, repeat: boolean): () => void {
    const entry: ScheduledTimer = { fn, ms, nextAt: this.t + ms, cancelled: false, repeat };
    this.timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((i) => !i.cancelled && i.nextAt <= target)
        .sort((a, b) => a.nextAt - b.nextAt)[0];
      if (!due) break;
      this.t = due.nextAt;
      if (due.repeat) due.nextAt += due.ms;
      else due.cancelled = true;
      due.fn();
      // let async effects of the tick settle before firing the next one
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.t = target;
  }
}

/** Scripted stand-in at the WorkerAdapter seam: records what it was asked to
 *  start and to fold up, in call order. 強制回収は adapter が**選ぶ**ものではなく
 *  盤面側 supervisor の操作である(ADR 0099 決定2)—— adapter が持つのは「root process が
 *  exit した」の観測点だけで、そこで supervisor に force を撃たせる(ADR 0109 決定4)。
 *  それが `exit` である。 */
export class ScriptedWorker implements WorkerAdapter {
  readonly started: Task[] = [];
  /** 盤面が pickup の瞬間に選んだ実行設定(ADR 0110 決定3 / issue #544)。実 adapter は
   *  これを spawn にピン留めして `worker_spawned` に刻む —— 盤面境界で観測できるのは
   *  「何を渡したか」までで、刻まれることは adapter の seam が1度だけ言う。 */
  readonly startedSettings: (ExecutionSetting | undefined)[] = [];
  readonly gracefulStops: string[] = [];
  readonly exits: string[] = [];
  private containers: ProcessContainers | undefined;
  private startFailure: Error | undefined;
  /** 盤面が factory で渡す「worker が1度も走らなかった」の一撃(ADR 0118)。 */
  onSpawnFailed: ((taskId: string, failure: { error_code: string | null; message: string }) => void) | undefined;
  /** undefined = 未スクリプト(checkUsage 時点の now から健全 text を生成)。
   *  null はスクリプトされた観測失敗(fail-closed)。 */
  private usageText: string | null | undefined = undefined;
  private usageGate: Promise<void> | null = null;

  constructor(
    private readonly clock: Clock,
    readonly id = "fake-worker",
  ) {}

  start(task: Task, setting?: ExecutionSetting): void {
    this.started.push(task);
    this.startedSettings.push(setting);
    const failure = this.startFailure;
    this.startFailure = undefined;
    if (failure) throw failure;
  }

  /** 次の `start` 1回だけを同期で投げさせる(ADR 0118 の同期側の観測点)。 */
  scriptStartFailure(error: Error): void {
    this.startFailure = error;
  }

  /** Node の `spawn()` が非同期に失敗した、の観測(ADR 0118 の adapter 側の観測点)。 */
  failSpawn(taskId: string, error_code: string, message: string): void {
    this.onSpawnFailed?.(taskId, { error_code, message });
  }

  gracefulStop(taskId: string): void {
    this.gracefulStops.push(taskId);
  }

  /** 盤面側 supervisor を渡す(本番の adapter が factory で受け取るのと同じもの)。 */
  useContainers(containers: ProcessContainers): void {
    this.containers = containers;
  }

  /** この session の root process が exit した、の観測(ADR 0109 決定4)。実 adapter が
   *  usage と transcript を書いた後にすることと同じ —— 盤面 supervisor 経由で容器を
   *  強制回収する。**送達であって回収の完了ではない**: 空になるかどうかは容器の側
   *  (`FakeContainerRuntime`)が決め、`hold` された容器はこれでは空にならない。 */
  exit(taskId: string): void {
    this.exits.push(taskId);
    this.containers?.forceReclaim(taskId);
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

/** Scripted stand-in at the PTY boundary (issue #81 / ADR 0028): the test
 *  drives data emission and process exit, and reads back the spawn recipe,
 *  what checkUsage wrote to stdin, and every kill sent to the session (checkUsage sends
 *  none — the mouth's force reclaims the container, ADR 0136 決定8). */
export function recordingPty() {
  const calls: Array<{
    command: string;
    args: string[];
    cwd: string;
    cols: number;
    rows: number;
    env: NodeJS.ProcessEnv;
  }> = [];
  const writes: string[] = [];
  const kills: Array<string | undefined> = [];
  let dataListener: ((data: string) => void) | undefined;
  // node-pty の onExit は複数の listener を持てる —— 口と checkUsage の両方が聞く
  const exitListeners: Array<() => void> = [];
  const pty: PtyFn = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, cols: opts.cols, rows: opts.rows, env: opts.env });
    return {
      onData: (listener) => {
        dataListener = listener;
      },
      write: (data) => {
        writes.push(data);
      },
      kill: (signal) => {
        kills.push(signal);
      },
      onExit: (listener) => {
        exitListeners.push(listener);
      },
    };
  };
  return {
    pty,
    calls,
    writes,
    kills,
    emitData: (data: string) => dataListener?.(data),
    emitExit: () => {
      for (const listener of exitListeners) listener();
    },
  };
}

/** 容器機構 seam の scripted stand-in(ADR 0099 決定2)。既定の容器は
 *  強制回収を受けた時点で空になる(実機構がそう振る舞うのが正常)。空にならない
 *  容器 — 回収に失敗するホスト — は `hold` で明示的にスクリプトし、`fireEmpty`
 *  で好きな瞬間に「空になった signal」を撃つ。 */
export class FakeContainerRuntime implements ContainerRuntime {
  readonly forceReclaims: string[] = [];
  /** 作られた容器の id を作られた順に。Board call の容器 id は口が振るので、
   *  テストはここから読む(`board-call-1` のような綴りに結び付けない)。 */
  readonly created: string[] = [];
  /** 機構前提検査に渡った「今生きている容器」の記録(ADR 0099 決定5)。稼働中の
   *  Board call の容器を前回の run の残骸と読み違えないため、単位を問わずここに載る。 */
  readonly preflightLive: Array<ReadonlySet<string>> = [];
  private readonly held = new Set<string>();
  private readonly markEmpty = new Map<string, () => void>();
  private capability: ContainerRuntimeCapability = { available: true };

  /** `spawn` は容器の中で走る process を作る口。ScriptedWorker の盤面は1つも
   *  spawn しないので、実 adapter を通すテストだけが渡す。 */
  constructor(private readonly spawn?: ContainerSpawn) {}

  /** 機構前提検査を不成立にスクリプトする。reason 無しで呼ぶと成立に戻る
   *  (修理済みのホスト)。 */
  scriptPreflight(reason?: string): void {
    this.capability = reason === undefined ? { available: true } : { available: false, reason };
  }

  /** この id の容器は強制回収では空にならない — 空の観測は `fireEmpty`
   *  だけが起こす。 */
  hold(id: string): void {
    this.held.add(id);
  }

  /** 「容器が空になった」signal を撃つ。 */
  fireEmpty(id: string): void {
    this.markEmpty.get(id)?.();
  }

  preflight(live: ReadonlySet<string> = new Set()): ContainerRuntimeCapability {
    this.preflightLive.push(live);
    return this.capability;
  }

  create(id: string): ProcessContainer {
    this.created.push(id);
    let markEmpty!: () => void;
    const reclaimed = new Promise<void>((resolve) => {
      markEmpty = resolve;
    });
    this.markEmpty.set(id, markEmpty);
    return {
      spawn: (command, args, opts): ContainedProcess => {
        if (!this.spawn) throw new Error("fake container runtime: no spawn scripted");
        return this.spawn(command, args, opts);
      },
      spawnPty: (launch, command, args, opts) => launch(command, args, opts),
      forceReclaim: () => {
        this.forceReclaims.push(id);
        if (!this.held.has(id)) markEmpty();
      },
      reclaimed,
    };
  }
}

/** Scripted stand-in at the GitHubClient seam (issue #19): records every PR
 *  request in call order; scriptFailure lets a test make the call throw
 *  without touching a real GitHub API. */
export class FakeGitHubClient implements GitHubClient {
  readonly requests: CreatePrInput[] = [];
  readonly pushes: PushBranchInput[] = [];
  readonly issueFetches: IssueRef[] = [];
  readonly issueComments: Array<{ ref: IssueRef; body: string }> = [];
  readonly ciChecks: PrRef[] = [];
  readonly merged: PrRef[] = [];
  readonly mergeChecks: PrRef[] = [];
  private mergedOutside = new Set<number>();
  private mergeCheckFailures = new Map<number, Error>();
  private failure: Error | null = null;
  private pushFailure: Error | null = null;
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

  /** 記録するだけでなく**実際に push する** —— `refs/remotes/origin/<branch>` が動か
   *  なければ、盤面が自分の書き込みを撮り直したか(ADR 0064 決定4)を測れない。
   *  origin を持たない checkout(purely-local)には呼ばれない。 */
  async pushBranch(input: PushBranchInput): Promise<void> {
    this.pushes.push(input);
    execFileSync("git", ["push", "-u", "origin", input.branch], {
      cwd: input.path,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // 失敗は転送の**後**に起こす: remote-tracking ref が動いた状態で失敗が報告される形に
    // しないと、「失敗後に撮り直さない」(ADR 0064 決定4)を測る断言が旧コードでも通る
    if (this.pushFailure) throw this.pushFailure;
  }

  /** push だけを失敗させる —— token を失ったリモート、非 ff の拒否。 */
  scriptPushFailure(err: Error | null): void {
    this.pushFailure = err;
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

  async tokenRefusal(ref: RepoSlug): Promise<string | null> {
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

/** Scripted stand-in at the AllocationClient seam (issue #547): records every
 *  input and Board call setting it was asked to judge, in call order;
 *  scriptFailure lets a test simulate a Board call outage. */
export class FakeAllocationClient implements AllocationClient {
  readonly calls: Array<{
    input: AllocationReviewInput;
    setting: Pick<ExecutionSettingRow, "model" | "effort">;
  }> = [];
  private response: AllocationJudgment = {
    allocation: "appropriate",
    cause: "uncertain",
    evidence: "scripted",
  };
  private failure: Error | null = null;

  async judge(
    input: AllocationReviewInput,
    setting: Pick<ExecutionSettingRow, "model" | "effort">,
  ): Promise<AllocationJudgment> {
    this.calls.push({ input, setting });
    if (this.failure) throw this.failure;
    return this.response;
  }

  scriptJudgment(judgment: AllocationJudgment): void {
    this.response = judgment;
  }

  scriptFailure(err: Error): void {
    this.failure = err;
  }
}

/** Scripted stand-in at the AttributionClient seam (issue #574): records every
 *  input it was asked to judge; the answer is scripted **per objected entry**
 *  (a judgment, or an Error to throw for that entry alone), and an entry
 *  nothing was scripted for answers `uncertain`. */
export class FakeAttributionClient implements AttributionClient {
  readonly calls: Array<{
    input: AttributionInput;
    setting: Pick<ExecutionSettingRow, "model" | "effort">;
  }> = [];
  private readonly scripted = new Map<number, AttributionJudgment | Error>();

  async judge(
    input: AttributionInput,
    setting: Pick<ExecutionSettingRow, "model" | "effort">,
  ): Promise<AttributionJudgment> {
    this.calls.push({ input, setting });
    const answer = this.scripted.get(input.entry_id) ?? { cause: "uncertain", evidence: "scripted" };
    if (answer instanceof Error) throw answer;
    return answer;
  }

  scriptJudgment(entryId: number, judgment: AttributionJudgment | Error): void {
    this.scripted.set(entryId, judgment);
  }
}

/** Scripted stand-in at the BehaviorDraftClient seam (issue #617): records every
 *  input; the draft is scripted per objected entry (or an Error to throw); an
 *  unscripted entry throws. */
export class FakeBehaviorDraftClient implements BehaviorDraftClient {
  readonly calls: Array<{
    input: BehaviorDraftInput;
    setting: Pick<ExecutionSettingRow, "model" | "effort">;
  }> = [];
  private readonly scripted = new Map<number, BehaviorDraft | Error>();

  async draft(
    input: BehaviorDraftInput,
    setting: Pick<ExecutionSettingRow, "model" | "effort">,
  ): Promise<BehaviorDraft> {
    this.calls.push({ input, setting });
    const answer = this.scripted.get(input.entry_id) ?? new Error("no draft scripted");
    if (answer instanceof Error) throw answer;
    return answer;
  }

  scriptDraft(entryId: number, draft: BehaviorDraft | Error): void {
    this.scripted.set(entryId, draft);
  }
}

/** 盤面側 supervisor を fake の容器機構の上に1行で組む — scheduler / watchdog を
 *  直に呼ぶテストが毎回2行書かないための口。 */
export function fakeContainers(runtime: FakeContainerRuntime = new FakeContainerRuntime()): ProcessContainers {
  return new ProcessContainers(runtime);
}

/** 容器 = CLI root process 1本 の容器機構: force は root への SIGKILL、空の観測は
 *  root の exit。**本番経路には居ない**(#463 で実機構 — Linux: cgroup v2 — が
 *  合成 root に入り、この形は封じ込めとしては #195 の穴そのものになった)ので、
 *  ここに置いてある: 実 adapter を process 境界だけ差し替えて回すテストが、容器の
 *  ふりをする最小の器として使う。 */
function passthroughContainerRuntime(spawn: ContainerSpawn): ContainerRuntime {
  return {
    preflight: () => ({ available: true }),
    create: () => {
      let kill: (() => void) | null = null;
      let markEmpty!: () => void;
      const reclaimed = new Promise<void>((resolve) => {
        markEmpty = resolve;
      });
      return {
        spawn: (command, args, opts) => {
          const child = spawn(command, args, opts);
          kill = () => child.kill("SIGKILL");
          child.on("exit", () => markEmpty());
          // spawn そのものが失敗した process は生まれていない = 容器は空
          child.on("error", (err: NodeJS.ErrnoException) => {
            if (isSpawnFailure(err)) markEmpty();
          });
          return child;
        },
        spawnPty: (launch, command, args, opts) => {
          const proc = launch(command, args, opts);
          kill = () => proc.kill("SIGKILL");
          proc.onExit(() => markEmpty());
          return proc;
        },
        forceReclaim: () => {
          // 空の容器(spawn 前 / 既に exit 済み)への force は、その場で空である
          if (!kill) markEmpty();
          else kill();
        },
        reclaimed,
      };
    },
  };
}

/** 実 adapter1台ぶんの容器まわり: 容器 supervisor と、その上に載る Board call の
 *  口(ADR 0136)。**2つを別々に組ませない** —— 口を別の supervisor から組むと、
 *  skill 列挙の容器を `hold` しても launch が止まらない(門が別の帳簿を読む)。
 *  `onReclaimTimeout` は既定で捨てる: 回収 timeout の写像を測るのはサーバー境界の
 *  テストで、adapter のテストではない。 */
export function containerHarness(
  containers: ProcessContainers,
  clock: Clock = new FakeClock(),
): { containers: ProcessContainers; boardCall: BoardCall } {
  return {
    containers,
    boardCall: createBoardCalls({
      containers,
      clock,
      reclaimTimeout: RECLAIM_TIMEOUT,
      onReclaimTimeout: () => {},
    }).call,
  };
}

/** 実 adapter に渡す supervisor を process 境界1つから組む。`spawn` を省くと実
 *  process を起こす(実 CLI は起こさない — ADR 0027)。 */
export function passthroughContainers(spawn: ContainerSpawn = defaultSpawn): ProcessContainers {
  return new ProcessContainers(passthroughContainerRuntime(spawn));
}

/** 健全な openai の usage probe(ADR 0116 決定4): openai は観測が健全でないと pickup で
 *  除外されるので、実物の selector を通して openai entry を走らせたいテストが渡す。
 *  使用率は 0% にしない —— 0% は未開始(Idle)で観測の窓から落ちるので(ADR 0128 決定2)、
 *  「健全」が「窓がそもそも無い」に化けて窓の経路を踏まなくなる。ペース線の内側を走る窓。 */
export const healthyOpenai = async (now: Date): Promise<CodexAppServerProbeResult> => ({
  status: "observed",
  provider: "openai",
  cliVersion: "codex-cli 0.147.0",
  plan: "plus",
  windows: [
    {
      name: "primary",
      model: null,
      usedPercent: 10,
      durationMs: 5 * 3_600_000,
      resetsAt: new Date(now.getTime() + 3_600_000).toISOString(),
    },
  ],
});

/** 1回の spawn の記録(command / args / cwd / env)。 */
export interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: "pipe";
}
/** Scripted stand-in at the process boundary: records the spawn recipe.
 *  容器の中で走る process の代わりで、stdout / exit / error をテストが撃つ。 */
export function recordingSpawn() {
  const calls: SpawnCall[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  /** `stdin: "pipe"` で起こした process が書いた先。 */
  const stdin = new PassThrough();
  const killed: NodeJS.Signals[] = [];
  const exitListeners: Array<
    Array<(code: number | null, signal: NodeJS.Signals | null) => void>
  > = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const spawn: ContainerSpawn = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, env: opts.env, ...(opts.stdin && { stdin: opts.stdin }) });
    const processExitListeners: Array<
      (code: number | null, signal: NodeJS.Signals | null) => void
    > = [];
    exitListeners.push(processExitListeners);
    return {
      stdout,
      stderr,
      stdin,
      kill: (signal) => killed.push(signal),
      on: (
        event: "exit" | "error",
        listener:
          | ((code: number | null, signal: NodeJS.Signals | null) => void)
          | ((err: Error) => void),
      ) => {
        if (event === "exit") {
          processExitListeners.push(
            listener as (code: number | null, signal: NodeJS.Signals | null) => void,
          );
        }
        if (event === "error") errorListeners.push(listener as (err: Error) => void);
      },
    };
  };
  const emitExit = (code: number | null, signal: NodeJS.Signals | null) => {
    for (const processListeners of exitListeners) {
      for (const listener of processListeners) listener(code, signal);
    }
  };
  const emitExitAt = (index: number, code: number | null, signal: NodeJS.Signals | null) => {
    for (const listener of exitListeners[index] ?? []) listener(code, signal);
  };
  const emitError = (err: Error) => {
    for (const listener of errorListeners) listener(err);
  };
  return { calls, stdout, stderr, stdin, killed, spawn, emitExit, emitExitAt, emitError };
}
