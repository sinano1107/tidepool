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

import { copiedOriginalLanguage } from "../src/webui-rules.js";

it("an original keeps its copied language while both title and text match the copy, and takes the current language once either changes", () => {
  const copied = { title: "分ける", text: "移行を分ける", language: "English" };
  expect(copiedOriginalLanguage({ title: " 分ける", text: "移行を分ける\n" }, [copied], "Japanese")).toBe("English");
  expect(copiedOriginalLanguage({ title: "分けよ", text: "移行を分ける" }, [copied], "Japanese")).toBe("Japanese");
  expect(copiedOriginalLanguage({ title: "分ける", text: "移行は分ける" }, [copied], "Japanese")).toBe("Japanese");
  expect(copiedOriginalLanguage({ title: "分ける", text: "移行を分ける" }, [null], "Japanese")).toBe("Japanese");
});

it("an annotation original takes the language of the copied annotation original it matches, and the current language when none or several disagree", () => {
  const copied = [{ text: "分ける", language: "Japanese" }, { text: "keep it whole", language: "English" }];
  expect(copiedOriginalLanguage({ text: "keep it whole" }, copied, "Japanese")).toBe("English");
  expect(copiedOriginalLanguage({ text: "keep it all" }, copied, "Japanese")).toBe("Japanese");
  expect(copiedOriginalLanguage({ text: "分ける" }, [...copied, { text: "分ける", language: "English" }], "Japanese")).toBe("Japanese");
});

import { whyAssigneeCannotTake } from "../src/webui-rules.js";

it("組み込み agent に解決される名前は work / question の assignee に取れず、review なら取れる(ADR 0228 決定1 / ADR 0235 決定3)", () => {
  for (const type of ["work", "question"]) {
    expect(whyAssigneeCannotTake("fugu", type, true)).toBe("agent fugu is the built-in agent, which runs reviews only");
  }
  expect(whyAssigneeCannotTake("fugu", "review", true)).toBeUndefined();
});

it("組み込みに解決されない名前はどの type の assignee にも取れる —— shadow している組み込みの名前も同じ(ADR 0235 決定3)", () => {
  for (const type of ["work", "question", "review"]) expect(whyAssigneeCannotTake("fugu", type, false)).toBeUndefined();
});
