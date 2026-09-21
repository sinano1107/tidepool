import type { Db } from "./db.js";
import type { Provider } from "./registry.js";

/** Spend-down の対象になる「Provider × ウィンドウ」の既知の組(ADR 0143 決定1・2)。
 *  窓の名前は Provider 自身の語彙のまま。fable は anthropic の week に従うので入らない
 *  (決定3)。入口の門と、`GET /api/pause` の欄のキー(= UI が arm を出す窓)の正本。 */
export const SPEND_DOWN_WINDOWS = {
  anthropic: ["session", "week"],
  openai: ["primary", "secondary"],
} as const;

export type SpendDownProvider = keyof typeof SPEND_DOWN_WINDOWS;

export interface SpendDownWindowState {
  activatedAt: Date;
}

export type SpendDownState = {
  [P in SpendDownProvider]: Record<(typeof SPEND_DOWN_WINDOWS)[P][number], SpendDownWindowState | null>;
};

export function isKnownSpendDownTarget(provider: string, window: string): boolean {
  return (SPEND_DOWN_WINDOWS as Record<string, readonly string[]>)[provider]?.includes(window) ?? false;
}

/** Spend-down (ADR 0091 / 0143): one independently expiring row per armed Provider window. */
export function setSpendDown(db: Db, provider: Provider, window: string, now: Date): void {
  db.prepare(
    `INSERT INTO spend_down_state (provider, window, activated_at) VALUES (?, ?, ?)
     ON CONFLICT(provider, window) DO UPDATE SET activated_at = excluded.activated_at`,
  ).run(provider, window, now.toISOString());
}

export function clearSpendDown(db: Db, provider: Provider, window: string): void {
  db.prepare("DELETE FROM spend_down_state WHERE provider = ? AND window = ?").run(provider, window);
}

export function getSpendDown(db: Db): SpendDownState {
  const state: SpendDownState = {
    anthropic: { session: null, week: null },
    openai: { primary: null, secondary: null },
  };
  const rows = db.prepare("SELECT provider, window, activated_at FROM spend_down_state").all() as Array<{
    provider: string;
    window: string;
    activated_at: string;
  }>;
  for (const row of rows) {
    if (!isKnownSpendDownTarget(row.provider, row.window)) continue;
    (state as Record<string, Record<string, SpendDownWindowState | null>>)[row.provider]![row.window] = {
      activatedAt: new Date(row.activated_at),
    };
  }
  return state;
}

/** その窓の線を Spend-down が外すか: arm の時刻が窓の開始以降のときだけ当たる —— 前なら arm した
 *  窓はもうリセット済み。anthropic の fable は anthropic の week に従う(ADR 0091 決定2)。
 *  anthropic と Provider ごとの使用量の評価の両方がこの1つの述語を通る。 */
export function isSpendDownActive(
  state: SpendDownState,
  provider: Provider,
  window: string,
  startsAtMs: number,
): boolean {
  const target = provider === "anthropic" && window === "fable" ? "week" : window;
  const armed = (state as Record<string, Record<string, SpendDownWindowState | null> | undefined>)[provider]?.[
    target
  ];
  return !!armed && armed.activatedAt.getTime() >= startsAtMs;
}

/** 失効の後始末: arm の後に開いた窓が観測されたら、その (provider, window) の行を消す。
 *  観測に現れない窓(Idle・観測不能)の行は残す —— 当たる線が無いので無害で、窓が開いた後の
 *  観測で消える(ADR 0143 決定5)。 */
export function expireSpendDown(
  db: Db,
  observation: { provider: Provider; windows: Array<{ window: string; durationMs: number; resetsAt: Date }> },
): void {
  const expire = db.prepare(
    "DELETE FROM spend_down_state WHERE provider = ? AND window = ? AND activated_at < ?",
  );
  for (const window of observation.windows) {
    const startsAt = new Date(window.resetsAt.getTime() - window.durationMs);
    expire.run(observation.provider, window.window, startsAt.toISOString());
  }
}
