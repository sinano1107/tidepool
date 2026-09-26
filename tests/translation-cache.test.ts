import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  getCachedTranslation,
  hashSource,
  listTranslationUsage,
  saveTranslation,
} from "../src/translation-cache.js";
import { tempDir } from "./harness.js";

let db: Db | undefined;
afterEach(() => db?.close());

const USAGE = {
  input_tokens: 506,
  output_tokens: 16,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  estimated_cost_usd: 0.000586,
};

async function freshDb(): Promise<Db> {
  const dir = await tempDir("tidepool-translation-cache-");
  db = openDb(join(dir, "board.sqlite"));
  return db;
}

it("同じソース文字列は同じハッシュを、異なるソース文字列は異なるハッシュを持つ", () => {
  expect(hashSource("the board retires a settled tree")).toBe(
    hashSource("the board retires a settled tree"),
  );
  expect(hashSource("a")).not.toBe(hashSource("b"));
});

it("未キャッシュのソース+言語の組は undefined を返す", async () => {
  const db = await freshDb();
  expect(getCachedTranslation(db, hashSource("s"), "Japanese")).toBeUndefined();
});

it("保存した訳文とトークン使用量をそのまま読み戻せる", async () => {
  const db = await freshDb();
  const hash = hashSource("the board retires a settled tree");
  saveTranslation(db, hash, "Japanese", "盤面は決着したツリーを退ける", USAGE, new Date("2026-07-21T00:00:00Z"));

  expect(getCachedTranslation(db, hash, "Japanese")).toEqual({
    translated: "盤面は決着したツリーを退ける",
    usage: USAGE,
  });
});

it("同じソースでも言語が異なればキャッシュは独立している", async () => {
  const db = await freshDb();
  const hash = hashSource("settled");
  saveTranslation(db, hash, "Japanese", "決着", USAGE, new Date("2026-07-21T00:00:00Z"));

  expect(getCachedTranslation(db, hash, "French")).toBeUndefined();
});

it("同じ source_hash+language への2回目の保存は例外を投げない(同時翻訳リクエストの競合対策)", async () => {
  const db = await freshDb();
  const hash = hashSource("settled");
  const now = new Date("2026-07-21T00:00:00Z");
  saveTranslation(db, hash, "Japanese", "決着", USAGE, now);

  expect(() => saveTranslation(db, hash, "Japanese", "別訳", USAGE, now)).not.toThrow();
  // first writer wins — the row is never silently corrupted by the loser
  expect(getCachedTranslation(db, hash, "Japanese")?.translated).toBe("決着");
});

it("同一の created_at を持つ行は保存順で返る(1リクエストが複数行を生む場合、issue #688)", async () => {
  const db = await freshDb();
  const now = new Date("2026-07-21T00:00:00Z");
  saveTranslation(db, hashSource("purpose"), "Japanese", "目的", { ...USAGE, input_tokens: 1 }, now);
  saveTranslation(db, hashSource("item-1"), "Japanese", "項目1", { ...USAGE, input_tokens: 2 }, now);
  saveTranslation(db, hashSource("item-2"), "Japanese", "項目2", { ...USAGE, input_tokens: 3 }, now);

  const records = listTranslationUsage(db);
  expect(records.map((r) => r.usage.input_tokens)).toEqual([1, 2, 3]);
});

it("created_at が異なる行は created_at の昇順で返る(先に新しい行を保存しても古い行が先頭)", async () => {
  const db = await freshDb();
  const later = new Date("2026-07-21T00:00:01Z");
  const earlier = new Date("2026-07-21T00:00:00Z");
  saveTranslation(db, hashSource("later-row"), "Japanese", "後", { ...USAGE, input_tokens: 9 }, later);
  saveTranslation(db, hashSource("earlier-row"), "Japanese", "先", { ...USAGE, input_tokens: 1 }, earlier);

  const records = listTranslationUsage(db);
  expect(records.map((r) => r.usage.input_tokens)).toEqual([1, 9]);
});
