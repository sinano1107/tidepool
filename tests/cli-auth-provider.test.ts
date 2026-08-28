import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMoonshotCliAuthCheck } from "../src/claude-cli-auth.js";
import {
  openCliAuthQuestion,
  quarantineCliAuthForProvider,
  quarantinedAuthProviders,
} from "../src/cli-auth.js";
import { openDb } from "../src/db.js";
import { listBoard } from "../src/tasks.js";

/** ADR 0098 / issue #454: 401 の Provider 帰属は spawn/call 時の事実で決まり、
 *  失効した Provider を喋る agent の pickup だけが止まる。 */
describe("quarantineCliAuthForProvider(issue #454 / ADR 0098)", () => {
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
    // 修理案内は provider ごとの網羅マップから来る — moonshot にはキーファイルの案内
    expect(question?.purpose).toContain("`~/.tidepool/moonshot-api-key`");
    expect(question?.purpose).toContain("TIDEPOOL_MOONSHOT_API_KEY_FILE");
    // 資源単位の停止は盤面全体の停止の列挙に入らない(ADR 0058 決定1)
    expect(openCliAuthQuestion(db)).toBeUndefined();
  });

  it("同一 provider への2度目の quarantine は question を増やさない(1資源につき確認は最大1枚)", () => {
    const db = openDb(":memory:");
    quarantineCliAuthForProvider(db, "moonshot", new Date(0));
    quarantineCliAuthForProvider(db, "moonshot", new Date(1));

    expect(listBoard(db).filter((t) => t.type === "question")).toHaveLength(1);
  });

  it("anthropic の 401 も Provider-scoped Confirmation に落ち、盤面全体は止めない", () => {
    const db = openDb(":memory:");
    quarantineCliAuthForProvider(db, "anthropic", new Date(0));

    const question = listBoard(db).find((t) => t.type === "question");
    expect(question?.title).toBe(
      "anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped",
    );
    expect(question?.question_quarantine_provider_auth).toBe("anthropic");
    expect(question?.purpose).toContain("claude setup-token");
    expect(openCliAuthQuestion(db)).toBeUndefined();
  });

  it("quarantinedAuthProviders は資源単位の quarantine 中の provider だけを返す", () => {
    const db = openDb(":memory:");
    expect(quarantinedAuthProviders(db)).toEqual([]);
    quarantineCliAuthForProvider(db, "anthropic", new Date(0));
    expect(quarantinedAuthProviders(db)).toEqual(["anthropic"]);
    quarantineCliAuthForProvider(db, "moonshot", new Date(1));
    expect(quarantinedAuthProviders(db)).toEqual(["anthropic", "moonshot"]);
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

  it("probe の予算は $0.25 — kimi-k3[1m] の最小1ターン実測($0.057〜$0.122、issue #447)を $0.01 では必ず踏む(issue #466)", async () => {
    const keyFile = keyFileWith("sk-moonshot-test-key");
    let observedArgs: string[] | undefined;
    const check = createMoonshotCliAuthCheck(keyFile, async (_command, args) => {
      observedArgs = args;
      return { exitCode: 0, stdout: JSON.stringify({ is_error: false, result: "OK" }) };
    });

    await check();

    const flagIndex = observedArgs?.indexOf("--max-budget-usd") ?? -1;
    expect(flagIndex).toBeGreaterThan(-1);
    expect(observedArgs?.[flagIndex + 1]).toBe("0.25");
  });

  it("error_max_budget_usd エンベロープは unknown のまま、予算超過と判る reason を返す(issue #466)", async () => {
    const keyFile = keyFileWith("sk-moonshot-test-key");
    const check = createMoonshotCliAuthCheck(keyFile, async () => ({
      exitCode: 1,
      stdout: JSON.stringify({
        is_error: true,
        subtype: "error_max_budget_usd",
        result: "Reached max budget ($0.25)",
      }),
    }));

    await expect(check()).resolves.toEqual({
      status: "unknown",
      reason: "probe exceeded its budget cap before authenticating",
    });
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
