import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getEvent } from "../src/events.js";
import { changeMetaReviewSettings, readMetaReviewSettings } from "../src/meta-review.js";
import { api, bootTidepool, managementMcpClient, type Tidepool } from "./harness.js";

const at = new Date("2026-09-23T00:00:00.000Z");

let t: Tidepool;
afterEach(() => t?.stop());

it("周期は未設定なら 7 日で、変更は読み口に効き、人間名義・task 無しの meta_review_settings_changed を残す(issue #924)", () => {
  const db = openDb(":memory:");
  expect(readMetaReviewSettings(db)).toEqual({ period_days: 7 });

  const eventId = changeMetaReviewSettings(db, { period_days: 3 }, "mcp", at);

  expect(readMetaReviewSettings(db)).toEqual({ period_days: 3 });
  expect(getEvent(db, eventId)).toMatchObject({ task_id: null, worker_id: "human", origin: "mcp" });
  expect(getEvent(db, eventId)?.payload).toEqual({ kind: "meta_review_settings_changed", period_days: 3 });
});

it("POST /api/settings/meta-review で書いた周期は GET で読め、正の整数でない値と空の変更は 400(issue #924)", async () => {
  t = await bootTidepool();
  for (const bad of [0, 1.5, "900"]) {
    expect((await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: bad })).status).toBe(400);
  }
  expect((await api(t.baseUrl, "POST", "/api/settings/meta-review", {})).status).toBe(400);
  expect(await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: 3 })).toMatchObject({ status: 200, json: { period_days: 3 } });
  expect((await api(t.baseUrl, "GET", "/api/settings/meta-review")).json).toEqual({ period_days: 3 });
});

it("管理MCP の change_meta_review_settings で書いた周期は read_meta_review_settings で読め、不正値と空の変更は拒む(issue #924)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const changed = (await client.callTool({ name: "change_meta_review_settings", arguments: { period_days: 14 } })) as any;
    expect(JSON.parse(changed.content[0].text)).toEqual({ period_days: 14 });
    for (const bad of [{ period_days: 0 }, { period_days: 1.5 }, {}]) {
      expect(((await client.callTool({ name: "change_meta_review_settings", arguments: bad })) as any).isError).toBe(true);
    }
    const read = (await client.callTool({ name: "read_meta_review_settings", arguments: {} })) as any;
    expect(JSON.parse(read.content[0].text)).toEqual({ period_days: 14 });
  } finally {
    await client.close();
  }
});
