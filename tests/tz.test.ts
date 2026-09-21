import { afterEach, expect, it, vi } from "vitest";
import { offsetMinutesEastOfUtc } from "../src/tz.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("同じ tz を2回呼んでも Intl.DateTimeFormat は1度しか生成しない(issue #813)", () => {
  // このファイル内でしか使わない tz にして、モジュールレベルキャッシュを他ケースの影響なしに検証する
  const tz = "Australia/Sydney";
  // vi.spyOn だけだと `new` 経由の呼び出しで formatToParts を持たないオブジェクトを返すため、
  // 元のコンストラクタへ委譲して実際に構築させる(呼び出し回数は spy が数える)。
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  const spy = vi
    .spyOn(Intl, "DateTimeFormat")
    .mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      return new OriginalDateTimeFormat(...args);
    });

  offsetMinutesEastOfUtc(tz, new Date("2026-01-01T00:00:00.000Z"));
  offsetMinutesEastOfUtc(tz, new Date("2026-07-01T00:00:00.000Z"));

  expect(spy).toHaveBeenCalledTimes(1);
});
