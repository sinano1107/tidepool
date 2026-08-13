import { afterEach, expect, it, vi } from "vitest";
import {
  CLI_AUTH_EXPIRY_WARNING_TITLE,
  resolveCliAuthExpiry,
} from "../src/cli-auth.js";
import { openDb } from "../src/db.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("期限設定は任意で、未設定なら警告なし、不正値ならログだけで警告を無効にする(#320)", () => {
  const warn = vi.fn();

  expect({ absent: resolveCliAuthExpiry(undefined, warn), warnings: warn.mock.calls }).toEqual({
    absent: undefined,
    warnings: [],
  });

  expect(resolveCliAuthExpiry("not-a-date", warn)).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.join(" ")).toContain("TIDEPOOL_CLAUDE_TOKEN_EXPIRES_AT");
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

  const db = openDb(`${t.dir}/board.sqlite`);
  const questions = db
    .prepare("SELECT title, purpose, status FROM tasks WHERE question_cli_auth_expiry_warning = 1")
    .all() as any[];
  db.close();
  expect(questions).toHaveLength(1);
  expect(questions[0]).toMatchObject({
    title: CLI_AUTH_EXPIRY_WARNING_TITLE,
    status: "done",
  });
  expect(questions[0].purpose).toContain("1970-01-31T00:00:00.000Z");
});

it("期限まで30日より長ければ更新questionを立てない(#320)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "authenticated" }),
    cliAuthExpiresAt: new Date(31 * 24 * 60 * 60 * 1000),
  });

  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).toEqual([]);
});
