import { expect, test } from "./fixtures.js";

test("Board のタスクカードをタップすると Add child ダイアログが開き、子タスクを追加できる", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await page.goto(t.baseUrl);

  // Register a root work task via the plain form (no draft client configured)
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByText("LLM unavailable? use the plain form").click();
  await page.getByLabel("Title").fill("build the toolchain");
  await page.getByLabel("Purpose").fill("ship the compiler");
  await page.getByLabel("Completion criteria").fill("all stages pass");
  await page.getByRole("button", { name: "Register — appends to queue tail" }).click();

  await expect(page.getByText("registered — appended to queue tail")).toBeVisible();

  // Go to Board, tap the new task's card
  await page.getByRole("button", { name: "Board" }).click();
  await page.getByText("build the toolchain").click();

  // Dialog opens in "Add child" mode
  await expect(page.getByRole("heading", { name: "Add child" })).toBeVisible();
  await expect(page.getByText('splitting "build the toolchain"')).toBeVisible();
  await expect(page.getByLabel("Reason for splitting this (optional)")).toBeVisible();
  await expect(page.getByLabel("Source")).toHaveCount(0);
  await expect(page.getByLabel("Type")).toHaveCount(0);

  // Cancel a fresh open registers nothing
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Add child" })).toHaveCount(0);

  // Reopen and actually add a child
  await page.getByText("build the toolchain").click();
  await page.getByLabel("Reason for splitting this (optional)").fill("splitting off the lexer");
  await page.getByText("LLM unavailable? use the plain form").click();
  await page.getByLabel("Title").fill("build the lexer");
  await page.getByLabel("Purpose").fill("tokens for the parser");
  await page.getByLabel("Completion criteria").fill("lexer passes the token fixtures");
  await page.getByRole("button", { name: "Add child — appends to queue tail" }).click();

  await expect(page.getByText("child added — appended to queue tail")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add child" })).toHaveCount(0);

  // Board reflects the new child and the parent going blocked
  await expect(page.getByText("build the lexer")).toBeVisible();
});
