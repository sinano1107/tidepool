import { afterEach, expect, it } from "vitest";
import { BOARD_WRITE_LANGUAGE_RULE } from "../src/mcp.js";
import { api, bootTidepool, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("盤面に書く4 verb の description だけが英語ルールを運び、読取 verb には載らない(ADR 0015 2026-08-21 追補 / issue #415)", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "index the tide charts",
      purpose: "make historical tides searchable",
      completion_criteria: "a query for 2025-06 returns chart rows",
    })
  ).json;

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? ""]));

    for (const verb of ["log_decision", "complete_task", "decompose", "escalate"]) {
      expect(byName.get(verb)).toContain(BOARD_WRITE_LANGUAGE_RULE);
    }
    for (const verb of ["get_current_task", "list_agents"]) {
      expect(byName.get(verb)).not.toContain(BOARD_WRITE_LANGUAGE_RULE);
    }
  } finally {
    await client.close();
  }
});
