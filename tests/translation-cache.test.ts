import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { getCachedTranslation, hashSource, saveTranslation } from "../src/translation-cache.js";
import { tempDir } from "./temp-dir.js";

let db: Db | undefined;
afterEach(() => db?.close());

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
