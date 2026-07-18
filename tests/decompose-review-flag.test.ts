import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, FULL_HANDOFF, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** Complete the slot task via MCP with a full work handoff. */
async function completeVia(t: Tidepool, taskId: string) {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  await client.callTool({
    name: "complete_task",
    arguments: { handoff: FULL_HANDOFF },
  });
  await client.close();
}

it("decompose の子に review_flag: true を宣言すると、そのまま work タスクとして登録され承認 question に変換されない(ADR 0021, 検査ゼロ)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "child work benefits from an independent review",
      children: [
        {
          title: "wire the moisture sensor",
          purpose: "get readings flowing",
          completion_criteria: "dashboard shows a live number",
          review_flag: true,
        },
      ],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;

  // registered directly as a work task, not converted into an approval question
  const child = board.find((x: any) => x.title === "wire the moisture sensor");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(child.review_flag).toBe(1);
  expect(board.find((x: any) => x.type === "question" && x.parent_id === parent.id)).toBeUndefined();
});

it("decompose で review_flag: true 登録された子の完了時に、既存の layer 1 機構が review 子タスクを自動生成する", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "child work benefits from an independent review",
      children: [
        {
          title: "wire the moisture sensor",
          purpose: "get readings flowing",
          completion_criteria: "dashboard shows a live number",
          review_flag: true,
          assignee: "reef-crab",
        },
      ],
    },
  });
  await client.close();

  const child = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.title === "wire the moisture sensor",
  );
  await t.clock.advance(HOUR); // child picked up into the slot
  await completeVia(t, child.id);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const review = board.find((x: any) => x.type === "review" && x.parent_id === child.id);
  expect(review).toBeDefined();
});

it("risk_flag の親超えで承認 question に変換された review_flag: true の子は、承認による具現化でも flag を保持する", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "one child touches production data and needs sign-off, and should be reviewed",
      children: [
        {
          title: "migrate the prod table",
          purpose: "backfill the new column",
          completion_criteria: "backfill script has run against prod",
          risk_flag: true,
          review_flag: true,
        },
      ],
    },
  });
  await client.close();

  const board1 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // converted to an approval question, not registered directly (risk beyond parent)
  expect(board1.find((x: any) => x.title === "migrate the prod table")).toBeUndefined();
  const question = board1.find((x: any) => x.type === "question" && x.parent_id === parent.id);
  expect(question).toBeDefined();

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["approve"] });

  const board2 = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board2.find((x: any) => x.title === "migrate the prod table");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(child.review_flag).toBe(1);
});
