import { openDb } from "../src/db.js";
import { getTask, logDecision } from "../src/tasks.js";
import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// issue #271(ADR 0063 決定4)の恒久スモーク — off→on し直したとき、未送信分は
// キャンセルされ、送信済みは走らせきる。キャンセルした分を
// logTranslateRequested から消し忘れると行が loading の「…」のまま永久に
// 固まる、というのがこの issue が名指した受け入れテストそのものなので昇格した
// (ADR 0055)。

const translateSwitch = (page: import("@playwright/test").Page) =>
  page.locator('span[role="switch"]').first();

test("off→on: 未送信分はキャンセルされネットワークに飛ばず、on し直すと再要求されて全行埋まる(完了基準3)", async ({ boot, page }) => {
  const t = await boot();

  const registered = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "sensor task",
    purpose: "p",
    completion_criteria: "c",
  });
  const db = openDb(`${t.dir}/board.sqlite`);
  const task = getTask(db, registered.json.id)!;
  for (let i = 0; i < 4; i++) {
    logDecision(db, task, `decision line ${i}`, "tako", t.clock.now());
  }
  db.close();

  let sent = 0;
  await page.route("**/api/translate", async (route) => {
    sent += 1;
    const n = sent;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "translated", text: `[JA] stub ${n}` }),
    });
  });

  await page.goto(t.baseUrl);
  await expect(page.getByText("decision line 0")).toBeVisible();

  await translateSwitch(page).click(); // on — 4件要求、門は2本なので2本だけ即着弾
  await expect.poll(() => sent, { timeout: 5_000 }).toBe(2);

  await translateSwitch(page).click(); // off — 未送信の残り2件はここでキャンセルされるべき

  // 最初の2本が完了して門が空いても(1000ms待ち)、キャンセル済みの2本が
  // 遅れて送信されてはいけない
  await page.waitForTimeout(1_500);
  expect(sent).toBe(2);

  await translateSwitch(page).click(); // on し直し — キャンセルされた分が再要求される
  await expect.poll(() => sent, { timeout: 5_000 }).toBe(4);

  // 受け入れテスト本体: 4行すべてに最終的に訳文がつく(loading の「…」で
  // 永久に固まらない)
  for (let i = 0; i < 4; i++) {
    await expect(page.getByText(`decision line ${i}`)).toBeVisible();
  }
  await expect.poll(async () => {
    const texts = await page.locator("text=/\\[JA\\] stub/").allTextContents();
    return texts.length;
  }, { timeout: 10_000 }).toBe(4);
});
