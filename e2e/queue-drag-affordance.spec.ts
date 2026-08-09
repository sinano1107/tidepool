import { registerQuestion, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

test("triage の読み取り専用 preview はドラッグ可能に見せず、Queue は見せる(issue #226)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await registerWork(t, "a queue row");
  registerQuestion(t, {
    title: "choose a direction",
    purpose: "enter triage",
    completion_criteria: "the choice is recorded",
    question: [{ title: "choose a direction", options: ["left", "right"], recommendation: "left" }],
  });

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: /^left/ }).click();
  await page.getByRole("button", { name: "Log skim" }).click();
  await page.getByRole("button", { name: "Queue check" }).click();

  await expect(page.getByText("The tide is going out.")).toBeVisible();
  await expect(page.getByText("a queue row")).toBeVisible();
  await expect(page.getByTestId("queue-drag-handle")).toHaveCount(0);

  await page.getByRole("button", { name: "Queue" }).click();
  const handle = page.getByTestId("queue-drag-handle");
  await expect(handle).toBeVisible();
  await expect(handle).toHaveCSS("cursor", "grab");
});
