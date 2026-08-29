import type { Db } from "./db.js";
import { defaultProviderPaceOffset, getProviderPaceOffset } from "./pace-offsets.js";
import type { Provider } from "./registry.js";
import { getSpendDown } from "./spend-down.js";
import type { ThrottleDecision, WindowDecision } from "./usage.js";

/** Persists the scheduler's last just-in-time /usage decision (ADR 0008),
 *  extended by ADR 0030 with the per-window pace verdicts: which line is hit
 *  and its catch-up instant. A NULL *_throttled column records that the
 *  window went unobserved (fail-closed input), distinct from "not throttled". */
export function reportThrottle(db: Db, decision: ThrottleDecision, observedAt: Date): void {
  db.prepare(
    `INSERT INTO throttle_state (
       id, throttled, resets_at,
       session_throttled, session_resume_at, week_throttled, week_resume_at,
       fable_throttled, fable_resume_at, observed_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       throttled = excluded.throttled,
       resets_at = excluded.resets_at,
       session_throttled = excluded.session_throttled,
       session_resume_at = excluded.session_resume_at,
       week_throttled = excluded.week_throttled,
       week_resume_at = excluded.week_resume_at,
       fable_throttled = excluded.fable_throttled,
       fable_resume_at = excluded.fable_resume_at,
       observed_at = excluded.observed_at`,
  ).run(
    decision.throttled ? 1 : 0,
    decision.resetsAt?.toISOString() ?? null,
    ...windowColumns(decision.windows.session),
    ...windowColumns(decision.windows.week),
    ...windowColumns(decision.windows.fable),
    observedAt.toISOString(),
  );
}

function windowColumns(w: WindowDecision | null): [number | null, string | null] {
  if (!w) return [null, null];
  return [w.throttled ? 1 : 0, w.resumeAt?.toISOString() ?? null];
}

interface ThrottleStateRow {
  throttled: number;
  resets_at: string | null;
  session_throttled: number | null;
  session_resume_at: string | null;
  week_throttled: number | null;
  week_resume_at: string | null;
  fable_throttled: number | null;
  fable_resume_at: string | null;
  observed_at: string | null;
}

function readThrottleState(db: Db): ThrottleStateRow | undefined {
  return db
    .prepare(
      `SELECT throttled, resets_at,
              session_throttled, session_resume_at, week_throttled, week_resume_at,
              fable_throttled, fable_resume_at, observed_at
       FROM throttle_state WHERE id = 1`,
    )
    .get() as ThrottleStateRow | undefined;
}

/** One window's last-observed pace verdict, for display: null when the
 *  window went unobserved. resumeAt is the catch-up instant (ADR 0030), not
 *  the window's reset time. */
export interface WindowThrottleState {
  throttled: boolean;
  resumeAt: string | null;
}

/** The fable line's own stored pickup gate (ADR 0030): true while the last
 *  observation has fable over its pace line and the catch-up instant hasn't
 *  passed. 資源単位なので盤面は止めず、fable モデルのタスクだけを行の skipped
 *  にする — the caller applies it per task. A missing fable observation (NULL column)
 *  is "no per-model limit", never blocked. */
export function isFablePickupBlocked(db: Db, now: Date): boolean {
  const row = readThrottleState(db);
  if (!row || !row.fable_throttled) return false;
  if (!row.fable_resume_at) return true;
  return now.getTime() < new Date(row.fable_resume_at).getTime();
}

export interface ThrottleState {
  throttled: boolean;
  resetsAt: string | null;
  observedAt: string | null;
  windows: {
    session: WindowThrottleState | null;
    week: WindowThrottleState | null;
    /** fable の null は「個別制限の観測なし」(Pro プラン等)— session/week の
     *  null(観測不能 = fail-closed)とは意味が違う (ADR 0030)。 */
    fable: WindowThrottleState | null;
  };
}

function windowState(throttled: number | null, resumeAt: string | null): WindowThrottleState | null {
  if (throttled === null) return null;
  return { throttled: !!throttled, resumeAt };
}

/** Raw throttle_state for display (issue #82): a passed resets_at is *not*
 *  resolved back to false — the human sees the last reported state as-is until
 *  the next poll refreshes it, and its age is what `observedAt` says
 *  (ADR 0068 決定2)。盤面全体の停止の読みは board-halt.ts がこれを使う。 */
export function getThrottleState(db: Db): ThrottleState {
  const row = readThrottleState(db);
  if (!row) {
    return {
      throttled: false,
      resetsAt: null,
      observedAt: null,
      windows: { session: null, week: null, fable: null },
    };
  }
  return {
    throttled: !!row.throttled,
    resetsAt: row.resets_at,
    observedAt: row.observed_at,
    windows: {
      session: windowState(row.session_throttled, row.session_resume_at),
      week: windowState(row.week_throttled, row.week_resume_at),
      fable: windowState(row.fable_throttled, row.fable_resume_at),
    },
  };
}

export interface ProviderUsageWindowState {
  window: string;
  model: string | null;
  usedPercent: number;
  durationMs: number;
  resetsAt: Date;
  throttled: boolean;
  resumesAt: Date | null;
}

export interface ProviderUsageObservation {
  provider: Provider;
  status: "observed" | "unauthorized" | "unobservable";
  plan: string | null;
  cliVersion: string | null;
  reason?: string;
  observedAt: Date;
  windows: ProviderUsageWindowState[];
}

export function reportProviderUsage(db: Db, observation: ProviderUsageObservation): void {
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO provider_usage_observations
         (provider, status, plan, cli_version, reason, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         status = excluded.status,
         plan = excluded.plan,
         cli_version = excluded.cli_version,
         reason = excluded.reason,
         observed_at = excluded.observed_at`,
    ).run(
      observation.provider,
      observation.status,
      observation.plan,
      observation.cliVersion,
      observation.reason ?? null,
      observation.observedAt.toISOString(),
    );
    db.prepare("DELETE FROM provider_usage_windows WHERE provider = ?").run(observation.provider);
    const insert = db.prepare(
      `INSERT INTO provider_usage_windows
         (provider, window, model, used_percent, duration_ms, resets_at, throttled, resumes_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const window of observation.windows) {
      insert.run(
        observation.provider,
        window.window,
        window.model ?? "",
        window.usedPercent,
        window.durationMs,
        window.resetsAt.toISOString(),
        window.throttled ? 1 : 0,
        window.resumesAt?.toISOString() ?? null,
      );
    }
  });
  write();
}

interface ProviderObservationRow {
  provider: Provider;
  status: ProviderUsageObservation["status"];
  plan: string | null;
  cli_version: string | null;
  reason: string | null;
  observed_at: string | null;
}

interface ProviderWindowRow {
  provider: Provider;
  window: string;
  model: string;
  used_percent: number | null;
  duration_ms: number | null;
  resets_at: string | null;
  throttled: number;
  resumes_at: string | null;
  offset: number | null;
}

export interface DisplayProviderUsage {
  provider: Provider;
  status: ProviderUsageObservation["status"];
  plan: string | null;
  cliVersion: string | null;
  reason?: string;
  observedAt: string | null;
  windows: Array<{
    window: string;
    model: string | null;
    usedPercent: number | null;
    durationMs: number | null;
    resetsAt: string | null;
    offset: number;
    throttled: boolean;
    resumesAt: string | null;
  }>;
}

export interface ProviderUsageResource {
  provider: Provider;
  /** null means the Provider-wide account window. */
  model: string | null;
}

/** Last observed fail-closed pickup exclusions. A new successful probe
 * replaces these rows; queue order itself is never rewritten. */
export function blockedProviderUsageResources(db: Db): ProviderUsageResource[] {
  return (
    db
      .prepare(
        `SELECT provider, NULL AS model
         FROM provider_usage_observations WHERE status <> 'observed'
         UNION
         SELECT provider, NULLIF(model, '') AS model
         FROM provider_usage_windows WHERE throttled = 1
         ORDER BY provider, model`,
      )
      .all() as ProviderUsageResource[]
  );
}

export function getProviderUsage(db: Db): DisplayProviderUsage[] {
  const observations = db
    .prepare(
      `SELECT provider, status, plan, cli_version, reason, observed_at
       FROM provider_usage_observations ORDER BY provider`,
    )
    .all() as ProviderObservationRow[];
  const windows = db
    .prepare(
      `SELECT w.provider, w.window, w.model, w.used_percent, w.duration_ms,
              w.resets_at, w.throttled, w.resumes_at, o.offset
       FROM provider_usage_windows w
       LEFT JOIN provider_pace_offsets o
         ON o.provider = w.provider AND o.window = w.window
       ORDER BY w.provider,
                CASE w.window WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END,
                w.window, w.model`,
    )
    .all() as ProviderWindowRow[];
  return observations.map((observation) => ({
    provider: observation.provider,
    status: observation.status,
    plan: observation.plan,
    cliVersion: observation.cli_version,
    ...(observation.reason === null ? {} : { reason: observation.reason }),
    observedAt: observation.observed_at,
    windows: windows
      .filter((window) => window.provider === observation.provider)
      .map((window) => ({
        window: window.window,
        model: window.model || null,
        usedPercent: window.used_percent,
        durationMs: window.duration_ms,
        resetsAt: window.resets_at,
        offset: window.offset ?? defaultProviderPaceOffset(window.window),
        throttled: !!window.throttled,
        resumesAt: window.resumes_at,
      })),
  }));
}

/** Applies the same elapsed-time pace line as ADR 0030 to the App Server's
 * explicit duration/reset windows. Account-wide windows block the Provider;
 * model windows block only that model. */
export function evaluateAndReportProviderUsage(
  db: Db,
  observation: Omit<ProviderUsageObservation, "observedAt" | "windows"> & {
    windows: Array<{
      window: string;
      model: string | null;
      usedPercent: number;
      durationMs: number;
      resetsAt: Date;
    }>;
  },
  now: Date,
): ProviderUsageObservation {
  const spendDown = getSpendDown(db);
  const windows = observation.windows.map((window): ProviderUsageWindowState => {
    const offset = getProviderPaceOffset(
      db,
      observation.provider,
      window.window,
    );
    const startsAt = window.resetsAt.getTime() - window.durationMs;
    const elapsed = (now.getTime() - startsAt) / window.durationMs;
    const spendDownWindow = window.window === "primary" || window.window === "session"
      ? spendDown.session
      : spendDown.week;
    const spendDownActive =
      spendDownWindow !== null && spendDownWindow.activatedAt.getTime() >= startsAt;
    const throttled = spendDownActive
      ? window.usedPercent >= 100
      : window.usedPercent >= 100 || window.usedPercent > elapsed * 100 - offset;
    const catchesUpAt = startsAt + ((window.usedPercent + offset) / 100) * window.durationMs;
    return {
      ...window,
      throttled,
      resumesAt: throttled
        ? spendDownActive
          ? window.resetsAt
          : new Date(Math.min(window.resetsAt.getTime(), Math.max(now.getTime(), catchesUpAt)))
        : null,
    };
  });
  const result = { ...observation, observedAt: now, windows };
  reportProviderUsage(db, result);
  return result;
}
