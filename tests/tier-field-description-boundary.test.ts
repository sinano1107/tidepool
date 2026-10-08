import { afterEach, expect, it } from "vitest";
import {
  JUDGED_AFTER_THE_EDIT,
  ONLY_WHERE_COMPLETION_REVIEW_FIRES,
  REVIEW_FLAG_ONLY_ON_WORK_CHILDREN,
  REVIEW_TIER_BY_TYPE,
} from "../src/mcp.js";
import { SEED_TIERS } from "../src/tier.js";
import { api, bootTidepool, managementMcpClient, mcpClient, type Tidepool } from "./harness.js";

/** 要求の段を受け取る入口の説明(ADR 0200 決定3)のサーバー境界: 文面の書き手が tools/list で読む説明に、盤面の段が
 *  「名前 — 説明」で順序どおりに並ぶ。 */
let t: Tidepool;
afterEach(() => t?.stop());

const boardTiers = SEED_TIERS.map(({ name, description }) => `${name} — ${description}`).join("\n");

type ToolSchema = { properties: Record<string, { description?: string; items?: ToolSchema }> };
const describedTiers = (schema: ToolSchema) => [schema.properties.tier!.description, schema.properties.review_tier!.description];

it("decompose と register_task の tier / review_tier の説明は、盤面の段を「名前 — 説明」で順序どおりに並べる", async () => {
  t = await bootTidepool();
  const task = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", title: "t", purpose: "p", completion_criteria: "c" })).json;
  const worker = await mcpClient(t.mcpBaseUrl, task.id);
  const management = await managementMcpClient(t.baseUrl);
  try {
    const decompose = (await worker.listTools()).tools.find((tool) => tool.name === "decompose")!;
    const registerTask = (await management.listTools()).tools.find((tool) => tool.name === "register_task")!;

    for (const description of [
      ...describedTiers((decompose.inputSchema as ToolSchema).properties.children!.items!),
      ...describedTiers(registerTask.inputSchema as ToolSchema),
    ]) {
      expect(description).toContain(boardTiers);
    }
  } finally {
    await worker.close();
    await management.close();
  }
});

it("register_task と edit_task の review の欄は、受け付ける条件を説明に持ち、review_tier は type ごとの意味を分けて書く", async () => {
  t = await bootTidepool();
  const management = await managementMcpClient(t.baseUrl);
  try {
    const { tools } = await management.listTools();
    const fields = (name: string) => (tools.find((tool) => tool.name === name)!.inputSchema as ToolSchema).properties;
    const register = fields("register_task");
    const edit = fields("edit_task");

    expect(register.review_flag!.description).toContain(REVIEW_FLAG_ONLY_ON_WORK_CHILDREN);
    expect(register.review_by!.description).toContain(ONLY_WHERE_COMPLETION_REVIEW_FIRES);
    // review task を登録する読み手にも当てはまる書き出しで始める(完了時レビュー専用の書き出しにしない)
    expect(register.review_tier!.description!.startsWith(REVIEW_TIER_BY_TYPE)).toBe(true);
    expect(register.review_tier!.description).toContain(boardTiers);
    for (const field of [edit.review_flag!, edit.review_by!]) expect(field.description).toContain(JUDGED_AFTER_THE_EDIT);
    expect(edit.review_flag!.description).toContain(REVIEW_FLAG_ONLY_ON_WORK_CHILDREN);
    expect(edit.review_by!.description).toContain(ONLY_WHERE_COMPLETION_REVIEW_FIRES);
  } finally {
    await management.close();
  }
});
