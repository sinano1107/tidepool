import { afterEach, expect, it } from "vitest";
import { registerTask } from "../src/tasks.js";
import { bootTidepool, HOUR, HUMAN_WEBUI, mcpClient, RESPONSE_BUDGET_BYTES, readFollowingNext, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("get_current_task はissue参照タスクの場合、GitHubのissueから解決した内容を返す(issue #49, ADR 0016: spawn時のlive展開)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });

  const task = registerTask(
    t.db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );

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
    expect(payload.purpose).toBe("再現手順: ...\n\n## Issue comments\n\n追加情報です");
    expect(payload.completion_criteria).toBe("See the issue content above for completion criteria.");
  } finally {
    await client.close();
  }
});

it("issue の本文で purpose が予算を超えると、get_current_task は task の欄を history より先に partial の切れで返し、next を追うと purpose が逐語で戻り、その後に history が届く(ADR 0195 追記 #1393)", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });
  const task = registerTask(t.db, { type: "work", workspace: "tidepool", github_issue_number: 1393 }, t.clock.now(), ...HUMAN_WEBUI);
  const body = '潮だまり"\n'.repeat(3_500); // 45,500 バイト
  t.github.scriptIssue(1393, { title: "長い issue", body, comments: ["追加情報です"] });
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const lines = ["first decision", "second decision"];
    for (const line of lines) await client.callTool({ name: "log_decision", arguments: { line } });
    const responses = await readFollowingNext(client, "get_current_task");

    for (const response of responses) expect(response.bytes).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
    const purpose = `${body}\n\n## Issue comments\n\n追加情報です`;
    const pieces = responses.filter((response) => response.payload.partial);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.payload.partial).toEqual({ field: "purpose", field_bytes: Buffer.byteLength(purpose) });
      expect(piece.payload).toMatchObject({ id: task.id, title: "長い issue", history: [] });
    }
    expect(pieces.map((piece) => piece.payload.purpose).join("")).toBe(purpose);
    expect(responses.flatMap((response) => response.payload.history.map((entry: any) => entry.decision))).toEqual(lines);
  } finally {
    await client.close();
  }
});
