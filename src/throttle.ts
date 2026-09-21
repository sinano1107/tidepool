import type { Db } from "./db.js";
import { windowMatchesModel } from "./execution-setting.js";
import { defaultProviderPaceOffset, getProviderPaceOffset } from "./pace-offsets.js";
import type { Provider } from "./registry.js";
import { getSpendDown, isSpendDownActive } from "./spend-down.js";

/** 評価器が受け取る窓 —— Provider を問わない共通の形(ADR 0144)。 */
export interface ProviderUsageWindow {
  window: string;
  model: string | null;
  usedPercent: number;
  durationMs: number;
  resetsAt: Date;
}

export interface ProviderUsageWindowState extends ProviderUsageWindow {
  throttled: boolean;
  resumesAt: Date | null;
}

export interface ProviderUsageObservation {
  provider: Provider;
  status: "observed" | "unauthorized" | "unobservable" | "absent";
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

/** Whether an Anthropic Board call should be skipped right now, from the stored
 *  observation (no live re-observation — Board calls have no usage poll). The
 *  Provider-wide account window always counts; a model window counts only
 *  against the model the call would pin (translation pins haiku and passes
 *  none; the allocation review pins the frontier row, whose fable window is
 *  exactly the one that matters). No Anthropic observation yet → not blocked. */
export function isAnthropicBoardCallBlocked(db: Db, model?: string): boolean {
  return blockedProviderUsageResources(db).some(
    (resource) =>
      resource.provider === "anthropic" &&
      (resource.model === null ||
        (model !== undefined && windowMatchesModel(resource.model, model))),
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

/** The one pace-line evaluator for every Provider (ADR 0030 / ADR 0144).
 * Account-wide windows block the Provider; model windows block only that model. */
export function evaluateAndReportProviderUsage(
  db: Db,
  observation: Omit<ProviderUsageObservation, "observedAt" | "windows"> & {
    windows: ProviderUsageWindow[];
  },
  now: Date,
): ProviderUsageObservation {
  const spendDown = getSpendDown(db);
  // 逆算の不整合(今がリセット時刻 − 窓幅より前)の窓は観測から落とす。Provider 全体の窓なら
  // Provider ごと観測不能に倒す —— model 固有の窓の不在はプランの正常な姿でありうる(ADR 0144 決定3)
  const inconsistent = observation.windows.filter(
    (window) => now.getTime() < window.resetsAt.getTime() - window.durationMs,
  );
  const unobservable =
    observation.status === "observed" && inconsistent.some((window) => window.model === null);
  const windows = observation.windows.filter((window) => !inconsistent.includes(window)).map((window): ProviderUsageWindowState => {
    const offset = getProviderPaceOffset(
      db,
      observation.provider,
      window.window,
    );
    const startsAt = window.resetsAt.getTime() - window.durationMs;
    const elapsed = (now.getTime() - startsAt) / window.durationMs;
    const spendDownActive = isSpendDownActive(spendDown, observation.provider, window.window, startsAt);
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
  const result: ProviderUsageObservation = {
    ...observation,
    ...(unobservable && {
      status: "unobservable",
      reason: "a Provider-wide usage window resets later than its duration allows",
    }),
    observedAt: now,
    windows,
  };
  reportProviderUsage(db, result);
  return result;
}
