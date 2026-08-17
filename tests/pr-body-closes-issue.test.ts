import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { prBody } from "../src/mcp.js";
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

it("issue参照タスクの complete_task 成立後、PR body の末尾に空行区切りで `Closes #N` が付与される(issue #49, ADR 0016 設計点7)", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });

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
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  expect(t.github.requests).toHaveLength(1);
  const body = t.github.requests[0]?.body ?? "";
  expect(body.endsWith("\n\nCloses #49")).toBe(true);
  expect(body).toContain("notes.txt on the task branch");
});

it("PR body は handoff の直後・`Closes #N` の直前に盤面の定型フッタを挟み、フッタは PR 番号を含まない(issue #303)", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });

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
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const body = t.github.requests[0]?.body ?? "";
  const handoffEnd = body.indexOf("notes.txt on the task branch") + "notes.txt on the task branch".length;
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

it("prBody: handoff doc が無くても盤面の定型フッタは出る(issue #303)", () => {
  expect(prBody(null, null)).toMatch(/board/i);
  expect(prBody(null, 49)).toBe(`${prBody(null, null)}\n\nCloses #49`);
});
