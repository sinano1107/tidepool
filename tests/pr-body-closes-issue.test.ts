import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getTask, registerTask } from "../src/tasks.js";
import {
  bootTidepool,
  commitWork,
  HOUR,
  makeRemoteBackedWorkspace,
  mcpClient,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const fullHandoff = {
  outcome: "done as specified",
  deliverables: "notes.txt on the task branch",
  decision_refs: "none",
  dead_ends: "none",
  resume_context: "none needed",
  known_issues: "none",
};

/** 2つのテストが共有する「issue参照タスクを complete_task で完了させる」下ごしらえ
 *  (issue #303 の /ponytail-review 指摘: セットアップの重複を1箇所に)。 */
async function completeIssueBackedTask(dirs: string[], handoff: Record<string, string> = fullHandoff) {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  const t = await bootTidepool({ workspace: ws });

  const db = openDb(join(t.dir, "board.sqlite"));
  const task = registerTask(
    db,
    { type: "work", workspace: ws.name, github_issue_number: 49 },
    t.clock.now(),
  );
  db.close();

  t.github.scriptIssue(49, {
    title: "ログイン画面のバグ",
    body: "再現手順: ...",
    comments: [],
  });

  await t.clock.advance(HOUR);
  commitWork(ws.path, "issue-fix.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const { tools } = await client.listTools();
  const res: any = await client.callTool({ name: "complete_task", arguments: { handoff } });
  await client.close();

  return { t, task, res, tools };
}

it("issue参照タスクの complete_task 成立後、PR body の末尾に空行区切りで `Closes #N` が付与される(issue #49, ADR 0016 設計点7)", async () => {
  const { t: booted, res } = await completeIssueBackedTask(dirs);
  t = booted;
  expect(res.isError ?? false).toBe(false);

  expect(t.github.requests).toHaveLength(1);
  const body = t.github.requests[0]?.body ?? "";
  expect(body.endsWith("\n\nCloses #49")).toBe(true);
  expect(body).toContain("notes.txt on the task branch");
});

it("PR body は handoff の直後・`Closes #N` の直前に盤面の定型フッタを挟み、フッタは PR 番号を含まない。complete_task の description にも同じ指針が乗る(issue #303)", async () => {
  // known_issues(HANDOFF_FIELDS の最後のフィールド)を他と被らない値にして、
  // 「handoff 全体の直後」を正確に指す marker にする — 途中のフィールド
  // (deliverables 等)を marker にすると、その後続フィールドまで
  // フッタとして誤判定してしまう(/ponytail-review 指摘)。
  const footerHandoff = { ...fullHandoff, known_issues: "flaky login redirect on slow network" };
  const { t: booted, task, res, tools } = await completeIssueBackedTask(dirs, footerHandoff);
  t = booted;
  expect(res.isError ?? false).toBe(false);

  const completeTaskTool = tools.find((tool) => tool.name === "complete_task")!;
  expect(completeTaskTool.description).toMatch(/resume_context/);
  expect(completeTaskTool.description).toMatch(/push/i);
  expect(completeTaskTool.description).toMatch(/(merge|land)/i);

  const body = t.github.requests[0]?.body ?? "";
  const marker = footerHandoff.known_issues;
  const handoffEnd = body.indexOf(marker) + marker.length;
  const closesStart = body.indexOf("Closes #49");
  const footer = body.slice(handoffEnd, closesStart);
  expect(footer).toMatch(/board/i);
  expect(footer).not.toMatch(/#\d/);

  const dbAfter = openDb(join(t.dir, "board.sqlite"));
  const stored = getTask(dbAfter, task.id);
  dbAfter.close();
  expect(stored?.handoff_doc).not.toContain("opened by the tidepool board");
});

it("通常タスク(github_issue_number なし)の complete_task 成立後、PR body に Closes 行は付与されない", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });

  const db = openDb(join(t.dir, "board.sqlite"));
  const task = registerTask(
    db,
    {
      type: "work",
      workspace: ws.name,
      title: "notes.txt を整える",
      purpose: "整理",
      completion_criteria: "notes.txt が整っていること",
    },
    t.clock.now(),
  );
  db.close();

  await t.clock.advance(HOUR);
  commitWork(ws.path, "notes.txt", "finished\n");

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  expect(t.github.requests).toHaveLength(1);
  expect(t.github.requests[0]?.body).not.toContain("Closes");
});
