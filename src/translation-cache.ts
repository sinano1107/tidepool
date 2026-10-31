import { createHash } from "node:crypto";
import type { Db } from "./db.js";

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

/** Log entries are immutable (GLOSSARY.md: 記録は不滅・不変), so a cached
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
