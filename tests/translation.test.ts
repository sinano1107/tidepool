import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { reportThrottle } from "../src/throttle.js";
import { translateSource } from "../src/translation.js";
import { getCachedTranslation, hashSource } from "../src/translation-cache.js";
import { FakeTranslationClient } from "./fakes.js";

let db: Db | undefined;
afterEach(() => db?.close());

async function freshDb(): Promise<Db> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-translation-"));
  db = openDb(join(dir, "board.sqlite"));
  return db;
}

const NOW = new Date("2026-07-21T00:00:00Z");

it("キャッシュミス時は TranslationClient を呼び、結果をキャッシュへ保存する", async () => {
  const db = await freshDb();
  const client = new FakeTranslationClient();
  client.scriptTranslation("盤面は決着したツリーを退ける");

  const outcome = await translateSource(
    db,
    client,
    "the board retires a settled tree",
    "Japanese",
    NOW,
  );

  expect(outcome).toEqual({
    status: "translated",
    text: "盤面は決着したツリーを退ける",
    cached: false,
  });
  expect(client.calls).toEqual([
    { source: "the board retires a settled tree", language: "Japanese" },
  ]);
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

it("throttled 中はクライアントを呼ばず、区別可能な throttled 応答を返す(完了基準)", async () => {
  const db = await freshDb();
  reportThrottle(db, { throttled: true, resetsAt: null, windows: { session: null, week: null, fable: null } });
  const client = new FakeTranslationClient();

  const outcome = await translateSource(db, client, "never called", "Japanese", NOW);

  expect(outcome).toEqual({ status: "throttled" });
  expect(client.calls).toEqual([]);
});

it("キャッシュミス時、クライアントが返したトークン使用量をそのままキャッシュへ記録する(claude-worker.ts と同じ粒度 — 完了基準)", async () => {
  const db = await freshDb();
  const client = new FakeTranslationClient();
  client.scriptTranslation("訳文");

  await translateSource(db, client, "the board retires a settled tree", "Japanese", NOW);

  const cached = getCachedTranslation(
    db,
    hashSource("the board retires a settled tree"),
    "Japanese",
  );
  expect(cached?.usage).toEqual({
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    estimated_cost_usd: 0.0001,
  });
});

it("throttled 中でも既にキャッシュ済みのソースは翻訳を返す(原文の再確認コストを課さない)", async () => {
  const db = await freshDb();
  const client = new FakeTranslationClient();
  client.scriptTranslation("訳文");
  await translateSource(db, client, "same text", "Japanese", NOW);

  reportThrottle(db, { throttled: true, resetsAt: null, windows: { session: null, week: null, fable: null } });
  const outcome = await translateSource(db, client, "same text", "Japanese", NOW);

  expect(outcome).toEqual({ status: "translated", text: "訳文", cached: true });
});
