import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

// 承認 question と escalate question は、注釈 approval / needs_comment / free_text を一覧(GET /api/tasks)と
// 単体ビュー(GET /api/tasks/:id)の両方に同じ値で載せる(issue #757)。規則そのものは
// tests/question-annotations.test.ts が domain 層で述べる(ADR 0107)— ここは口が写すことだけ。

let t: Tidepool;
afterEach(() => t?.stop());

it("承認 question も escalate question も、一覧と単体ビューが同じ approval / needs_comment / free_text を返す", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const decomposed: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "some children need sign-off",
      children: [{ title: "migrate the prod table", purpose: "p", completion_criteria: "c", risk_flag: true }],
    },
  });
  expect(decomposed.isError ?? false).toBe(false);
  await client.close();
  const other = await registerWork(t, "other");
  await t.clock.advance(HOUR);
  const otherClient = await mcpClient(t.mcpBaseUrl, other.id);
  await otherClient.callTool({
    name: "escalate",
    arguments: { context: "ordinary escalation", questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }] },
  });
  await otherClient.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const approval = board.find((x) => x.question_pending_child?.title === "migrate the prod table");
  const general = board.find((x) => x.type === "question" && x.parent_id === other.id);
  for (const row of [approval, general]) {
    const single = (await api(t.baseUrl, "GET", `/api/tasks/${row.id}`)).json;
    expect({ approval: single.approval, needs_comment: single.needs_comment, free_text: single.free_text }).toEqual({
      approval: row.approval,
      needs_comment: row.needs_comment,
      free_text: row.free_text,
    });
  }
  expect(approval.approval).toEqual({ raises_parent_risk: true });
  expect(general.approval).toBeNull();
});
