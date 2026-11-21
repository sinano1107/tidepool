import { posix } from "node:path";
import type { TreeDeltaEntry } from "./git.js";

const DEFAULT_PATHS = new Set([".GITHUB", ".GITHUB/WORKFLOWS", "CODEOWNERS", ".GITHUB/CODEOWNERS", "DOCS/CODEOWNERS"]);

export type HumanMergePathReview =
  | { kind: "matches"; paths: string[] }
  | { kind: "unreadable" }
  | { kind: "retargeted"; actual: string; expected: string };

export function humanMergePathExplanation(review: HumanMergePathReview): string {
  switch (review.kind) {
    case "matches":
      return `This PR changes paths that require a human merge. ${review.paths.map((path) => JSON.stringify(path)).join(", ")}.`;
    case "unreadable":
      return "The board could not compare this PR head with the protected branch to check which paths require a human merge.";
    case "retargeted":
      return `This PR targets ${JSON.stringify(review.actual)}. The workspace's protected branch is ${JSON.stringify(review.expected)}.`;
  }
}

/** ADR 0395 決定4: diff-tree -r reports non-tree entries at `.github` and `.github/workflows`.
 *  Fold to uppercase as in ADR 0362, including compatibility spellings like `ſ` and `ﬁ`. */
export function humanMergePathChanges(delta: TreeDeltaEntry[], declared: readonly string[]): string[] {
  const globs = declared.map((pattern) => pattern.toUpperCase());
  return delta.map(({ path }) => path).filter((path) => {
    const folded = path.toUpperCase();
    return DEFAULT_PATHS.has(folded) || folded.startsWith(".GITHUB/WORKFLOWS/") || globs.some((glob) => posix.matchesGlob(folded, glob));
  });
}
