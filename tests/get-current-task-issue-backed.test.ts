import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import { bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("get_current_task はissue参照タスクの場合、GitHubのissueから解決した内容を返す(issue #49, ADR 0016: spawn時のlive展開)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });

  const db = openDb(join(t.dir, "board.sqlite"));
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );
  db.close();

  t.github.scriptIssue(49, {
    title: "ログイン画面のバグ",
    body: "再現手順: ...",
    comments: ["追加情報です"],
  });

  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.title).toBe("ログイン画面のバグ");
    expect(payload.purpose).toBe("再現手順: ...");
    expect(payload.completion_criteria).toBe(
      "See the linked GitHub issue's body and comments for completion criteria.",
    );
  } finally {
    await client.close();
  }
});
