import { reportProviderUsage } from "../src/throttle.js";
import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

const H = 60 * 60 * 1000;

test("provider usage の窓の行で Provider × 窓を arm / cancel でき、idle の窓には次の窓への入口が出る", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const now = t.clock.now();
  const sessionResets = new Date(now.getTime() + 2 * H);
  const w = (window: string, model: string | null, usedPercent: number, durationMs: number) => ({
    window,
    model,
    usedPercent,
    durationMs,
    resetsAt: sessionResets,
    throttled: false,
    resumesAt: null,
  });
  // week は Idle —— 観測に現れない窓
  reportProviderUsage(t.db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: now,
    windows: [w("session", null, 40, 5 * H), w("fable", "fable", 30, 168 * H)],
  });
  // 観測不能の Provider には入口を足さない
  reportProviderUsage(t.db, {
    provider: "openai",
    status: "unobservable",
    plan: null,
    cliVersion: null,
    reason: "probe failed",
    observedAt: now,
    windows: [],
  });

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  const card = page.locator('[data-testid^="provider-usage-"]');
  // 入口は anthropic の session と Idle の week の2つ(fable と観測不能の openai には無い)
  await expect(page.getByTestId("provider-usage-anthropic").getByRole("button")).toHaveCount(2);
  await expect(page.getByTestId("provider-usage-openai").getByRole("button")).toHaveCount(0);
  await expect(page.getByText("spend-down", { exact: false })).toHaveCount(0);
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await expect(button("spend down next window anthropic week")).toHaveText("spend down next window");

  await button("spend down anthropic session").click();
  const until = await page.evaluate(
    (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    sessionResets.toISOString(),
  );
  await expect(card.getByText(`session · 40% · spend-down · until ${until}`)).toBeVisible();
  await button("spend down next window anthropic week").click();
  await expect(card.getByText("week · spend-down · armed for next window")).toBeVisible();

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toEqual({
    anthropic: {
      session: { activatedAt: expect.any(String), resetsAt: sessionResets.toISOString() },
      week: { activatedAt: expect.any(String), resetsAt: null },
    },
    openai: { primary: null, secondary: null },
  });
  await button("cancel spend-down anthropic week").click();
  await expect(button("spend down next window anthropic week")).toBeVisible();
  await button("cancel spend-down anthropic session").click();
  await expect(card.getByText("session · 40% · offset", { exact: false })).toBeVisible();
});
