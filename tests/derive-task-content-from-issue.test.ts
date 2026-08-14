import { expect, it } from "vitest";
import type { Issue } from "../src/github.js";
import { deriveTaskContentFromIssue } from "../src/tasks.js";

it("deriveTaskContentFromIssue は issue 本文の後に全コメントを取得順で畳み込む(ADR 0016: issue は全スレッド)", () => {
  const issue: Issue = {
    title: "ログイン画面のバグ",
    body: "再現手順: ...",
    comments: ["追加情報です"],
  };

  const content = deriveTaskContentFromIssue(issue);

  expect(content.title).toBe("ログイン画面のバグ");
  expect(content.purpose).toBe("再現手順: ...\n\n## Issue comments\n\n追加情報です");
});

it("deriveTaskContentFromIssue はコメントがない issue に空の区切りを付けず、届いた内容だけを完了基準へ指す", () => {
  const issue: Issue = {
    title: "ログイン画面のバグ",
    body: "再現手順: ...",
    comments: [],
  };

  const content = deriveTaskContentFromIssue(issue);

  expect(content.purpose).toBe("再現手順: ...");
  expect(content.completion_criteria).toBe("See the issue content above for completion criteria.");
});
