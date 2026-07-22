import type { Db } from "./db.js";
import type { PaceOffsets } from "./usage.js";

/** ADR 0030 の既定: 人間の取り分の予約(pt)。session は対話利用と取り合いに
 *  なりやすいので厚め、週次の2線は薄め。 */
export const DEFAULT_PACE_OFFSETS: PaceOffsets = { session: 20, week: 10, fable: 10 };

/** オフセットとして意味を持つ値: 0(予約なし)〜100(全部人間の取り分)の
 *  整数 pt。API の入口検証と reader の防御の両方がこれを使う。 */
export function isValidOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

interface PaceOffsetsRow {
  session: number;
  week: number;
  fable: number;
}

/** 盤面設定のオフセット (ADR 0030)、行が無ければ既定。不正値は API の入口
 *  (setPaceOffsets 前の validation)で弾かれるが、reader も窓ごとに防御して
 *  既定へ倒す — 旧 TIDEPOOL_USAGE_THRESHOLD が NaN で fail-open した教訓の
 *  継承(範囲外の値が判定式に入ると strict 比較が黙って崩れる)。 */
export function getPaceOffsets(db: Db): PaceOffsets {
  const row = db.prepare("SELECT session, week, fable FROM pace_offsets WHERE id = 1").get() as
    | PaceOffsetsRow
    | undefined;
  if (!row) return DEFAULT_PACE_OFFSETS;
  return {
    session: isValidOffset(row.session) ? row.session : DEFAULT_PACE_OFFSETS.session,
    week: isValidOffset(row.week) ? row.week : DEFAULT_PACE_OFFSETS.week,
    fable: isValidOffset(row.fable) ? row.fable : DEFAULT_PACE_OFFSETS.fable,
  };
}

export function setPaceOffsets(db: Db, offsets: PaceOffsets): void {
  db.prepare(
    `INSERT INTO pace_offsets (id, session, week, fable) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session = excluded.session, week = excluded.week, fable = excluded.fable`,
  ).run(offsets.session, offsets.week, offsets.fable);
}
