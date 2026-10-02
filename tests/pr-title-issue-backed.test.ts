import { afterEach, expect, it, vi } from "vitest";
import { registerTask } from "../src/tasks.js";
import {
  bootTidepool,
  commitWork,
  completeIntegrationReviews,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  HUMAN_WEBUI,
  makeRemoteBackedWorkspace,
  mcpClient,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
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
  const { workspace: ws } = await makeRemoteBackedWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws });

  const db = t.db;
  const task = registerTask(
    db,
    { type: "work", workspace: ws.name, github_issue_number: 49 },
    t.clock.now(),
    ...HUMAN_WEBUI,
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
  await completeIntegrationReviews(t, task.id);

  expect(t.github.requests).toHaveLength(1);
  expect(t.github.requests[0]?.title).toBe("ログイン画面のバグ");
});
