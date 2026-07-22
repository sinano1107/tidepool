import { afterEach, expect, it } from "vitest";
import type { AuthorityProfile } from "../src/registry.js";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const NAVIGATOR_AUTHORITY: AuthorityProfile = {
  name: "navigator-authority",
  guidance: "chart the course",
  assignable_to: ["navigator"],
  allowed_workspaces: ["*"],
};

it("list_agents は registry 全体を返し、assignable_to の内外を direct/needs_approval でマークする(issue #43 / ADR 0014)", async () => {
  t = await bootTidepool({
    listAgents: () => [
      { name: "navigator", description: "Navigation specialist" },
      { name: "keeper", description: "Independent reviewer" },
    ],
    resolveAuthority: () => NAVIGATOR_AUTHORITY,
  });
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "chart a course",
      purpose: "get to port",
      completion_criteria: "docked",
    })
  ).json;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result: any = await client.callTool({ name: "list_agents", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.agents).toEqual(
      expect.arrayContaining([
        { name: "navigator", description: "Navigation specialist", status: "direct" },
        { name: "keeper", description: "Independent reviewer", status: "needs_approval" },
      ]),
    );
  } finally {
    await client.close();
  }
});

it("list_agents は registry に定義の無い human も、direct/needs_approval 込みで roster に載せる(CONTEXT.md の Roster)", async () => {
  t = await bootTidepool({
    listAgents: () => [],
    resolveAuthority: () => ({
      name: "human-only",
      guidance: "ask a human",
      assignable_to: ["human"],
      allowed_workspaces: ["*"],
    }),
  });
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "chart a course",
      purpose: "get to port",
      completion_criteria: "docked",
    })
  ).json;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result: any = await client.callTool({ name: "list_agents", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.agents).toContainEqual({
      name: "human",
      description:
        "delegate to a human — runs outside the slot in their own task list; " +
        "human attention is scarce, delegate only what genuinely needs a human",
      status: "direct",
    });
  } finally {
    await client.close();
  }
});

it("list_agents は review タスクでは、reviewer の assignable_to が空でも、レビュー対象の実行者を direct とマークする(ADR 0013 の decompose 例外と乖離しない — issue #43 / ADR 0014)", async () => {
  t = await bootTidepool({ listAgents: () => [{ name: "navigator", description: "Navigation specialist" }] });
  const reviewed = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "wire the sensor",
      purpose: "purpose",
      completion_criteria: "criteria",
      assignee: "navigator",
    })
  ).json;
  const review = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "RCA for the sensor task",
      purpose: "purpose",
      completion_criteria: "criteria",
      parent_id: reviewed.id,
      assignee: "auditor",
    })
  ).json;
  await t.clock.advance(HOUR); // review picked up

  const client = await mcpClient(t.mcpBaseUrl, review.id);
  try {
    const result: any = await client.callTool({ name: "list_agents", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    // reviewer profile の assignable_to は常に空(ADR 0013)だが、レビュー対象
    // 自身の実行者への割当は decompose 側で無条件に通る例外(ADR 0013)。
    // list_agents のマークがこの例外を欠くと、実際には direct な割当を
    // needs_approval と誤って報告してしまう。
    expect(payload.agents).toContainEqual({
      name: "navigator",
      description: "Navigation specialist",
      status: "direct",
    });
  } finally {
    await client.close();
  }
});

it("decompose の assignee フィールドの説明文が roster(system prompt)と list_agents への導線になっている(issue #43 / ADR 0014)", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "chart a course",
      purpose: "get to port",
      completion_criteria: "docked",
    })
  ).json;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const { tools } = await client.listTools();
    const decompose = tools.find((tool) => tool.name === "decompose")!;
    const assigneeSchema = (decompose.inputSchema as any).properties.children.items.properties
      .assignee;
    expect(assigneeSchema.description).toMatch(/Roster/);
    expect(assigneeSchema.description).toMatch(/list_agents/);
  } finally {
    await client.close();
  }
});
