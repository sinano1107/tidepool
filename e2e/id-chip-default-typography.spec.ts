import type { Locator, Page } from "@playwright/test";
import { HOUR, queueWork, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// issue #1695: IdChip は切り方に加えて字形(muted mono)と flexShrink: 0 を既定で持つ。
// computed style は CSS の効き目なので vitest では測れず、e2e の層で言う。

const typography = (l: Locator) =>
  l.evaluate((el) => {
    const s = getComputedStyle(el);
    return { fontFamily: s.fontFamily, fontSize: s.fontSize, color: s.color, flexShrink: s.flexShrink };
  });

/** token の実効値 —— 値を焼き込むと theme の調整で落ちる。 */
const expected = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.cssText = "font-family:var(--font-mono);font-size:var(--text-2xs);color:var(--text-muted)";
    document.body.append(probe);
    const s = getComputedStyle(probe);
    const v = { fontFamily: s.fontFamily, fontSize: s.fontSize, color: s.color, flexShrink: "0" };
    probe.remove();
    return v;
  });

test("Queue の id 列と slot 行の IdChip は style なしで muted mono 2xs・flex-shrink 0 になる(issue #1695)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const running = await registerWork(t, "the running one");
  await t.clock.advance(HOUR); // pickup — slot 行に taskId が出る
  const queued = queueWork(t, "a queued one");

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  const want = await expected(page);
  for (const id of [running.id, queued.id]) {
    const chip = page.getByTitle(id).first();
    await expect(chip).toBeVisible();
    expect(await typography(chip)).toEqual(want);
  }
});

test("呼び出し側の style は IdChip の既定に勝つ(issue #1695)", async ({ boot, page }) => {
  const t = await boot();
  await page.goto(t.baseUrl);
  const color = await page.evaluate(() => {
    const w = window as any;
    const host = document.createElement("div");
    document.body.append(host);
    w.ReactDOM.createRoot(host).render(
      w.React.createElement(w.TidepoolDesignSystem_8a0ead.IdChip, { id: "tp-0001", style: { color: "rgb(1, 2, 3)" } }),
    );
    return new Promise<string>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(getComputedStyle(host.firstElementChild as Element).color))),
    );
  });
  expect(color).toBe("rgb(1, 2, 3)");
});
