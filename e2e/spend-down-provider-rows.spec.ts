import { reportProviderUsage } from "../src/throttle.js";
import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

const H = 60 * 60 * 1000;

test("provider usage の窓の行で Provider × 窓を arm / cancel できる", async ({ boot, page }) => {
  const t = await boot();
  const now = t.clock.now();
  const w = (window: string, model: string | null, usedPercent: number, durationMs: number) => ({
    window,
    model,
    usedPercent,
    durationMs,
    resetsAt: new Date(now.getTime() + 2 * H),
    throttled: false,
    resumesAt: null,
  });
  reportProviderUsage(t.db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: now,
    windows: [w("session", null, 40, 5 * H), w("week", null, 20, 168 * H), w("fable", "fable", 30, 168 * H)],
  });
  // secondary は Idle —— 行が無いので入口も無い
  reportProviderUsage(t.db, {
    provider: "openai",
    status: "observed",
    plan: "plus",
    cliVersion: null,
    observedAt: now,
    windows: [w("primary", null, 30, 5 * H)],
  });

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  const card = page.locator('[data-testid^="provider-usage-"]');
  // 入口は anthropic session / week と openai primary の3つだけ(fable と Idle の secondary には無い)
  await expect(page.getByTestId("provider-usage-anthropic").getByRole("button")).toHaveCount(2);
  await expect(page.getByTestId("provider-usage-openai").getByRole("button")).toHaveCount(1);
  await expect(page.getByText("spend-down", { exact: false })).toHaveCount(0);
  // 同じ文言のボタンが並ぶので、窓の行(ボタンの兄弟の文字列)から辿る(#854)
  const rowButton = (provider: string, row: RegExp) =>
    page.getByTestId(`provider-usage-${provider}`).getByText(row).locator("..").getByRole("button");

  await rowButton("anthropic", /^session · 40%/).click();
  await expect(card.getByText("session · 40% · spend-down · 100% cap · expires at reset")).toBeVisible();
  await rowButton("openai", /^primary · 30%/).click();
  await expect(card.getByText("primary · 30% · spend-down · 100% cap · expires at reset")).toBeVisible();

  await expect(rowButton("anthropic", /^week · 20%/)).toHaveText("spend down");
  await rowButton("anthropic", /^session · 40%/).click();
  await expect(card.getByText("session · 40% · offset", { exact: false })).toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toEqual({
    anthropic: { session: null, week: null },
    openai: { primary: { activatedAt: expect.any(String) }, secondary: null },
  });
});
