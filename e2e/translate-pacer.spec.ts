import { openDb } from "../src/db.js";
import { getTask, logDecision } from "../src/tasks.js";
import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// issue #271(ADR 0063 決定1)の恒久スモーク — translateTarget の門(同時2本)
// が壊れると Pi の OOM リスクに直結するクリティカルパスなので昇格した(ADR
// 0055)。実 haiku 呼び出しは伴わせず、/api/translate 自体を page.route で
// 横取りして同時着弾数を数える。

const translateSwitch = (page: import("@playwright/test").Page) =>
  page.locator('span[role="switch"]').first();

test("流し読みで N件が未読でも、同時に飛ぶ /api/translate は2本を超えない(完了基準1)", async ({ boot, page }) => {
  const t = await boot();

  const registered = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "sensor task",
    purpose: "p",
    completion_criteria: "c",
  });
  const db = openDb(`${t.dir}/board.sqlite`);
  const task = getTask(db, registered.json.id)!;
  for (let i = 0; i < 6; i++) {
    logDecision(db, task, `decision line ${i}`, "tako", t.clock.now());
  }
  db.close();

  let inFlight = 0;
  let maxInFlight = 0;
  let totalSeen = 0;
  await page.route("**/api/translate", async (route) => {
    inFlight += 1;
    totalSeen += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 300));
    inFlight -= 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "translated", text: "[JA] stub" }),
    });
  });

  await page.goto(t.baseUrl);
  await expect(page.getByText("decision line 0")).toBeVisible();

  await translateSwitch(page).click();

  await expect.poll(() => totalSeen, { timeout: 15_000 }).toBe(6);
  expect(maxInFlight).toBeLessThanOrEqual(2);
});
