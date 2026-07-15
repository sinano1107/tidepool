import { expect, it } from "vitest";
import type { Issue } from "../src/github.js";
import { deriveTaskContentFromIssue } from "../src/tasks.js";

it("deriveTaskContentFromIssue は issue の title/body から title/purpose を導出し、completion_criteria は issue 本文へ委譲する定型文になる(ADR 0016: 3要素は全部導出)", () => {
  const issue: Issue = {
    title: "ログイン画面のバグ",
    body: "再現手順: ...",
    comments: ["追加情報です"],
  };

  const content = deriveTaskContentFromIssue(issue);

  expect(content.title).toBe("ログイン画面のバグ");
  expect(content.purpose).toBe("再現手順: ...");
  expect(content.completion_criteria).toContain("issue");
});
