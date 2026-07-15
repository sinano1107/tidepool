import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { IssueGoneError } from "../src/github.js";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, HOUR, makeWorkspace, type Tidepool } from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it("issue参照タスクの展開が一時的に失敗したら、そのサイクルの pickup を skip し、復旧後の poll で拾う(issue #49 設計点5)", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace(dirs, "tidepool") });

  const db = openDb(join(t.dir, "board.sqlite"));
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );
  db.close();

  t.github.scriptIssueFailure(new Error("GitHub is down"));
  await t.clock.advance(HOUR);

  // 環境事象は人間を呼ばない: pickup されず、failure question も生まれない
  expect(t.worker.started).toEqual([]);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.id === task.id).status).toBe("todo");
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);

  // 障害が直れば次の poll で普通に拾われる
  t.github.scriptIssueFailure(null);
  t.github.scriptIssue(49, { title: "ログイン画面のバグ", body: "b", comments: [] });
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x: any) => x.id)).toEqual([task.id]);
});

it("issue参照の確定的失敗(not found / close 済み)では retry/abandon の failure question が生まれ、worker は起動しない(issue #49 設計点5)", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace(dirs, "tidepool") });

  const db = openDb(join(t.dir, "board.sqlite"));
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );
  db.close();

  t.github.scriptIssueFailure(new IssueGoneError({ path: "/x", number: 49 }, "closed"));
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board.find((x: any) => x.type === "question");
  expect(question).toBeDefined();
  expect(question.parent_id).toBe(task.id);
  expect(question.question_items[0].options).toEqual(["retry", "abandon"]);
  // トップレベル(親なし)タスクの abandon 説明が「parent を replan に戻す」と
  // 実際には起きないことを約束しない(answerQuestion の cancel 分岐は親なしなら
  // 自タスクの subtree を cancel するだけ)
  expect(question.purpose).not.toContain("returns the parent");
  expect(question.purpose).toContain("cancels this task");
  // 質問(未完了の子)が答えられるまで blocked 表示になり、pickup 対象から外れる
  // (blocked が held に優先する既存の表示規則 — BoardTask の doc comment)
  expect(board.find((x: any) => x.id === task.id).status).toBe("blocked");

  // 次の poll で質問が二重に生まれたりしない
  await t.clock.advance(HOUR);
  const again = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(again.filter((x: any) => x.type === "question").length).toBe(1);
  expect(t.worker.started).toEqual([]);
});
