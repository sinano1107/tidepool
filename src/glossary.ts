export interface GlossaryEntry {
  term: string;
  ja: string;
}

const HEADING_WITH_GLOSS = /^## (.+?)\(([^()]+)\)\s*$/;

/** Mechanically extracts the board's English-term ↔ Japanese-gloss pairs from
 *  CONTEXT.md's own `## Term(日本語)` heading shape (issue #47) — CONTEXT.md
 *  is itself the glossary (its own preamble: "このファイルは用語集"), so this
 *  reads it rather than duplicating a second term list that would drift.
 *  Headings without a parenthesized gloss (compound names like
 *  "Slot-release tree rule", slash-joined pairs like "Swell / Condensation")
 *  carry no Japanese term and are skipped. */
export function parseGlossary(contextMd: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const line of contextMd.split("\n")) {
    const match = HEADING_WITH_GLOSS.exec(line);
    if (match) entries.push({ term: match[1]!, ja: match[2]! });
  }
  return entries;
}
