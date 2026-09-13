import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// Issue #545 の恒久 smoke: settings タブ → Board の実行設定2カード(盤面既定 / 表)を
// 実ブラウザで編集し、保存が /api/settings/execution に着地することを確かめる。
// 選択・削除・行追加の配線は JSX にしか無く、vitest では測れない層(ADR 0029)。

async function openBoardSettings(page: import("@playwright/test").Page, baseUrl: string) {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-section-board").click();
}

test("Provider 順位・優先順位の既定・frontier advisor を1カードで編集して保存できる", async ({ boot, page }) => {
  const t = await boot();
  await openBoardSettings(page, t.baseUrl);

  const card = page.getByTestId("execution-defaults");
  await expect(card).toContainText("anthropic › moonshot › openai");
  await card.getByRole("button", { name: "Edit" }).click();

  const save = card.getByRole("button", { name: "Save execution defaults" });
  await expect(save).toBeDisabled();
  // 同じ Provider を2度選ぶと順列でないので送れない
  await card.getByLabel("Rank 1").selectOption("openai");
  await expect(save).toBeDisabled();
  await card.getByLabel("Rank 3").selectOption("anthropic");
  await card.getByLabel("Default priority").selectOption("cost");
  await card.getByTestId("execution-frontier-advisor").click();
  await expect(save).toBeEnabled();
  await save.click();

  await expect(card).toContainText("openai › moonshot › anthropic");
  expect((await api(t.baseUrl, "GET", "/api/settings/execution")).json).toMatchObject({
    providerRank: ["openai", "moonshot", "anthropic"],
    priority: "cost",
    frontierAdvisor: true,
  });
});

test("表の行を消す・価格を直す・行を足すのが1回の保存で反映される", async ({ boot, page }) => {
  const t = await boot();
  await openBoardSettings(page, t.baseUrl);

  const card = page.getByTestId("execution-table");
  await expect(card).toContainText("kimi-k3[1m]");
  await card.getByRole("button", { name: "Edit" }).click();

  await card.getByTestId("execution-row-moonshot:kimi-k3[1m]").getByRole("button", { name: "Remove" }).click();
  await card.getByTestId("execution-row-anthropic:sonnet").getByLabel("Price out").fill("8");
  await card.getByRole("button", { name: "Add row" }).click();
  const added = card.getByTestId("execution-row-new");
  await added.getByLabel("Provider").selectOption("openai");
  await added.getByLabel("Tier").selectOption("economy");
  await added.getByLabel("Model").fill("gpt-5.6-luna");
  await added.getByLabel("Effort").fill("low");
  await added.getByLabel("Price in").fill("0.5");
  await added.getByLabel("Price out").fill("2");
  await card.getByRole("button", { name: "Save execution table" }).click();

  await expect(card).toContainText("gpt-5.6-luna");
  await expect(card).not.toContainText("kimi-k3[1m]");
  const { table } = (await api(t.baseUrl, "GET", "/api/settings/execution")).json;
  expect(table.some((row: { provider: string }) => row.provider === "moonshot")).toBe(false);
  expect(table.find((row: { model: string }) => row.model === "sonnet")).toMatchObject({ price_out: 8 });
  expect(table.find((row: { model: string }) => row.model === "gpt-5.6-luna")).toEqual({
    provider: "openai",
    tier: "economy",
    model: "gpt-5.6-luna",
    effort: "low",
    price_in: 0.5,
    price_out: 2,
  });
});
