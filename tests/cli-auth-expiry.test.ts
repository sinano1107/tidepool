import { afterEach, expect, it, vi } from "vitest";
import {
  CLI_AUTH_EXPIRY_WARNING_TITLE,
  resolveCliAuthExpiry,
} from "../src/cli-auth.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("期限設定は任意で、未設定なら警告なし、不正値ならログだけで警告を無効にする(#320)", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(resolveCliAuthExpiry(undefined)).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
  expect(resolveCliAuthExpiry("not-a-date")).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.join(" ")).toContain("TIDEPOOL_CLAUDE_TOKEN_EXPIRES_AT");
  warn.mockRestore();
});

it("暦に存在しないISO日付は正規化せず不正値として警告する(#320)", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  expect(resolveCliAuthExpiry("2026-02-30")).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();

  warn.mockRestore();
});

it("有効期限の30日前に英語の更新questionを履歴全体で1枚だけ立てる(#320)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "authenticated" }),
    cliAuthExpiresAt: new Date(30 * 24 * 60 * 60 * 1000),
  });

  const first = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find(
    (task) => task.title === CLI_AUTH_EXPIRY_WARNING_TITLE,
  );
  expect(
    (
      await api(t.baseUrl, "POST", `/api/tasks/${first.id}/answer`, {
        answers: ["token rotated"],
      })
    ).status,
  ).toBe(200);
  await t.clock.advance(60 * 60 * 1000);

  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).toEqual([]);
  const answered = (await api(t.baseUrl, "GET", `/api/tasks/${first.id}`)).json;
  expect(answered).toMatchObject({
    title: CLI_AUTH_EXPIRY_WARNING_TITLE,
    status: "done",
  });
  expect(answered.purpose).toContain("1970-01-31T00:00:00.000Z");
});

it("トークン更新後は新しい期限について次の警告questionを1枚立てる(#320)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "authenticated" }),
    cliAuthExpiresAt: new Date(30 * 24 * 60 * 60 * 1000),
  });
  const first = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find(
    (task) => task.title === CLI_AUTH_EXPIRY_WARNING_TITLE,
  );
  await api(t.baseUrl, "POST", `/api/tasks/${first.id}/answer`, { answers: ["token rotated"] });

  const dir = t.dir;
  await t.stopServer();
  t = await bootTidepool({
    dir,
    cliAuth: async () => ({ status: "authenticated" }),
    cliAuthExpiresAt: new Date(29 * 24 * 60 * 60 * 1000),
  });

  const openQuestions = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter(
    (task) => task.title === CLI_AUTH_EXPIRY_WARNING_TITLE,
  );
  expect(openQuestions).toHaveLength(1);
  expect(openQuestions[0].purpose).toContain("1970-01-30T00:00:00.000Z");
});

it("期限まで30日より長ければ更新questionを立てない(#320)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "authenticated" }),
    cliAuthExpiresAt: new Date(31 * 24 * 60 * 60 * 1000),
  });

  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).toEqual([]);
});
