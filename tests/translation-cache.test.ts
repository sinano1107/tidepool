import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  getCachedTranslation,
  hashSource,
  listTranslationUsage,
  recordTranslationCall,
  saveTranslation,
} from "../src/translation-cache.js";
import { tempDir } from "./temp-dir.js";

let db: Db | undefined;
afterEach(() => db?.close());

const USAGE = {
  input_tokens: 506,
  output_tokens: 16,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  estimated_cost_usd: 0.000586,
};
const SETTING = { provider: "anthropic", model: "haiku", effort: "low" } as const;

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

it("保存した訳文をそのまま読み戻せる", async () => {
  const db = await freshDb();
  const hash = hashSource("the board retires a settled tree");
  saveTranslation(db, hash, "Japanese", "盤面は決着したツリーを退ける", new Date("2026-07-21T00:00:00Z"));

  expect(getCachedTranslation(db, hash, "Japanese")).toBe("盤面は決着したツリーを退ける");
});

it("同じソースでも言語が異なればキャッシュは独立している", async () => {
  const db = await freshDb();
  const hash = hashSource("settled");
  saveTranslation(db, hash, "Japanese", "決着", new Date("2026-07-21T00:00:00Z"));

  expect(getCachedTranslation(db, hash, "French")).toBeUndefined();
});

it("同じ source_hash+language への2回目の保存は例外を投げない(同時翻訳リクエストの競合対策)", async () => {
  const db = await freshDb();
  const hash = hashSource("settled");
  const now = new Date("2026-07-21T00:00:00Z");
  saveTranslation(db, hash, "Japanese", "決着", now);

  expect(() => saveTranslation(db, hash, "Japanese", "別訳", now)).not.toThrow();
  // first writer wins — the row is never silently corrupted by the loser
  expect(getCachedTranslation(db, hash, "Japanese")).toBe("決着");
});

it("同一の created_at を持つ呼び出しの記録は保存順で返る(issue #688)", async () => {
  const db = await freshDb();
  const now = new Date("2026-07-21T00:00:00Z");
  for (const input_tokens of [1, 2, 3]) recordTranslationCall(db, SETTING, 1, { ...USAGE, input_tokens }, now);

  expect(listTranslationUsage(db).map((r) => r.usage.input_tokens)).toEqual([1, 2, 3]);
});

it("created_at が異なる呼び出しの記録は created_at の昇順で返る(先に新しい行を保存しても古い行が先頭)", async () => {
  const db = await freshDb();
  recordTranslationCall(db, SETTING, 1, { ...USAGE, input_tokens: 9 }, new Date("2026-07-21T00:00:01Z"));
  recordTranslationCall(db, SETTING, 1, { ...USAGE, input_tokens: 1 }, new Date("2026-07-21T00:00:00Z"));

  expect(listTranslationUsage(db).map((r) => r.usage.input_tokens)).toEqual([1, 9]);
});
