import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { registerTask } from "../src/tasks.js";
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

it("issue参照タスクの complete_task 成立後、PR の title は GitHub の issue タイトルを解決したものになる(issue #49, ADR 0016: PR titleでのlive展開)", async () => {
  const { workspace: ws } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace: ws });

  const db = t.db;
  const task = registerTask(
    db,
    { type: "work", workspace: ws.name, github_issue_number: 49 },
    t.clock.now(),
  );

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
  expect(t.github.requests[0]?.title).toBe("ログイン画面のバグ");
});
