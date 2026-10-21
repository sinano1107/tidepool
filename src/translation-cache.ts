import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import type { TranslationSetting, TranslationUsage } from "./translate.js";

/** The cache key for one translation target's source text (issue #47): a
 *  content hash rather than an event id, so every target shape (an events
 *  row's line/result, a task row's purpose/item/handoff text) shares one
 *  lookup without needing two key strategies. */
export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** The cached translation's text — the cache holds no usage, a record is not a cache (ADR 0175 / ADR 0296 決定5). */
export function getCachedTranslation(db: Db, sourceHash: string, language: string): string | undefined {
  const row = db
    .prepare("SELECT translated FROM translation_cache WHERE source_hash = ? AND language = ?")
    .get(sourceHash, language) as { translated: string } | undefined;
  return row?.translated;
}

/** Log entries are immutable (CONTEXT.md: 記録は不滅・不変), so a cached
 *  translation stays valid forever — this only ever inserts, never updates.
 *  `OR IGNORE`: two concurrent misses on the same source+language (e.g. a
 *  question's purpose translated twice from overlapping requests) can both
 *  reach here before either's row lands — the loser's insert is a silent
 *  no-op rather than a UNIQUE-constraint throw, first writer wins. */
export function saveTranslation(db: Db, sourceHash: string, language: string, translated: string, now: Date): void {
  db.prepare(
    `INSERT OR IGNORE INTO translation_cache (source_hash, language, translated, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sourceHash, language, translated, now.toISOString());
}

/** One translation call's usage — a batched call is one row, its fragments carry none (ADR 0296 決定5). */
export function recordTranslationCall(
  db: Db,
  setting: TranslationSetting,
  fragments: number,
  usage: TranslationUsage,
  now: Date,
): void {
  db.prepare(
    `INSERT INTO translation_calls
       (provider, model, effort, fragments, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, estimated_cost_usd, created_at)
     VALUES (@provider, @model, @effort, @fragments, @input_tokens, @output_tokens,
             @cache_read_tokens, @cache_creation_tokens, @estimated_cost_usd, @createdAt)`,
  ).run({ ...setting, fragments, ...usage, createdAt: now.toISOString() });
}

export interface TranslationUsageRecord {
  provider: TranslationSetting["provider"];
  model: string;
  fragments: number;
  usage: TranslationUsage;
  createdAt: string;
}

type TranslationCallRow = Omit<TranslationUsageRecord, "usage" | "createdAt"> & TranslationUsage & { created_at: string };

/** Every translation call's usage, oldest first (issue #47's "record it the
 *  same way worker sessions do, make it observable"): a cache hit makes no
 *  call and so adds no row. Rows sharing a `created_at` (one request's `now`
 *  covers each chunk of one target, issue #688) come back in the order they
 *  were inserted, so the last one is the latest call. */
export function listTranslationUsage(db: Db): TranslationUsageRecord[] {
  const rows = db
    .prepare(
      `SELECT provider, model, fragments, input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, estimated_cost_usd, created_at
         FROM translation_calls ORDER BY created_at, rowid`,
    )
    .all() as TranslationCallRow[];
  return rows.map(({ provider, model, fragments, created_at, ...usage }) => ({
    provider,
    model,
    fragments,
    usage,
    createdAt: created_at,
  }));
}
