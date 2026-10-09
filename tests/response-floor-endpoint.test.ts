import { afterEach, expect, it } from "vitest";
import { toolResult } from "../src/mcp.js";
import { floorResponse, listFloorRows } from "../src/response-budget.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

// 床の記録の行は Settings > Board の読み口に出る(ADR 0219 決定1、issue #1386)
it("床の行の読み口は集計をそのまま返す", async () => {
  t = await bootTidepool();
  const big = toolResult({ line: "x".repeat(50_000) });
  floorResponse(big, { db: t.db, surface: "worker", verb: "get_task", taskId: "t1", at: t.clock.now() });
  floorResponse(big, { db: t.db, surface: "management", verb: "list_tasks", at: t.clock.now() });

  const response = await api(t.baseUrl, "GET", "/api/settings/response-floors");

  expect(response.json).toEqual({ floors: listFloorRows(t.db) });
  expect(response.json.floors).toHaveLength(2);
});
