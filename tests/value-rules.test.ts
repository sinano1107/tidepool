import { expect, it } from "vitest";
import { whyInvalidOffset } from "../src/pace-offset-rule.js";

it("pacing offset accepts only integer points from 0 through 100", () => {
  for (const value of [0, 100]) expect(whyInvalidOffset(value)).toBeUndefined();
  for (const value of [101, 0.5, NaN]) expect(whyInvalidOffset(value)).toBe("offset must be an integer between 0 and 100");
});

import { whyNotPositiveInteger } from "../src/positive-integer.js";

it("a positive integer is at least one and has no fraction", () => {
  for (const value of [1, Number.MAX_SAFE_INTEGER]) expect(whyNotPositiveInteger(value)).toBeUndefined();
  for (const value of [0, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(whyNotPositiveInteger(value)).toBe("must be a positive integer");
});

import { whyInvalidPrice } from "../src/price.js";

it("price accepts finite non-negative amounts including fractions", () => {
  for (const value of [0, 0.5]) expect(whyInvalidPrice(value)).toBeUndefined();
  for (const value of [-1, Infinity, NaN]) expect(whyInvalidPrice(value)).toBe("price must be a finite non-negative number");
});

import { whyInvalidProviderRank } from "../src/provider.js";

it("provider rank lists each provider exactly once", () => {
  expect(whyInvalidProviderRank(["openai", "anthropic", "moonshot"])).toBeUndefined();
  for (const rank of [["anthropic", "openai"], ["anthropic", "openai", "openai"], ["anthropic", "openai", "unknown"]]) {
    expect(whyInvalidProviderRank(rank)).toBe("provider rank must list every provider exactly once (anthropic / moonshot / openai)");
  }
});

import { whyInvalidClockTime } from "../src/clock-time.js";

it("clock time requires an unpadded HH:MM within the day", () => {
  for (const value of ["07:00", "23:59"]) expect(whyInvalidClockTime(value)).toBeUndefined();
  for (const value of ["7:00", "24:00", " 07:00 ", "07:00\n"]) expect(whyInvalidClockTime(value)).toBe("time must be HH:MM between 00:00 and 23:59");
});
