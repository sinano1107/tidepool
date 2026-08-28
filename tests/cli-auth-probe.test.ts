import { expect, it } from "vitest";
import { createClaudeCliAuthCheck } from "../src/claude-cli-auth.js";
import { isCapInterruptionEnvelope, isCliAuthFailureEnvelope } from "../src/cli-auth.js";

it("JSON envelope の api_error_status: 401 だけを確定的な認証失敗に分類する(ADR 0070)", async () => {
  const check = createClaudeCliAuthCheck(async () => ({
    exitCode: 1,
    stdout: JSON.stringify({
      is_error: true,
      api_error_status: 401,
      result: "Failed to authenticate. API Error: 401 Invalid bearer token",
    }),
  }));

  await expect(check()).resolves.toEqual({ status: "unauthorized", reason: "API returned 401" });
});

it("result 文言に401があっても api_error_status が401でなければ認証失敗に分類しない", async () => {
  const check = createClaudeCliAuthCheck(async () => ({
    exitCode: 1,
    stdout: JSON.stringify({
      is_error: true,
      api_error_status: 500,
      result: "a misleading message contains 401",
    }),
  }));

  await expect(check()).resolves.toEqual({
    status: "unknown",
    reason: "probe did not return a successful authentication result",
  });
});

it("成功したJSON envelope は認証済みと判定する", async () => {
  const check = createClaudeCliAuthCheck(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ is_error: false, result: "OK" }),
  }));

  await expect(check()).resolves.toEqual({ status: "authenticated" });
});

/** 上限到達による中断(ADR 0104 決定2)の述語。認証の述語と同じ場所・同じ確度で
 *  「envelope の構造化フィールド一点」だけを見る。 */
it("result envelope の api_error_status: 429 だけを上限到達による中断に分類する(ADR 0104 決定2)", () => {
  // #447 のライブ検証(2026-08-24、Claude Code 2.1.241)の逐語
  expect(
    isCapInterruptionEnvelope({
      is_error: true,
      subtype: "success",
      api_error_status: 429,
      terminal_reason: "api_error",
      result: "You've hit your session limit · resets 10:20pm (Asia/Tokyo)",
    }),
  ).toBe(true);
});

it("401 / 500 の envelope は上限到達による中断ではない — 認証失敗と混ざらない", () => {
  expect(isCapInterruptionEnvelope({ is_error: true, api_error_status: 401 })).toBe(false);
  expect(isCapInterruptionEnvelope({ is_error: true, api_error_status: 500 })).toBe(false);
  expect(isCliAuthFailureEnvelope({ is_error: true, api_error_status: 429 })).toBe(false);
});

it("api_error_status を伴わない「session limit」の文言からは推測しない", () => {
  expect(
    isCapInterruptionEnvelope({
      is_error: true,
      result: "You've hit your session limit · resets 10:20pm (Asia/Tokyo)",
    }),
  ).toBe(false);
  // stream 中の rate_limit_event も判定の根拠にしない(ADR 0104 決定2)
  expect(
    isCapInterruptionEnvelope({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
    }),
  ).toBe(false);
  expect(isCapInterruptionEnvelope(null)).toBe(false);
});
