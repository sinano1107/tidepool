import { openDb } from "../src/db.js";
import { getTask, logDecision } from "../src/tasks.js";
import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// issue #271(ADR 0063 決定1)の恒久スモーク — translateTarget の門(同時2本)
// が壊れると Pi の OOM リスクに直結するクリティカルパスなので昇格した(ADR
// 0055)。流し読みは上限 20 件ごとの log_entries で送る(ADR 0296 決定4)ので、
// 45行は 3 chunk になる。実 haiku 呼び出しは伴わせず、/api/translate 自体を
// page.route で横取りして同時着弾数を数える。

const translateSwitch = (page: import("@playwright/test").Page) =>
  page.locator('span[role="switch"]').first();

test("流し読みで 45件が未読なら /api/translate は 3 chunk で飛び、同時に2本を超えない(完了基準1)", async ({ boot, page }) => {
  const t = await boot();

  const registered = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "sensor task",
    purpose: "p",
    completion_criteria: "c",
  });
  const db = openDb(`${t.dir}/board.sqlite`);
  const task = getTask(db, registered.json.id)!;
  for (let i = 0; i < 45; i++) {
    logDecision(db, task, `decision line ${i}`, "tako", t.clock.now(), "worker");
  }
  db.close();

  let inFlight = 0;
  let maxInFlight = 0;
  const chunkSizes: number[] = [];
  await page.route("**/api/translate", async (route) => {
    const { event_ids } = route.request().postDataJSON() as { event_ids: number[] };
    inFlight += 1;
    chunkSizes.push(event_ids.length);
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 300));
    inFlight -= 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "translated", entries: event_ids.map((id) => ({ event_id: id, text: `[JA] stub ${id}` })) }),
    });
  });

  await page.goto(t.baseUrl);
  await expect(page.getByText("decision line 0", { exact: true })).toBeVisible();

  await translateSwitch(page).click();

  await expect.poll(() => chunkSizes.length, { timeout: 15_000 }).toBe(3);
  expect(chunkSizes).toEqual([20, 20, 5]);
  expect(maxInFlight).toBeLessThanOrEqual(2);
});
