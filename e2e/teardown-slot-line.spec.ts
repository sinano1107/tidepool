import type { Locator, Page } from "@playwright/test";
import { markTeardown } from "../src/teardown.js";
import { completeViaMcp, HOUR, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

/** issue #561 / ADR 0113。後始末中の session の行は「走っている」ではない ——
 *  上限到達による中断では行が `in_progress` のまま残る(決定2)ので、slot 行が
 *  それをタスクの実行と取り違えていた。経路はサーバが `teardown.settlement` で
 *  導き、ブラウザは値 → コピーの写像だけを持つ(決定3 / ADR 0068 決定7)。 */

/** 実行枠の状態(busy/limit/free)がブラウザに現れるのはここだけ ——
 *  `ui_kits/tidepool-webui/queue-screen.jsx` は `free` のときだけ slot 行を減光する。 */
const color = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).color);

/** design token の実効値。色そのものをテストに焼き込むと theme の調整で落ちる。 */
const token = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);

test("上限到達による中断の後始末は、走っているタイトルではなく queue 復帰を告げる後始末行になる", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const task = await registerWork(t, "interrupted by cap");
  await t.clock.advance(HOUR); // pickup — 行は in_progress
  // adapter が 429 exit を観測した瞬間の durable な状態(行は in_progress のまま)
  markTeardown(t.db, task.id, t.clock.now());

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  const line = page.getByText("session teardown · nothing new starts");
  await expect(line).toBeVisible();
  const meta = page.getByText("usage limit hit · task returns to the queue once processes exit");
  await expect(meta).toBeVisible();
  // タイトルは「走っている色」どころかどこにも出ない —— in_progress の行は queue にも居ない
  await expect(page.getByText("interrupted by cap")).toHaveCount(0);
  expect(await color(line)).toBe(await token(page, "--text-muted"));
});

test("完了経路の後始末は現行どおり後始末行を出す", async ({ boot, page }) => {
  const t = await boot();
  const task = await registerWork(t, "finished work");
  await t.clock.advance(HOUR);
  t.containers.hold(task.id); // 最終 verb は着地したのに process が残っている
  await completeViaMcp(t, task.id);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("session teardown · nothing new starts")).toBeVisible();
  await expect(page.getByText("waiting for this session's processes to exit")).toBeVisible();
});

test("後始末が無ければ実行中の行は従来どおりタイトルを走っている色で出す", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await registerWork(t, "already running");
  await t.clock.advance(HOUR);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("already running")).toBeVisible();
  expect(await color(page.getByText("slot", { exact: true }))).toBe(await token(page, "--tide-4"));
  expect(await color(page.getByText("already running"))).toBe(await token(page, "--text-body"));
});
