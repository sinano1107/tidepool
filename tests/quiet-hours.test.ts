import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getQuietHours, isQuietHours, setBoardTimezone, setQuietHours } from "../src/quiet-hours.js";

describe("quiet hours 設定の既定値(issue #14 / #63)", () => {
  it("一度も設定されていなければ既定の 23:00–07:00 Asia/Tokyo を返す", () => {
    const db = openDb(":memory:");
    expect(getQuietHours(db)).toEqual({ start: "23:00", end: "07:00", tz: "Asia/Tokyo" });
  });

  it("setQuietHours で設定すると getQuietHours がその値を返し、tz は変わらない", () => {
    const db = openDb(":memory:");
    setQuietHours(db, { start: "22:00", end: "06:30" });
    expect(getQuietHours(db)).toEqual({ start: "22:00", end: "06:30", tz: "Asia/Tokyo" });
  });

  it("setBoardTimezone で tz を設定すると getQuietHours がその値を返し、start/end は変わらない", () => {
    const db = openDb(":memory:");
    setQuietHours(db, { start: "22:00", end: "06:30" });
    setBoardTimezone(db, "America/New_York");
    expect(getQuietHours(db)).toEqual({ start: "22:00", end: "06:30", tz: "America/New_York" });
  });

  it("start/end が一度も設定されないまま setBoardTimezone が呼ばれても既定の HH:MM を保つ", () => {
    const db = openDb(":memory:");
    setBoardTimezone(db, "America/New_York");
    expect(getQuietHours(db)).toEqual({ start: "23:00", end: "07:00", tz: "America/New_York" });
  });
});

// UTC の瞬間から JST(UTC+9)壁時計の年月日時分を組み立てるヘルパー — テスト自体が
// UTC 換算をやると読みにくくなるので、JST の意図した時刻を素直に書けるようにする。
function jst(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute) - 9 * 60 * 60 * 1000);
}

describe("isQuietHours(issue #14 / #63): 既定の 23:00–07:00(Asia/Tokyo)は日付境界を跨ぐ", () => {
  it("JST 23:30 は quiet hours 内", () => {
    const db = openDb(":memory:");
    expect(isQuietHours(db, jst(2026, 0, 1, 23, 30))).toBe(true);
  });

  it("JST 正午(12:00)は quiet hours 外", () => {
    const db = openDb(":memory:");
    expect(isQuietHours(db, jst(2026, 0, 1, 12, 0))).toBe(false);
  });

  it("JST 開始時刻ちょうど(23:00)は quiet hours 内(始端は含む)", () => {
    const db = openDb(":memory:");
    expect(isQuietHours(db, jst(2026, 0, 1, 23, 0))).toBe(true);
  });

  it("JST 終了時刻ちょうど(07:00)は quiet hours 外(終端は含まない)", () => {
    const db = openDb(":memory:");
    expect(isQuietHours(db, jst(2026, 0, 1, 7, 0))).toBe(false);
  });

  it("JST 深夜 3:00 は quiet hours 内(日付境界を跨いだ判定)", () => {
    const db = openDb(":memory:");
    expect(isQuietHours(db, jst(2026, 0, 2, 3, 0))).toBe(true);
  });

  it("旧バグ(UTC 判定)なら quiet だった JST 日中は、修正後 not quiet になる", () => {
    const db = openDb(":memory:");
    // UTC 08:00 は旧バグの quiet 開始点だったが、JST では 17:00 — not quiet
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 8, 0)))).toBe(false);
    // JST 深夜1時(旧バグでは quiet 扱いされなかった時間帯)は quiet になる
    expect(isQuietHours(db, jst(2026, 0, 1, 1, 0))).toBe(true);
  });
});

describe("isQuietHours: 日付境界を跨がないカスタム設定(例: 昼寝時間帯)", () => {
  it("設定範囲(13:00–15:00, JST)内の 14:00 は quiet hours 内、範囲外の 09:00 は外", () => {
    const db = openDb(":memory:");
    setQuietHours(db, { start: "13:00", end: "15:00" });
    expect(isQuietHours(db, jst(2026, 0, 1, 14, 0))).toBe(true);
    expect(isQuietHours(db, jst(2026, 0, 1, 9, 0))).toBe(false);
  });
});

describe("isQuietHours: tz が Asia/Tokyo 以外のときも tz の壁時計で判定する", () => {
  it("既定 23:00–07:00 のまま tz を America/New_York(冬時間 UTC-5)に変えると、NY 深夜が quiet になる", () => {
    const db = openDb(":memory:");
    setBoardTimezone(db, "America/New_York");
    // 2026-01-01T04:30Z は NY で前日 23:30(冬時間 UTC-5) — quiet
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 4, 30)))).toBe(true);
    // 2026-01-01T17:00Z は NY で 12:00 — not quiet
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 17, 0)))).toBe(false);
  });

  it("夏時間(DST)を挟む tz でもオフセットが正しく反映される(America/New_York, 夏時間 UTC-4)", () => {
    const db = openDb(":memory:");
    setBoardTimezone(db, "America/New_York");
    // 2026-07-01T03:30Z は NY 夏時間で前日 23:30(UTC-4) — quiet
    expect(isQuietHours(db, new Date(Date.UTC(2026, 6, 1, 3, 30)))).toBe(true);
  });

  it("日付境界をまたぐ範囲(start > end)が tz を変えても壁時計基準で正しく判定される", () => {
    const db = openDb(":memory:");
    setQuietHours(db, { start: "22:00", end: "06:00" });
    setBoardTimezone(db, "America/New_York");
    // 2026-01-01T05:30Z は NY(冬時間 UTC-5)で前日 00:30 — 22:00-06:00 の範囲内、quiet
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 5, 30)))).toBe(true);
    // 2026-01-01T17:00Z は NY で 12:00 — 範囲外、not quiet
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 17, 0)))).toBe(false);
  });
});
