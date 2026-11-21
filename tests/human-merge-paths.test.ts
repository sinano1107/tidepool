import { expect, it } from "vitest";
import { humanMergePathChanges } from "../src/human-merge-paths.js";

it("keeps the built-in human merge paths and adds case-folded repository-relative globs", () => {
  const paths = [
    ".GITHUB/workflowſ/release.yml",
    ".github/workflows/.hidden.yml",
    ".github",
    ".github/WORKFLOWS",
    "CODEOWNERS",
    ".github/codeowners",
    "docs/CODEOWNERſ",
    "Deploy/conﬁg/release.SH",
    "Deploy/release.sh",
    "docs/nested/CODEOWNERS",
    ".github/workflows-old/release.yml",
    "examples/.github/workflows/release.yml",
  ].map((path) => ({ path, dstMode: "100644" }));

  expect(humanMergePathChanges(paths, [])).toEqual([
    ".GITHUB/workflowſ/release.yml",
    ".github/workflows/.hidden.yml",
    ".github",
    ".github/WORKFLOWS",
    "CODEOWNERS",
    ".github/codeowners",
    "docs/CODEOWNERſ",
  ]);
  expect(humanMergePathChanges(paths, ["deploy/**/*.sh"])).toContain("Deploy/conﬁg/release.SH");
  expect(humanMergePathChanges(paths, ["deploy/config/*.sh"])).toContain("Deploy/conﬁg/release.SH");
  expect(humanMergePathChanges(paths, ["deploy/**/*.sh"])).toContain("Deploy/release.sh");
});
