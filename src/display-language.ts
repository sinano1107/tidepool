import type { Db } from "./db.js";

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
