import { expect, it } from "vitest";
import { createClaudeCliAuthCheck } from "../src/claude-cli-auth.js";

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
