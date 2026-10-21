import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";
import { type Db, openDb } from "../src/db.js";
import { reportProviderUsage } from "../src/throttle.js";
import { translateSource } from "../src/translation.js";
import { getCachedTranslation, hashSource, listTranslationUsage } from "../src/translation-cache.js";
import { FakeTranslationClient } from "./fakes.js";
import { tempDir } from "./temp-dir.js";

let db: Db | undefined;
afterEach(() => db?.close());

async function freshDb(): Promise<Db> {
  const dir = await tempDir("tidepool-translation-");
  db = openDb(join(dir, "board.sqlite"));
  return db;
}

const NOW = new Date("2026-07-21T00:00:00Z");

function throttleAnthropic(db: Db): void {
  reportProviderUsage(db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: NOW,
    windows: [
      {
        window: "session",
        model: null,
        usedPercent: 50,
        durationMs: 5 * 60 * 60 * 1000,
        resetsAt: new Date(NOW.getTime() + 60 * 60 * 1000),
        throttled: true,
        resumesAt: new Date(NOW.getTime() + 30 * 60 * 1000),
      },
    ],
  });
}

it("キャッシュミス時は断片1つのまとめとして TranslationClient を1回呼び、訳文をキャッシュへ保存する", async () => {
  const db = await freshDb();
  const client = new FakeTranslationClient();
  client.scriptTranslation("盤面は決着したツリーを退ける");

  const outcome = await translateSource(db, client, "the board retires a settled tree", "Japanese", NOW);

  expect(outcome).toEqual({ status: "translated", text: "盤面は決着したツリーを退ける", cached: false });
  expect(client.calls).toEqual([{ fragments: ["the board retires a settled tree"], language: "Japanese" }]);
  expect(getCachedTranslation(db, hashSource("the board retires a settled tree"), "Japanese")).toBe(
    "盤面は決着したツリーを退ける",
  );
});

it("同じソース+言語の2回目の呼び出しはキャッシュから返し、クライアントを再度呼ばない(完了基準)", async () => {
  const db = await freshDb();
  const client = new FakeTranslationClient();
  client.scriptTranslation("訳文");

  await translateSource(db, client, "same text", "Japanese", NOW);
  const second = await translateSource(db, client, "same text", "Japanese", NOW);

  expect(second).toEqual({ status: "translated", text: "訳文", cached: true });
  expect(client.calls).toHaveLength(1);
});

it("Anthropic window が throttled のとき、translateSource は throttled を返しクライアントを呼ばない", async () => {
  const db = await freshDb();
  throttleAnthropic(db);
  const client = new FakeTranslationClient();

  expect(await translateSource(db, client, "never called", "Japanese", NOW)).toEqual({
    status: "throttled",
  });
  expect(client.calls).toHaveLength(0);
});

it("呼び出し1回が translation_calls の1行になり、Provider・pin の綴りの model・断片数・使用量を持つ(ADR 0296 決定5)", async () => {
  const db = await freshDb();
  const client = new FakeTranslationClient();

  await translateSource(db, client, "the board retires a settled tree", "Japanese", NOW);
  await translateSource(db, client, "the board retires a settled tree", "Japanese", NOW);

  expect(listTranslationUsage(db)).toEqual([
    {
      provider: "anthropic",
      model: "haiku",
      fragments: 1,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        estimated_cost_usd: 0.0001,
      },
      createdAt: NOW.toISOString(),
    },
  ]);
});

it("throttled 中でも既にキャッシュ済みのソースは翻訳を返す(原文の再確認コストを課さない)", async () => {
  const db = await freshDb();
  const client = new FakeTranslationClient();
  client.scriptTranslation("訳文");
  await translateSource(db, client, "same text", "Japanese", NOW);

  throttleAnthropic(db);
  const outcome = await translateSource(db, client, "same text", "Japanese", NOW);

  expect(outcome).toEqual({ status: "translated", text: "訳文", cached: true });
});

it("CLI の封筒が is_error: true なら translateSource は reject し、エラー本文を訳としてキャッシュしない(#652)", async () => {
  const db = await freshDb();
  const client = new ClaudeTranslationClient({
    exec: async () =>
      JSON.stringify({
        is_error: true,
        result: "You've hit your session limit",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
  });

  await expect(translateSource(db, client, "the board retires a settled tree", "Japanese", NOW)).rejects.toThrow(
    "You've hit your session limit",
  );
  expect(getCachedTranslation(db, hashSource("the board retires a settled tree"), "Japanese")).toBeUndefined();
});
