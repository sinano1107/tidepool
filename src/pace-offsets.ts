import type { Db } from "./db.js";
import type { Provider } from "./registry.js";

/** オフセットとして意味を持つ値: 0(予約なし)〜100(全部人間の取り分)の
 *  整数 pt。API の入口検証と reader の防御の両方がこれを使う。 */
export function isValidOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

export interface ProviderPaceOffset {
  provider: Provider;
  window: string;
  offset: number;
}

/** pace offset の既知の Provider × 窓とその既定(ADR 0030 / ADR 0143 決定5 の門を
 *  pace offset に当てたもの)。既定は人間の取り分の予約(pt): 短い窓は対話利用と
 *  取り合いになりやすいので厚め、週次の線は薄め。
 *  Spend-down の SPEND_DOWN_WINDOWS とは共有しない —
 *  fable は pace offset の対象だが Spend-down の対象ではない(ADR 0143 決定3)。 */
const PROVIDER_PACE_OFFSET_DEFAULTS: Partial<Record<Provider, Record<string, number>>> = {
  anthropic: { session: 20, week: 10, fable: 10 },
  openai: { primary: 20, secondary: 10 },
};

export function isKnownPaceOffsetTarget(provider: Provider, window: string): boolean {
  return Object.hasOwn(PROVIDER_PACE_OFFSET_DEFAULTS[provider] ?? {}, window);
}

/** 表にない組(観測にだけ現れた窓)は名前を見ずに固定の 10。 */
export function defaultProviderPaceOffset(provider: Provider, window: string): number {
  return isKnownPaceOffsetTarget(provider, window) ? PROVIDER_PACE_OFFSET_DEFAULTS[provider]![window]! : 10;
}

export function setProviderPaceOffset(db: Db, value: ProviderPaceOffset): void {
  db.prepare(
    `INSERT INTO provider_pace_offsets (provider, window, offset) VALUES (?, ?, ?)
     ON CONFLICT(provider, window) DO UPDATE SET offset = excluded.offset`,
  ).run(value.provider, value.window, value.offset);
}

/** 既知の組ごとの実効値(保存値か既定値)。表に無い組の行は返さない。 */
export function listProviderPaceOffsets(db: Db): ProviderPaceOffset[] {
  return (Object.keys(PROVIDER_PACE_OFFSET_DEFAULTS) as Provider[]).sort().flatMap((provider) =>
    Object.keys(PROVIDER_PACE_OFFSET_DEFAULTS[provider]!)
      .sort()
      .map((window) => ({ provider, window, offset: getProviderPaceOffset(db, provider, window) })),
  );
}

/** 不正値は API の入口で弾かれるが、reader も防御して既定へ倒す — 旧
 *  TIDEPOOL_USAGE_THRESHOLD が NaN で fail-open した教訓の継承(範囲外の値が
 *  判定式に入ると strict 比較が黙って崩れる)。 */
export function getProviderPaceOffset(
  db: Db,
  provider: Provider,
  window: string,
): number {
  const row = db
    .prepare(
      `SELECT offset FROM provider_pace_offsets
       WHERE provider = ? AND window = ?`,
    )
    .get(provider, window) as { offset: number } | undefined;
  return row && isValidOffset(row.offset) ? row.offset : defaultProviderPaceOffset(provider, window);
}
