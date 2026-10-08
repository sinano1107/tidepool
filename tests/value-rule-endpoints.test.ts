import { afterEach, expect, it } from "vitest";
import { whyInvalidClockTime } from "../src/clock-time.js";
import { whyInvalidOffset } from "../src/pace-offset-rule.js";
import { whyNotPositiveInteger } from "../src/positive-integer.js";
import { whyInvalidPrice } from "../src/price.js";
import { whyInvalidProviderRank } from "../src/provider.js";
import { api, bootTidepool, managementMcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it.each([
  ["pacing offset", "/api/settings/provider-pace-offsets", { provider: "openai", window: "primary", offset: 101 }, whyInvalidOffset(101)],
  ["memory injection cap", "/api/settings/memory", { injection_token_cap: 0 }, whyNotPositiveInteger(0)],
  ["meta-review period", "/api/settings/meta-review", { period_days: 0 }, whyNotPositiveInteger(0)],
  ["memory fold successor", "/api/settings/memory/fold", { replaces: [1], successor_id: 0 }, whyNotPositiveInteger(0)],
  ["issue registration", "/api/tasks", { type: "work", workspace: "tidepool", github_issue_number: 0 }, whyNotPositiveInteger(0)],
  ["issue comment approval", "/api/issue-comments", { workspace: "tidepool", github_issue_number: 0, body: "approved" }, whyNotPositiveInteger(0)],
  ["execution price", "/api/settings/execution", {
    setting: "row", row: { provider: "openai", tier: "standard", model: "example", effort: "high", price_in: -1, price_out: 0 },
  }, whyInvalidPrice(-1)],
  ["provider rank", "/api/settings/execution", { setting: "provider_rank", value: ["openai", "openai", "anthropic"] }, whyInvalidProviderRank(["openai", "openai", "anthropic"])],
  ["quiet hours", "/api/settings/quiet-hours", { start: "7:00", end: "23:59" }, whyInvalidClockTime("7:00")],
] as const)("%s refusal carries the leaf reason", async (_name, path, body, reason) => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", path, body);
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json.error)).toContain(reason);
});

it.each(["register_task", "add_issue_comment"])("management MCP %s refuses an issue number with the leaf reason", async (name) => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result = await client.callTool({ name, arguments: name === "register_task"
      ? { type: "work", workspace: "tidepool", github_issue_number: 0 }
      : { workspace: "tidepool", github_issue_number: 0, body: "approved" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(whyNotPositiveInteger(0));
  } finally {
    await client.close();
  }
});
