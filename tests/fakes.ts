import type { Clock } from "../src/clock.js";
import type { DraftClient, HandoffDraft, IssueInspection, TaskDraft } from "../src/draft.js";
import type {
  CiStatus,
  CreatePrInput,
  GitHubClient,
  Issue,
  IssueRef,
  PrRef,
  PrResult,
  Repository,
} from "../src/github.js";
import type { PushClient, PushPayload, PushSubscription } from "../src/push.js";
import type { Task } from "../src/tasks.js";
import type { KillSignal, WorkerAdapter } from "../src/worker.js";

/** A reading well under the default threshold — the harness default so tests
 *  unrelated to throttling never need to script usage themselves. Exported
 *  so other hand-rolled WorkerAdapter fakes (e.g. worker-failure.test.ts)
 *  don't each carry their own copy of the panel text. */
export const NOT_THROTTLED_USAGE_TEXT =
  "Current session\n0% used\nResets 12:00am (UTC)\n" +
  "Current week (all models)\n0% used\nResets Jan 1 at 12:00am (UTC)\n";

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
  readonly id = "fake-worker";
  readonly started: Task[] = [];
  readonly killed: Array<{ taskId: string; signal: KillSignal }> = [];
  private usageText: string | null = NOT_THROTTLED_USAGE_TEXT;

  start(task: Task): void {
    this.started.push(task);
  }

  kill(taskId: string, signal: KillSignal): void {
    this.killed.push({ taskId, signal });
  }

  async checkUsage(): Promise<string | null> {
    return this.usageText;
  }

  /** Scripts what the next checkUsage() call(s) return (ADR 0008) — the same
   *  seam the real ClaudeCodeWorker's `/usage` JIT poll returns through. Pass
   *  null to script a check failure (fail-closed). */
  scriptUsage(resultText: string | null): void {
    this.usageText = resultText;
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
  private failure: Error | null = null;
  private issueFailure: Error | null = null;
  private issueFailures = new Map<number, Error>();
  private issueGate: Promise<void> | null = null;
  private nextNumber = 1;
  private ciStatus: CiStatus = "success";
  private issues = new Map<number, Issue>();

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
    this.merged.push(ref);
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

  scriptFailure(err: Error): void {
    this.failure = err;
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

  readonly createdRepositories: string[] = [];
  private repositories = new Map<string, Repository>();
  private nextRepositoryUrl: string | null = null;

  async getRepository(name: string): Promise<Repository | null> {
    return this.repositories.get(name) ?? null;
  }

  async createRepository(name: string): Promise<Repository> {
    this.createdRepositories.push(name);
    if (this.nextRepositoryUrl === null) {
      throw new Error(`no repository url scripted for createRepository(${name})`);
    }
    const repository = { url: this.nextRepositoryUrl };
    this.repositories.set(name, repository);
    return repository;
  }

  /** Scripts an already-existing repository (issue #57: the create mode's
   *  idempotent-retry probe finds it and reuses it instead of creating). */
  scriptRepository(name: string, url: string): void {
    this.repositories.set(name, { url });
  }

  /** Scripts what the next createRepository call returns as the new repo's
   *  clone URL (issue #57) — in tests, a local fixture repo standing in for
   *  the private repository gh just created with its initial commit. */
  scriptNextRepositoryUrl(url: string): void {
    this.nextRepositoryUrl = url;
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
  readonly handoffDumps: string[] = [];
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

  async draftTask(dump: string): Promise<TaskDraft> {
    this.dumps.push(dump);
    if (this.failure) throw this.failure;
    return this.response;
  }

  async draftHandoff(dump: string): Promise<HandoffDraft> {
    this.handoffDumps.push(dump);
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
