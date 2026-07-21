import type { Db } from "./db.js";

/** Canonical values are English language names, not ISO codes or labels —
 *  the single source of truth for what a board's display language can be
 *  (issue #115). Normalization happens once at the write boundary
 *  (api.ts's displayLanguageSchema); nothing downstream re-checks a value
 *  against this list. */
export const SUPPORTED_DISPLAY_LANGUAGES = ["Japanese", "English"] as const;

const DEFAULT_DISPLAY_LANGUAGE = "Japanese";

export function getDisplayLanguage(db: Db): string {
  const row = db.prepare("SELECT language FROM display_language WHERE id = 1").get() as
    | { language: string }
    | undefined;
  return row?.language ?? DEFAULT_DISPLAY_LANGUAGE;
}

export function setDisplayLanguage(db: Db, language: string): void {
  db.prepare(
    `INSERT INTO display_language (id, language) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET language = excluded.language`,
  ).run(language);
}
