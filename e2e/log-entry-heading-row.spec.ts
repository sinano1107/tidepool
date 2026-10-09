import type { Locator } from "@playwright/test";
import { api, completeViaMcp, HOUR, loggedEntry, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// issue #1683: 時刻・chip・taskId は本文の上の見出し行にまとまり、本文と注記の帯は
// 行の内容幅いっぱいに置かれる。taskId は IdChip(9ch + ellipsis、全文は title)で出る。
// 幅は CSS の効き目なので vitest では測れず、e2e の層で言う(#1103 / #1113 と同じ)。

const width = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().width);
// 行の内容幅 = clientWidth(border を含まない)から左右の padding を引いたもの
const contentWidth = (row: Locator) =>
  row.evaluate((el) => {
    const s = getComputedStyle(el);
    return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  });

test("スマホ幅で本文と帯が行の内容幅いっぱいに置かれ、taskId は 9ch に切られ全文を title に持つ(issue #1683)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await page.setViewportSize({ width: 390, height: 844 });
  const work = await registerWork(t, "見出し行の e2e");
  await t.clock.advance(HOUR);
  const decided = await loggedEntry(t, work.id, "見出し行の下の本文");
  await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: decided.id, comment: "帯の中のコメント" });

  await page.goto(t.baseUrl);
  const row = page.locator(".tp-log-entry").filter({ hasText: "見出し行の下の本文" });
  const body = row.getByText("見出し行の下の本文");
  const band = row.getByText("objection: 帯の中のコメント").locator("..");
  await expect(body).toBeVisible();

  const id = row.getByTitle(work.id);
  await expect(id).toHaveText(work.id);
  const [idWidth, nineCh] = await id.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.cssText = `display:inline-block;width:9ch;font:${getComputedStyle(el).font}`;
    el.parentElement?.append(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return [el.getBoundingClientRect().width, w];
  });
  expect(idWidth).toBeLessThanOrEqual(nineCh + 0.5);

  const content = await contentWidth(row);
  expect(await width(body)).toBeCloseTo(content, 0);
  expect(await width(band)).toBeCloseTo(content, 0);
});

test("スマホ幅で完了行の本文はシェブロンの列ぶんだけ狭い(issue #1683)", async ({ boot, page }) => {
  const t = await boot();
  await page.setViewportSize({ width: 390, height: 844 });
  const task = await registerWork(t, "完了行の見出し e2e");
  await t.clock.advance(HOUR);
  await completeViaMcp(t, task.id);

  await page.goto(t.baseUrl);
  // landing 先の無い完了は PR 昇格失敗の question を出すので、ログまで進む
  await page.getByRole("button", { name: /Log skim/ }).click();

  const expand = page.getByRole("button", { name: "Expand handoff" });
  const row = page.locator(".tp-log-entry").filter({ has: expand });
  const body = row.getByText("done —").locator("..");
  await expect(body).toBeVisible();

  const gap = await row.evaluate((el) => parseFloat(getComputedStyle(el).columnGap));
  expect(await width(body)).toBeCloseTo((await contentWidth(row)) - (await width(expand)) - gap, 0);
});
