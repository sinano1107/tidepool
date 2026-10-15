import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import type { Provider } from "./provider.js";

/** Spend-down の対象になる「Provider × ウィンドウ」の既知の組(ADR 0143 決定1・2)。
 *  窓の名前は Provider 自身の語彙のまま。fable は anthropic の week に従うので入らない
 *  (決定3)。入口の門と、`GET /api/pause` の欄のキー(= UI が arm を出す窓)の正本。 */
export const SPEND_DOWN_WINDOWS = {
  anthropic: ["session", "week"],
  openai: ["primary", "secondary"],
} as const;

export interface SpendDownWindowState {
  activatedAt: Date;
  /** 結んだ窓の reset(ADR 0260 決定1)。null は未確定 —— 次に観測に現れる窓に結ぶ。 */
  resetsAt: Date | null;
}

export type SpendDownState = {
  [P in keyof typeof SPEND_DOWN_WINDOWS]: Record<(typeof SPEND_DOWN_WINDOWS)[P][number], SpendDownWindowState | null>;
};

/** provider / window を文字列で引くための同じ状態の見え方。 */
type LooseSpendDownState = Record<string, Record<string, SpendDownWindowState | null> | undefined>;

/** 結んだ窓の同定の許容幅: reset の表示は分単位で揺れる(#853 の実測)。リセット直後の arm を拒む区間も同じ幅。 */
const WINDOW_TOLERANCE_MS = 5 * 60 * 1000;

export function isKnownSpendDownTarget(provider: string, window: string): boolean {
  return (SPEND_DOWN_WINDOWS as Record<string, readonly string[]>)[provider]?.includes(window) ?? false;
}

/** その (provider, window) の最新の観測の窓の reset —— 観測済み(observed)の Provider の観測に
 *  その窓があるときだけ。Spend-down の窓は Provider 全体の窓なので model は空。 */
function observedResetsAt(db: Db, provider: Provider, window: string): Date | null {
  const row = db
    .prepare(
      `SELECT w.resets_at FROM provider_usage_windows w
       JOIN provider_usage_observations o ON o.provider = w.provider
       WHERE w.provider = ? AND w.window = ? AND w.model = '' AND o.status = 'observed'`,
    )
    .get(provider, window) as { resets_at: string | null } | undefined;
  return row?.resets_at ? new Date(row.resets_at) : null;
}

/** Spend-down (ADR 0091 / 0143 / 0260): one independently expiring row per armed Provider window.
 *  最新の観測で開いている窓(今がその reset より前)に結び、そうでなければ未確定にする。表示の reset を
 *  過ぎて許容幅の内の arm は、どちらの窓のつもりか分からないので拒む(ADR 0260 決定4)。 */
export function setSpendDown(db: Db, provider: Provider, window: string, now: Date): void {
  const observed = observedResetsAt(db, provider, window);
  if (observed && observed <= now && now.getTime() < observed.getTime() + WINDOW_TOLERANCE_MS) {
    throw new DomainError("window is resetting; arm again after the new window opens");
  }
  const resetsAt = observed && now < observed ? observed.toISOString() : null;
  db.prepare(
    `INSERT INTO spend_down_state (provider, window, activated_at, resets_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider, window) DO UPDATE SET
       activated_at = excluded.activated_at, resets_at = excluded.resets_at`,
  ).run(provider, window, now.toISOString(), resetsAt);
}

export function clearSpendDown(db: Db, provider: Provider, window: string): void {
  db.prepare("DELETE FROM spend_down_state WHERE provider = ? AND window = ?").run(provider, window);
}

export function getSpendDown(db: Db): SpendDownState {
  const state: LooseSpendDownState = Object.fromEntries(
    Object.entries(SPEND_DOWN_WINDOWS).map(([provider, windows]) => [
      provider,
      Object.fromEntries(windows.map((window) => [window, null])),
    ]),
  );
  const rows = db.prepare("SELECT provider, window, activated_at, resets_at FROM spend_down_state").all() as Array<{
    provider: string;
    window: string;
    activated_at: string;
    resets_at: string | null;
  }>;
  for (const row of rows) {
    if (!isKnownSpendDownTarget(row.provider, row.window)) continue;
    state[row.provider]![row.window] = {
      activatedAt: new Date(row.activated_at),
      resetsAt: row.resets_at === null ? null : new Date(row.resets_at),
    };
  }
  return state as SpendDownState;
}

/** その窓の線を Spend-down が外すか(ADR 0260 決定1): 観測した窓の reset が結んだ reset と許容幅で
 *  一致するときだけ当たる。未確定の arm は reset が arm より後の窓 —— 失効処理がこの窓に結ぶ —— に当たる。
 *  一致しない窓は行の削除を待たずに当たらない。anthropic の fable は anthropic の week に従う
 *  (ADR 0091 決定2)。Provider を問わず、ペース線の評価器(ADR 0144)がこの1つの述語を通る。 */
export function isSpendDownActive(
  state: SpendDownState,
  provider: Provider,
  window: string,
  resetsAt: Date,
): boolean {
  const followsWeek = provider === "anthropic" && window === "fable";
  const armed = (state as LooseSpendDownState)[provider]?.[followsWeek ? "week" : window];
  if (!armed) return false;
  if (armed.resetsAt) return Math.abs(resetsAt.getTime() - armed.resetsAt.getTime()) <= WINDOW_TOLERANCE_MS;
  // 次の窓に結んだ week の arm は fable に当たらない —— fable の観測は week の行を結ばないので、当てると
  // week の窓が観測されるまで fable の窓を次々に外し続ける。week に結ばれた後から fable も従う
  return !followsWeek && resetsAt > armed.activatedAt;
}

/** 失効の後始末(ADR 0260 決定2): 結んだ窓と別の窓が観測されたら、その (provider, window) の行を消し、
 *  未確定の行は reset が arm より後の窓に結ぶ —— どちらも当たりと同じ述語で決める。観測に現れない窓
 *  (Idle・観測不能)の行は残す —— 当たる線が無いので無害。 */
export function expireSpendDown(
  db: Db,
  observation: { provider: Provider; windows: Array<{ window: string; resetsAt: Date }> },
): void {
  const state = getSpendDown(db);
  for (const window of observation.windows) {
    const armed = (state as LooseSpendDownState)[observation.provider]?.[window.window];
    if (!armed) continue;
    if (!isSpendDownActive(state, observation.provider, window.window, window.resetsAt)) {
      if (armed.resetsAt) clearSpendDown(db, observation.provider, window.window);
    } else if (!armed.resetsAt) {
      db.prepare("UPDATE spend_down_state SET resets_at = ? WHERE provider = ? AND window = ?").run(
        window.resetsAt.toISOString(),
        observation.provider,
        window.window,
      );
    }
  }
}
