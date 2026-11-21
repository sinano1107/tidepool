import { posix } from "node:path";
import type { TreeDeltaEntry } from "./git.js";

const DEFAULT_PATHS = new Set([".GITHUB", ".GITHUB/WORKFLOWS", "CODEOWNERS", ".GITHUB/CODEOWNERS", "DOCS/CODEOWNERS"]);

/** ADR 0395 決定4: diff-tree -r reports non-tree entries at `.github` and `.github/workflows`.
 *  Fold to uppercase as in ADR 0362, including compatibility spellings like `ſ` and `ﬁ`. */
export function humanMergePathChanges(delta: TreeDeltaEntry[], declared: readonly string[]): string[] {
  const globs = declared.map((pattern) => pattern.toUpperCase());
  return delta.map(({ path }) => path).filter((path) => {
    const folded = path.toUpperCase();
    return DEFAULT_PATHS.has(folded) || folded.startsWith(".GITHUB/WORKFLOWS/") || globs.some((glob) => posix.matchesGlob(folded, glob));
  });
}
