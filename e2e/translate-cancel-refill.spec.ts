import { openDb } from "../src/db.js";
import { getTask, logDecision } from "../src/tasks.js";
import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// issue #271(ADR 0063 決定4)の恒久スモーク — off→on し直したとき、未送信の
// chunk はキャンセルされ、送信済みの chunk は走らせきる。キャンセルした分を
// logTranslateRequested から消し忘れると行が loading の「…」のまま永久に
// 固まる、というのがこの issue が名指した受け入れテストそのものなので昇格した
// (ADR 0055)。流し読みは上限 20 件ごとの log_entries で送る(ADR 0296 決定4)。

const translateSwitch = (page: import("@playwright/test").Page) =>
  page.locator('span[role="switch"]').first();

test("off→on: 未送信の chunk はキャンセルされネットワークに飛ばず、on し直すと再要求されて全行埋まる(完了基準3)", async ({ boot, page }) => {
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

  let sent = 0;
  await page.route("**/api/translate", async (route) => {
    sent += 1;
    const { event_ids } = route.request().postDataJSON() as { event_ids: number[] };
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "translated", entries: event_ids.map((id) => ({ event_id: id, text: `[JA] stub ${id}` })) }),
    });
  });

  await page.goto(t.baseUrl);
  await expect(page.getByText("decision line 0", { exact: true })).toBeVisible();

  await translateSwitch(page).click(); // on — 45件 = 3 chunk、門は2本なので2本だけ即着弾
  await expect.poll(() => sent, { timeout: 5_000 }).toBe(2);

  await translateSwitch(page).click(); // off — 未送信の3本目はここでキャンセルされるべき

  // 最初の2本が完了して門が空いても(1000ms待ち)、キャンセル済みの3本目が
  // 遅れて送信されてはいけない
  await page.waitForTimeout(1_500);
  expect(sent).toBe(2);

  await translateSwitch(page).click(); // on し直し — キャンセルされた chunk が再要求される
  await expect.poll(() => sent, { timeout: 5_000 }).toBe(3);

  // 受け入れテスト本体: 45行すべてに最終的に訳文がつく(loading の「…」で
  // 永久に固まらない)
  await expect.poll(async () => {
    const texts = await page.locator("text=/\\[JA\\] stub/").allTextContents();
    return texts.length;
  }, { timeout: 10_000 }).toBe(45);
});
