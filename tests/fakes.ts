import type { Clock } from "../src/clock.js";
import type { DraftClient, HandoffDraft, TaskDraft } from "../src/draft.js";
import type {
  CiStatus,
  CreatePrInput,
  GitHubClient,
  Issue,
  IssueRef,
  PrRef,
  PrResult,
} from "../src/github.js";
import type { PushClient, PushPayload, PushSubscription } from "../src/push.js";
import type { Task } from "../src/tasks.js";
import type { KillSignal, WorkerAdapter } from "../src/worker.js";

/** A reading well under the default threshold — the harness default so tests
 *  unrelated to throttling never need to script usage themselves. */
const NOT_THROTTLED_USAGE_TEXT =
  "Current session: 0% used · resets Jan 1 at 12:00am (UTC)\n" +
  "Current week (all models): 0% used · resets Jan 1 at 12:00am (UTC)\n";

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
  readonly ciChecks: PrRef[] = [];
  readonly merged: PrRef[] = [];
  private failure: Error | null = null;
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

  /** Scripts what getIssue(ref) returns for a given issue number (issue #49). */
  scriptIssue(number: number, issue: Issue): void {
    this.issues.set(number, issue);
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
  private response: TaskDraft = {
    title: "drafted title",
    purpose: "drafted purpose",
    completion_criteria: "drafted completion criteria",
  };
  private handoffResponse: HandoffDraft = {};
  private failure: Error | null = null;
  private handoffFailure: Error | null = null;

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

  scriptDraft(draft: TaskDraft): void {
    this.response = draft;
  }

  scriptHandoffDraft(draft: HandoffDraft): void {
    this.handoffResponse = draft;
  }

  scriptFailure(err: Error): void {
    this.failure = err;
  }

  scriptHandoffFailure(err: Error): void {
    this.handoffFailure = err;
  }
}
