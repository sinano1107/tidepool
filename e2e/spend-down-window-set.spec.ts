import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

test("Queue で session / week を独立に arm / cancel でき、各状態が別々に見える", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();

  await page.getByRole("button", { name: "arm session" }).click();
  await expect(page.getByText("spend-down · session", { exact: true })).toBeVisible();
  await expect(page.getByText("session · 100% cap · expires at reset", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "arm week" }).click();
  await expect(page.getByText("spend-down · session + week", { exact: true })).toBeVisible();
  await expect(page.getByText("week · 100% cap · expires at reset", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "cancel session" }).click();
  await expect(page.getByText("spend-down · week", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "arm session" })).toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toMatchObject({
    session: null,
    week: { activatedAt: expect.any(String) },
  });
});
