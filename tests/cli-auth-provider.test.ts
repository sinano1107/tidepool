import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { createMoonshotCliAuthCheck } from "../src/claude-cli-auth.js";
import {
  CLI_AUTH_QUESTION_TITLE,
  openCliAuthQuestion,
  quarantineCliAuthForProvider,
  quarantinedAuthProviders,
} from "../src/cli-auth.js";
import { openDb } from "../src/db.js";
import { listBoard } from "../src/tasks.js";

/** issue #446 / ADR 0097 決定2: 401 の provider 帰属は spawn 時の事実で決まり、
 *  失効した provider を喋る agent の pickup だけが止まる資源単位の quarantine
 *  に落ちる。盤面自身が依存する provider(anthropic)だけが従来通り盤面全体の
 *  停止に抜ける。 */
describe("quarantineCliAuthForProvider(issue #446 / ADR 0097 決定2)", () => {
  it("moonshot の 401 は、その provider 名を背負った1択の Confirmation question を Tidepool 名義で立て、盤面全体は止まらない", () => {
    const db = openDb(":memory:");
    quarantineCliAuthForProvider(db, "moonshot", new Date(0));

    const question = listBoard(db).find((t) => t.type === "question");
    expect(question?.title).toBe(
      "moonshot authentication is unavailable — pickup of moonshot-speaking agents is stopped",
    );
    expect(question?.question_quarantine_provider_auth).toBe("moonshot");
    expect(question?.question_items?.[0]?.options).toEqual(["authentication restored"]);
    expect(question?.question_items?.[0]?.recommendation).toBe("authentication restored");
    // 資源単位の停止は盤面全体の停止の列挙に入らない(ADR 0058 決定1)
    expect(openCliAuthQuestion(db)).toBeUndefined();
    expect(boardHalts(db)).toEqual([]);
  });

  it("同一 provider への2度目の quarantine は question を増やさない(1資源につき確認は最大1枚)", () => {
    const db = openDb(":memory:");
    quarantineCliAuthForProvider(db, "moonshot", new Date(0));
    quarantineCliAuthForProvider(db, "moonshot", new Date(1));

    expect(listBoard(db).filter((t) => t.type === "question")).toHaveLength(1);
  });

  it("anthropic の 401 は従来通り盤面全体の停止(cliAuth)に抜ける", () => {
    const db = openDb(":memory:");
    quarantineCliAuthForProvider(db, "anthropic", new Date(0));

    const question = listBoard(db).find((t) => t.type === "question");
    expect(question?.title).toBe(CLI_AUTH_QUESTION_TITLE);
    expect(question?.question_quarantine_provider_auth).toBeNull();
    expect(boardHalts(db).map((halt) => halt.kind)).toEqual(["cliAuth"]);
  });

  it("quarantinedAuthProviders は資源単位の quarantine 中の provider だけを返す", () => {
    const db = openDb(":memory:");
    expect(quarantinedAuthProviders(db)).toEqual([]);
    quarantineCliAuthForProvider(db, "anthropic", new Date(0));
    // 盤面全体の停止(anthropic)は資源単位の一覧に混ぜない
    expect(quarantinedAuthProviders(db)).toEqual([]);
    quarantineCliAuthForProvider(db, "moonshot", new Date(1));
    expect(quarantinedAuthProviders(db)).toEqual(["moonshot"]);
  });
});

describe("createMoonshotCliAuthCheck(issue #446 — quarantine 回答受理時の再検証が撃つ moonshot 向き probe)", () => {
  afterEach(() => vi.unstubAllEnvs());

  function keyFileWith(key: string): string {
    const dir = mkdtempSync(join(tmpdir(), "tidepool-moonshot-key-"));
    const path = join(dir, "moonshot-api-key");
    writeFileSync(path, key, { mode: 0o600 });
    return path;
  }

  it("401 envelope は unauthorized、成功 envelope は authenticated — 判定は anthropic と同じ機械判定", async () => {
    const keyFile = keyFileWith("sk-moonshot-test-key");
    const unauthorized = createMoonshotCliAuthCheck(keyFile, async () => ({
      exitCode: 1,
      stdout: JSON.stringify({
        is_error: true,
        api_error_status: 401,
        result: "Failed to authenticate. API Error: 401 Invalid bearer token",
      }),
    }));
    await expect(unauthorized()).resolves.toEqual({ status: "unauthorized", reason: "API returned 401" });

    const authenticated = createMoonshotCliAuthCheck(keyFile, async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ is_error: false, result: "OK" }),
    }));
    await expect(authenticated()).resolves.toEqual({ status: "authenticated" });
  });

  it("probe は Moonshot の向き先・キーファイル由来の Bearer トークン・provider 表記のモデルを env に載せ、Claude のサブスク資格情報は除く", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oauth-should-be-scrubbed");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-should-be-scrubbed");
    const keyFile = keyFileWith("sk-moonshot-test-key");
    let observed: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
    const check = createMoonshotCliAuthCheck(keyFile, async (_command, args, options) => {
      observed = { args, env: options.env };
      return { exitCode: 0, stdout: JSON.stringify({ is_error: false, result: "OK" }) };
    });

    await check();

    expect(observed?.env.ANTHROPIC_BASE_URL).toBe("https://api.moonshot.ai/anthropic");
    expect(observed?.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-moonshot-test-key");
    expect(observed?.env.ANTHROPIC_MODEL).toBe("kimi-k3[1m]");
    expect(observed?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(observed?.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("キーファイルが無ければ probe を撃たずに unauthorized と分類する(資格情報が無い = 認証できない)", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "tidepool-moonshot-key-")), "moonshot-api-key");
    let calls = 0;
    const check = createMoonshotCliAuthCheck(missing, async () => {
      calls += 1;
      return { exitCode: 0, stdout: JSON.stringify({ is_error: false, result: "OK" }) };
    });

    const result = await check();

    expect(calls).toBe(0);
    expect(result.status).toBe("unauthorized");
    expect(result.status === "unauthorized" && result.reason).toContain("moonshot-api-key");
  });
});
