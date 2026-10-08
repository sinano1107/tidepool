import { afterEach, expect, it } from "vitest";
import { whyInvalidOffset } from "../src/pace-offset-rule.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("pacing offset refusal carries the leaf reason", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/provider-pace-offsets", { provider: "openai", window: "primary", offset: 101 });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json.error)).toContain(whyInvalidOffset(101));
});

import { whyNotPositiveInteger } from "../src/positive-integer.js";

it("memory injection cap refusal carries the leaf reason", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/memory", { injection_token_cap: 0 });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json.error)).toContain(whyNotPositiveInteger(0));
});

it("meta-review period refusal carries the leaf reason", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: 0 });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json.error)).toContain(whyNotPositiveInteger(0));
});

it("memory fold successor refusal carries the leaf reason", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/memory/fold", { replaces: [1], successor_id: 0 });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json.error)).toContain(whyNotPositiveInteger(0));
});

it("issue registration refusal carries the leaf reason", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/tasks", { type: "work", workspace: "tidepool", github_issue_number: 0 });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json.error)).toContain(whyNotPositiveInteger(0));
});

it("issue comment approval refusal carries the leaf reason", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/issue-comments", { workspace: "tidepool", github_issue_number: 0, body: "approved" });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json.error)).toContain(whyNotPositiveInteger(0));
});

import { whyInvalidPrice } from "../src/price.js";

it("execution price refusal carries the leaf reason", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/execution", {
    setting: "row", row: { provider: "openai", tier: "standard", model: "example", effort: "high", price_in: -1, price_out: 0 },
  });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json.error)).toContain(whyInvalidPrice(-1));
});

import { whyInvalidClockTime } from "../src/clock-time.js";
import { whyInvalidProviderRank } from "../src/provider.js";

it("provider rank refusal carries the leaf reason", async () => {
  t = await bootTidepool();
  const rank = ["openai", "openai", "anthropic"];
  const res = await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "provider_rank", value: rank });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json.error)).toContain(whyInvalidProviderRank(rank));
});

it("quiet hours refusal carries the leaf reason", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/quiet-hours", { start: "7:00", end: "23:59" });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.json.error)).toContain(whyInvalidClockTime("7:00"));
});

import { managementMcpClient } from "./harness.js";

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
