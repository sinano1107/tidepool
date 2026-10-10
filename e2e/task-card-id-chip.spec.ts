import type { Locator, Page } from "@playwright/test";
import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// issue #1742: Board の TaskCard の id は IdChip(9ch + ellipsis、全文は title)で出る。
// 実 UUID を全文で出すと見出し行が折れて title の上が重くなるため。
// 字形・折れ・タップ先は描画の効き目なので vitest では測れず、e2e の層で言う(#1695 と同じ)。

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

// human 宛ては pickup の契機にならず todo のまま Board に残る
const registerHumanTodo = async (t: { baseUrl: string }, title: string, risk: boolean) => {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
    assignee: "human",
    ...(risk && { risk_flag: true }),
  });
  expect(res.status).toBeLessThan(300);
  return res.json;
};

test("card の id は IdChip で、title が全文 id・9ch に切られ・字形は IdChip の既定、見出し行は RiskFlag 付きでも折れない(issue #1742)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await page.setViewportSize({ width: 390, height: 844 });
  const plain = await registerHumanTodo(t, "risk なしの card", false);
  const risky = await registerHumanTodo(t, "risk ありの card", true);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Board" }).click();
  const want = await expected(page);
  for (const task of [plain, risky]) {
    const id = page.getByTitle(task.id).first();
    await expect(id).toBeVisible();
    expect(await id.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await typography(id)).toEqual(want);

    // 見出し行 = id の親。子の最大の高さを超えて伸びていれば折れている
    const [rowHeight, tallestChild] = await id.evaluate((el) => {
      const row = el.parentElement as HTMLElement;
      return [row.getBoundingClientRect().height, Math.max(...[...row.children].map((c) => c.getBoundingClientRect().height))];
    });
    expect(rowHeight).toBeLessThanOrEqual(tallestChild + 0.5);
  }
});

test("todo の card をタップすると TaskActionsDialog に全文 id が出る(issue #1742)", async ({ boot, page }) => {
  const t = await boot();
  const task = await registerHumanTodo(t, "タップして全文を読む card", false);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Board" }).click();
  await page.getByText("タップして全文を読む card").click();
  await expect(page.getByText(`${task.id} · work`)).toBeVisible();
});
