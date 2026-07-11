import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getQuietHours, isQuietHours, setQuietHours } from "../src/quiet-hours.js";

describe("quiet hours 設定の既定値(issue #14)", () => {
  it("一度も設定されていなければ既定の 23:00–07:00 を返す", () => {
    const db = openDb(":memory:");
    expect(getQuietHours(db)).toEqual({ start: "23:00", end: "07:00" });
  });

  it("setQuietHours で設定すると getQuietHours がその値を返す", () => {
    const db = openDb(":memory:");
    setQuietHours(db, { start: "22:00", end: "06:30" });
    expect(getQuietHours(db)).toEqual({ start: "22:00", end: "06:30" });
  });
});

describe("isQuietHours(issue #14): 既定の 23:00–07:00 は日付境界を跨ぐ", () => {
  it("23:30 は quiet hours 内", () => {
    const db = openDb(":memory:");
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 23, 30)))).toBe(true);
  });

  it("正午(12:00)は quiet hours 外", () => {
    const db = openDb(":memory:");
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 12, 0)))).toBe(false);
  });

  it("開始時刻ちょうど(23:00)は quiet hours 内(始端は含む)", () => {
    const db = openDb(":memory:");
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 23, 0)))).toBe(true);
  });

  it("終了時刻ちょうど(07:00)は quiet hours 外(終端は含まない)", () => {
    const db = openDb(":memory:");
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 7, 0)))).toBe(false);
  });
});

describe("isQuietHours: 日付境界を跨がないカスタム設定(例: 昼寝時間帯)", () => {
  it("設定範囲(13:00–15:00)内の 14:00 は quiet hours 内、範囲外の 09:00 は外", () => {
    const db = openDb(":memory:");
    setQuietHours(db, { start: "13:00", end: "15:00" });
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 14, 0)))).toBe(true);
    expect(isQuietHours(db, new Date(Date.UTC(2026, 0, 1, 9, 0)))).toBe(false);
  });
});
