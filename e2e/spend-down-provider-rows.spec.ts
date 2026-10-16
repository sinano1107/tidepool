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

test("観測の無い Provider の arm 済み窓にも行と cancel が出て、取り消せる(arm の無い窓には出ない)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const now = t.clock.now();
  // 観測済みの間に session を arm してから、観測不能に落ちる(arm は残る —— ADR 0260 決定5)
  reportProviderUsage(t.db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: now,
    windows: [
      {
        window: "session",
        model: null,
        usedPercent: 40,
        durationMs: 5 * H,
        resetsAt: new Date(now.getTime() + 2 * H),
        throttled: false,
        resumesAt: null,
      },
    ],
  });
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "anthropic", window: "session", active: true });
  reportProviderUsage(t.db, {
    provider: "anthropic",
    status: "unobservable",
    plan: null,
    cliVersion: null,
    reason: "probe failed",
    observedAt: now,
    windows: [],
  });
  // openai は観測が一度も無いまま次の窓に arm する
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "openai", window: "primary", active: true });

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  const anthropic = page.getByTestId("provider-usage-anthropic");
  const openai = page.getByTestId("provider-usage-openai");
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await expect(anthropic.getByText("session · spend-down · until", { exact: false })).toBeVisible();
  await expect(openai.getByText("openai", { exact: true })).toBeVisible();
  await expect(openai.getByText("primary · spend-down · armed for next window")).toBeVisible();
  // 観測が無いので状態の色文字は出さない
  await expect(openai.getByText(/observed|unobservable/)).toHaveCount(0);
  // arm の無い窓(week / secondary)には行も入口も出ない
  await expect(anthropic.getByRole("button")).toHaveCount(1);
  await expect(openai.getByRole("button")).toHaveCount(1);
  await expect(page.getByText(/week|secondary/)).toHaveCount(0);

  await button("cancel spend-down anthropic session").click();
  await expect(anthropic.getByText("session", { exact: false })).toHaveCount(0);
  await button("cancel spend-down openai primary").click();
  await expect(page.getByTestId("provider-usage-openai")).toHaveCount(0);
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toEqual({
    anthropic: { session: null, week: null },
    openai: { primary: null, secondary: null },
  });
});

test("providerUsage が空でも arm があれば provider usage の欄を描く", async ({ boot, page }) => {
  const t = await boot();
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "openai", window: "primary", active: true });
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.providerUsage).toBeUndefined();

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  const openai = page.getByTestId("provider-usage-openai");
  await expect(openai.getByText("primary · spend-down · armed for next window")).toBeVisible();
  await expect(page.getByTestId("provider-usage-anthropic")).toHaveCount(0);
  await page.getByRole("button", { name: "cancel spend-down openai primary", exact: true }).click();
  await expect(page.getByTestId("provider-usage")).toHaveCount(0);
});
