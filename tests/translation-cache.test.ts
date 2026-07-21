import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { getCachedTranslation, hashSource, saveTranslation } from "../src/translation-cache.js";

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
  const dir = await mkdtemp(join(tmpdir(), "tidepool-translation-cache-"));
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
