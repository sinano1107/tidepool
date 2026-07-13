import { expect, it } from "vitest";
import { evaluateThrottle, parseUsage } from "../src/usage.js";

it("実測の /usage 出力から session/week の使用率と reset 時刻をパースする(issue #22 記載の実例)", () => {
  const resultText =
    "Current session: 56% used · resets Jul 9 at 5:59pm (Asia/Tokyo)\n" +
    "Current week (all models): 5% used · resets Jul 16 at 12:59pm (Asia/Tokyo)\n" +
    "Current week (Fable): 3% used · resets Jul 16 at 12:59pm (Asia/Tokyo)\n";

  const now = new Date("2026-07-08T00:00:00.000Z"); // a day before both resets, same year
  const snapshot = parseUsage(resultText, now);

  expect(snapshot.session).toEqual({
    percent: 56,
    resetsAt: new Date("2026-07-09T08:59:00.000Z"),
  });
  expect(snapshot.week).toEqual({
    percent: 5,
    resetsAt: new Date("2026-07-16T03:59:00.000Z"),
  });
});

it("カンマ区切り(履歴の少ないアカウントの実機フォーマット)かつ分が0でぴったり時刻の行もパースする(ラズパイ実機で観測: Mac(履歴豊富)は「at」区切り+分あり、Pi(新規ログイン直後)は「,」区切り+分省略)", () => {
  const resultText =
    "Current session: 32% used · resets Jul 13, 1:10pm (Asia/Tokyo)\n" +
    "Current week (all models): 52% used · resets Jul 16, 1pm (Asia/Tokyo)\n";

  const now = new Date("2026-07-12T00:00:00.000Z");
  const snapshot = parseUsage(resultText, now);

  expect(snapshot.session).toEqual({
    percent: 32,
    resetsAt: new Date("2026-07-13T04:10:00.000Z"),
  });
  expect(snapshot.week).toEqual({
    percent: 52,
    resetsAt: new Date("2026-07-16T04:00:00.000Z"),
  });
});

it("30分単位のタイムゾーンオフセット(Asia/Kolkata, GMT+5:30)も分単位まで正確にパースする", () => {
  const resultText = "Current session: 40% used · resets Jul 9 at 8:15pm (Asia/Kolkata)\n";
  const now = new Date("2026-07-08T00:00:00.000Z");

  const snapshot = parseUsage(resultText, now);

  expect(snapshot.session).toEqual({
    percent: 40,
    resetsAt: new Date("2026-07-09T14:45:00.000Z"),
  });
});

it("年境界をまたぐ reset(12月末の now → 1月の resets)は常に未来側の年に丸める", () => {
  const resultText = "Current session: 10% used · resets Jan 3 at 9:00am (Asia/Tokyo)\n";
  const now = new Date("2026-12-30T00:00:00.000Z");

  const snapshot = parseUsage(resultText, now);

  expect(snapshot.session).toEqual({
    percent: 10,
    resetsAt: new Date("2027-01-03T00:00:00.000Z"),
  });
});

it("既知の行パターンに一致しないテキストは session/week とも null(fail-closed の入力)", () => {
  const snapshot = parseUsage("something went wrong\n", new Date("2026-07-08T00:00:00.000Z"));

  expect(snapshot).toEqual({ session: null, week: null });
});

it("session/week とも閾値未満なら throttled しない", () => {
  const decision = evaluateThrottle(
    {
      session: { percent: 56, resetsAt: new Date("2026-07-09T08:59:00.000Z") },
      week: { percent: 5, resetsAt: new Date("2026-07-16T03:59:00.000Z") },
    },
    80,
  );

  expect(decision).toEqual({ throttled: false, resetsAt: null });
});

it("session が閾値以上なら throttled、resetsAt は session のもの", () => {
  const decision = evaluateThrottle(
    {
      session: { percent: 85, resetsAt: new Date("2026-07-09T08:59:00.000Z") },
      week: { percent: 5, resetsAt: new Date("2026-07-16T03:59:00.000Z") },
    },
    80,
  );

  expect(decision).toEqual({ throttled: true, resetsAt: new Date("2026-07-09T08:59:00.000Z") });
});

it("session/week 両方が閾値以上なら、resetsAt は遅い方(両方解消するまで待つ)", () => {
  const decision = evaluateThrottle(
    {
      session: { percent: 85, resetsAt: new Date("2026-07-09T08:59:00.000Z") },
      week: { percent: 90, resetsAt: new Date("2026-07-16T03:59:00.000Z") },
    },
    80,
  );

  expect(decision).toEqual({ throttled: true, resetsAt: new Date("2026-07-16T03:59:00.000Z") });
});

it("パース不能(session/week とも観測不能)なら fail-closed で throttled、resetsAt は null(次回 hourly tick で再試行)", () => {
  const decision = evaluateThrottle({ session: null, week: null }, 80);

  expect(decision).toEqual({ throttled: true, resetsAt: null });
});

it("片方の窓だけ観測不能でも fail-closed で throttled(観測できた側が閾値未満でも)", () => {
  const decision = evaluateThrottle(
    { session: { percent: 5, resetsAt: new Date("2026-07-09T08:59:00.000Z") }, week: null },
    80,
  );

  expect(decision).toEqual({ throttled: true, resetsAt: null });
});
