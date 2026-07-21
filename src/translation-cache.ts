import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import type { TranslationUsage } from "./translate.js";

/** The cache key for one translation target's source text (issue #47): a
 *  content hash rather than an event id, so every target shape (an events
 *  row's line/result, a task row's purpose/item/handoff text) shares one
 *  lookup without needing two key strategies. */
export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

interface CachedTranslation {
  translated: string;
  usage: TranslationUsage;
}

interface TranslationCacheRow {
  translated: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  estimated_cost_usd: number;
}

export function getCachedTranslation(
  db: Db,
  sourceHash: string,
  language: string,
): CachedTranslation | undefined {
  const row = db
    .prepare(
      `SELECT translated, input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, estimated_cost_usd
         FROM translation_cache WHERE source_hash = ? AND language = ?`,
    )
    .get(sourceHash, language) as TranslationCacheRow | undefined;
  if (!row) return undefined;
  return {
    translated: row.translated,
    usage: {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_creation_tokens: row.cache_creation_tokens,
      estimated_cost_usd: row.estimated_cost_usd,
    },
  };
}

/** Log entries are immutable (CONTEXT.md: 記録は不滅・不変), so a cached
 *  translation stays valid forever — this only ever inserts, never updates.
 *  `OR IGNORE`: two concurrent misses on the same source+language (e.g. a
 *  question's purpose translated twice from overlapping requests) can both
 *  reach here before either's row lands — the loser's insert is a silent
 *  no-op rather than a UNIQUE-constraint throw, first writer wins. */
export function saveTranslation(
  db: Db,
  sourceHash: string,
  language: string,
  translated: string,
  usage: TranslationUsage,
  now: Date,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO translation_cache
       (source_hash, language, translated, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, estimated_cost_usd, created_at)
     VALUES (@sourceHash, @language, @translated, @input_tokens, @output_tokens,
             @cache_read_tokens, @cache_creation_tokens, @estimated_cost_usd, @createdAt)`,
  ).run({
    sourceHash,
    language,
    translated,
    ...usage,
    createdAt: now.toISOString(),
  });
}

export interface TranslationUsageRecord {
  language: string;
  usage: TranslationUsage;
  createdAt: string;
}

interface TranslationUsageRow extends TranslationCacheRow {
  language: string;
  created_at: string;
}

/** Every generated (non-cached) translation's token usage, oldest first
 *  (issue #47's "record it the same way worker sessions do, make it
 *  observable"): a cache hit never adds a row (saveTranslation only runs on
 *  a miss), so this lists exactly the LLM calls actually made, same as
 *  GET /api/tasks/:id/events surfaces a work task's worker_exited usage. */
export function listTranslationUsage(db: Db): TranslationUsageRecord[] {
  const rows = db
    .prepare(
      `SELECT language, translated, input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, estimated_cost_usd, created_at
         FROM translation_cache ORDER BY created_at`,
    )
    .all() as TranslationUsageRow[];
  return rows.map((row) => ({
    language: row.language,
    usage: {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_creation_tokens: row.cache_creation_tokens,
      estimated_cost_usd: row.estimated_cost_usd,
    },
    createdAt: row.created_at,
  }));
}
