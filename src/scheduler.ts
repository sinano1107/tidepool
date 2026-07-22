import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { type GitHubClient, IssueGoneError } from "./github.js";
import { isPaused } from "./pause.js";
import type { Slot } from "./slot.js";
import { contentSourceFor, escalateTask, nextSlotTask, pickupTask, type Task } from "./tasks.js";
import { reportThrottle } from "./throttle.js";
import { activeTriageSession } from "./triage.js";
import {
  evaluateThrottle,
  type PaceOffsets,
  parseUsage,
  type ThrottleDecision,
  type UsageSnapshot,
} from "./usage.js";
import { abandonConsequence } from "./watchdog.js";
import type { WorkerAdapter } from "./worker.js";
import {
  BOARD_WORKER_ID,
  buildWorkspaceResolver,
  ensureTaskBranch,
  quarantineWorkspace,
  resolveOrQuarantine,
  type WorkspaceConfig,
} from "./workspace.js";

export const HOURLY = 60 * 60 * 1000;

// ADR 0030: 人間の取り分の予約(pt)。盤面設定(DB + WebUI)化は #126 の
// 後続スライスで、それまでは既定値。旧 TIDEPOOL_USAGE_THRESHOLD は廃止。
const DEFAULT_PACE_OFFSETS: PaceOffsets = { session: 20, week: 10 };

/** ADR 0008: usage only matters at the moment of a pickup decision — a fresh
 *  check every time there is a candidate, never a background poll. Persists
 *  the observation as a side effect so /api/queue reflects it immediately. */
async function checkThrottle(
  db: Db,
  clock: Clock,
  worker: WorkerAdapter,
  offsets: PaceOffsets,
): Promise<ThrottleDecision> {
  const resultText = await worker.checkUsage();
  const snapshot: UsageSnapshot =
    resultText !== null ? parseUsage(resultText, clock.now()) : { session: null, week: null };
  const decision = evaluateThrottle(snapshot, offsets, clock.now());
  reportThrottle(db, decision);
  return decision;
}

/** A single, replace-style one-shot timer (ADR 0008): scheduling while
 *  already armed cancels the stale handle first, so a fresh skip re-arming
 *  every poll never stacks duplicates. ADR 0030 arms it at the catch-up
 *  instant (再開見込み時刻), not the window reset — waiting for the reset
 *  plus the hourly tick would leak up to ~1h of idle pace every cycle. */
function createResetTimer(clock: Clock, onFire: () => void) {
  let cancelCurrent: (() => void) | null = null;
  return {
    schedule(resumeAt: Date): void {
      cancelCurrent?.();
      const delay = Math.max(0, resumeAt.getTime() - clock.now().getTime());
      const cancel = clock.setInterval(() => {
        cancel();
        cancelCurrent = null;
        onFire();
      }, delay);
      cancelCurrent = cancel;
    },
    cancel(): void {
      cancelCurrent?.();
    },
  };
}

export interface Scheduler {
  stop: () => void;
  /** Immediate poll, fired by human-input-originated queue-head changes.
   *  Same poll as the hourly tick: a no-op while the slot is occupied. */
  pollNow: () => void;
}

/** Hourly poll: if the slot is free, hand the queue head (lowest sort_key todo)
 *  to the worker and mark it in_progress. */
export function startScheduler(deps: {
  db: Db;
  clock: Clock;
  slot: Slot;
  worker: WorkerAdapter;
  workspace?: WorkspaceConfig;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009), read fresh every call. Absent → every task runs in the
   *  board's single fixed `workspace` (pre-#26 behavior). */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** The board's Auditor pointer (CONTEXT.md / issue #15 layer 2), the
   *  fallback a `review` task's unset assignee resolves to instead of
   *  `worker.id` (issue #42: `nextSlotTask`'s own type-aware gate). Absent →
   *  that gate is skipped for review tasks, same as `worker.id`'s own
   *  "no agent tracking" fallback. */
  auditorName?: string;
  /** The GitHub seam, for the issue-backed pickup gate (issue #49 / ADR
   *  0016's failure taxonomy): an issue-backed head's content is expanded
   *  before pickup, so an expansion failure never wedges a picked-up task.
   *  Absent → the gate is skipped and issue-backed tasks spawn with their
   *  "#N" placeholder (a board with no GitHub seam at all). */
  github?: GitHubClient;
}): Scheduler {
  const { db, clock, slot, worker, workspace, resolveWorkspace, auditorName, github } = deps;
  let inFlight = false;
  const resetTimer = createResetTimer(clock, pollNow);

  function pickupBlocked(): boolean {
    if (slot.currentTaskId !== null) return true;
    // triage pauses pickup: the human is re-steering the queue, so nothing
    // new enters the slot until the session commits (issue #6)
    if (activeTriageSession(db)) return true;
    // the human's own explicit pause (issue #34): orthogonal to triage — a
    // paused board still gates pickup after a triage commit
    if (isPaused(db)) return true;
    // the gate is keyed on each candidate's own execution workspace (issue
    // #26 / ADR 0009) and assignee (ADR 0012 / issue #36), skipped in SQL by
    // nextSlotTask itself — a quarantined workspace or agent halts only its
    // own tasks, never the whole board.
    return !nextSlotTask(db, workspace?.name, worker.id, auditorName);
  }

  function pickup(task: Task): void {
    // assignee is never overwritten (ADR 0012 / issue #36) — the event's
    // attribution resolves the same three-value read CONTEXT.md's Assignee
    // describes: pre-set name as-is, unspecified to the board's default agent
    const picked = pickupTask(db, task, task.assignee ?? worker.id, clock.now());
    slot.occupy(picked.id);
    // branch discipline is the board's own, not the worker's: by the time
    // the worker starts, the workspace already sits on the task branch
    const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
    if (resolve) {
      const resolved = resolveOrQuarantine(db, resolve, picked.workspace, clock.now());
      // an unknown workspace name (registry drift) quarantines in place of a
      // thrown error — the task stays wedged in the slot, same deliberate
      // posture as a failed start below, until the watchdog or a human acts
      if (!resolved) return;
      // a branch discipline gap (issue #27: the workspace's configured
      // branch doesn't exist in this checkout) is a resource problem, same
      // as registry drift above — this task still stays wedged in the slot
      // for the watchdog (the picked task itself isn't the failure), but the
      // *workspace* is quarantined immediately rather than surfacing only as
      // a console.error, so a human sees an actionable repair question and
      // no other task aimed at this workspace gets picked up meanwhile
      try {
        ensureTaskBranch(resolved, picked.id);
      } catch (err) {
        quarantineWorkspace(db, resolved.name, err, clock.now());
        return;
      }
      try {
        worker.start(picked);
      } catch (err) {
        console.error(`[scheduler] worker failed to start ${picked.id}:`, err);
      }
      return;
    }
    try {
      worker.start(picked);
    } catch (err) {
      // a failed start may not crash the board. The task keeps the slot — the
      // same deliberate wedge as a restart-interrupted task — until the
      // watchdog slice (#9) brings the escalation path.
      console.error(`[scheduler] worker failed to start ${picked.id}:`, err);
    }
  }

  /** The issue-backed pickup gate (issue #49 §5 / ADR 0016): an issue-backed
   *  head's content is expanded *before* pickupTask, so a dead or unreachable
   *  reference never wedges an in_progress task. A 一時的失敗 (network,
   *  GitHub outage) skips this pickup cycle — the same fail-closed
   *  environmental posture as the throttle, no human is called, the next
   *  poll retries. Ordinary tasks pass straight through. Returns whether the
   *  pickup may proceed — a false from the gone-branch has already registered
   *  the failure question as its side effect. */
  async function issuePickupGate(head: Task): Promise<boolean> {
    if (head.github_issue_number == null || !github) return true;
    const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
    // board-driven async workspace use: registry drift quarantines the name
    // (ADR 0009) and its own pickup gate skips this task from the next poll
    const resolved = resolve && resolveOrQuarantine(db, resolve, head.workspace, clock.now());
    if (resolve && !resolved) return false;
    try {
      await contentSourceFor(head, github, () => resolved?.path).expand();
      return true;
    } catch (err) {
      if (err instanceof IssueGoneError) {
        // 確定的失敗 (ADR 0016): the reference is dead for good, not this
        // cycle's weather — the same watchdog-shaped retry/abandon question
        // as failTask, minus the workspace release (nothing was acquired
        // yet). The unanswered question holds the task out of nextSlotTask,
        // so the gate never re-fires for it until a human answers.
        escalateTask(
          db,
          head,
          {
            context:
              `the GitHub issue this task references is gone ` +
              `(${err.reason === "closed" ? "already closed" : "not found"}) — ` +
              `its content cannot be expanded for spawn.\n\n` +
              `"retry" re-reads the issue and restarts this task from the queue head — ` +
              `pick it after reopening or restoring the issue. ` +
              abandonConsequence(head),
            questions: [
              {
                title: `issue reference is gone: ${head.title}`,
                options: ["retry", "abandon"],
                recommendation: "retry",
              },
            ],
            cancel_option: "abandon",
          },
          BOARD_WORKER_ID,
          clock.now(),
        );
        return false;
      }
      // 一時的失敗: fail-closed, no human — the next poll retries
      console.error(`[scheduler] issue expansion failed for ${head.id}, skipping this cycle:`, err);
      return false;
    }
  }

  async function poll(): Promise<void> {
    if (inFlight) return;
    if (pickupBlocked()) return;
    inFlight = true;
    try {
      const decision = await checkThrottle(db, clock, worker, DEFAULT_PACE_OFFSETS);
      if (decision.throttled) {
        if (decision.resetsAt) resetTimer.schedule(decision.resetsAt);
        return;
      }
      const head = nextSlotTask(db, workspace?.name, worker.id, auditorName);
      if (!head) return;
      if (!(await issuePickupGate(head))) return;
      pickup(head);
    } finally {
      inFlight = false;
    }
  }

  function pollNow(): void {
    void poll();
  }

  const cancel = clock.setInterval(pollNow, HOURLY);
  return {
    stop: () => {
      cancel();
      resetTimer.cancel();
    },
    pollNow,
  };
}
