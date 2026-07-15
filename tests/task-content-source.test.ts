import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { contentSourceFor, registerTask, TaskContentSource } from "../src/tasks.js";
import { FakeGitHubClient } from "./fakes.js";

it("TaskContentSource.stored は保存済みの内容をそのまま解決する(通常タスクの即時パス)", async () => {
  const content = { title: "t", purpose: "p", completion_criteria: "c" };
  const source = TaskContentSource.stored(content);

  await expect(source.expand()).resolves.toEqual(content);
});

it("TaskContentSource.liveIssue は GitHub から取得した issue を導出して解決する(issue参照タスクの遅延パス)", async () => {
  const github = new FakeGitHubClient();
  github.scriptIssue(49, {
    title: "ログイン画面のバグ",
    body: "再現手順: ...",
    comments: ["追加情報です"],
  });
  const source = TaskContentSource.liveIssue(github, { path: "/repo", number: 49 });

  await expect(source.expand()).resolves.toEqual({
    title: "ログイン画面のバグ",
    purpose: "再現手順: ...",
    completion_criteria: "See the linked GitHub issue's body and comments for completion criteria.",
  });
});

it("contentSourceFor は通常タスクなら保存済み内容を即座に解決し、workspace の解決は一切呼ばない", async () => {
  const db = openDb(":memory:");
  const task = registerTask(
    db,
    { type: "work", title: "t", purpose: "p", completion_criteria: "c" },
    new Date(0),
  );
  let resolved = false;

  const source = contentSourceFor(task, new FakeGitHubClient(), () => {
    resolved = true;
    return "/repo";
  });

  await expect(source.expand()).resolves.toEqual({
    title: "t",
    purpose: "p",
    completion_criteria: "c",
  });
  expect(resolved).toBe(false);
});

it("contentSourceFor は issue参照タスクなら GitHub から解決した内容を返す(使用の瞬間の唯一の分岐点)", async () => {
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
    comments: [],
  });

  const source = contentSourceFor(task, github, () => "/repo");

  await expect(source.expand()).resolves.toEqual({
    title: "ログイン画面のバグ",
    purpose: "再現手順: ...",
    completion_criteria: "See the linked GitHub issue's body and comments for completion criteria.",
  });
});

it("contentSourceFor は issue参照タスクでも workspace が解決できなければプレースホルダーに落ちる", async () => {
  const db = openDb(":memory:");
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    new Date(0),
  );

  const source = contentSourceFor(task, new FakeGitHubClient(), () => undefined);

  await expect(source.expand()).resolves.toEqual({
    title: "#49",
    purpose: "#49",
    completion_criteria: "#49",
  });
});
