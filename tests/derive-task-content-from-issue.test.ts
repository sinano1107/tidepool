import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { contentSourceFor, registerTask } from "../src/tasks.js";
import { FakeGitHubClient } from "./fakes.js";

it("issue参照タスクは issue 本文の後に全コメントを取得順で畳み込む(ADR 0016: issue は全スレッド)", async () => {
  const db = openDb(":memory:");
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    new Date(0),
  );
  const github = new FakeGitHubClient();
  github.scriptIssue(49, {
    title: "ログイン画面のバグ",
    body: "再現手順: ...",
    comments: ["追加情報です", "これも見てください"],
  });

  const content = await contentSourceFor(task, github, () => "/repo").expand();

  expect(content.title).toBe("ログイン画面のバグ");
  expect(content.purpose).toBe(
    "再現手順: ...\n\n## Issue comments\n\n追加情報です\n\nこれも見てください",
  );
});

it("issue参照タスクはコメントがない issue に空の区切りを付けず、届いた内容だけを完了基準へ指す", async () => {
  const db = openDb(":memory:");
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    new Date(0),
  );
  const github = new FakeGitHubClient();
  github.scriptIssue(49, { title: "ログイン画面のバグ", body: "再現手順: ...", comments: [] });

  const content = await contentSourceFor(task, github, () => "/repo").expand();

  expect(content.purpose).toBe("再現手順: ...");
  expect(content.completion_criteria).toBe("See the issue content above for completion criteria.");
});
