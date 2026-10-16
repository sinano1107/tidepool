import { settleQuestionAsObserved } from "../src/tasks.js";
import { api, registerQuestion, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// Issue #2081: 観測で閉じた question の行と question 面に英語の札が出て、人間が答えた question には出ない(ADR 0265 決定7)。
// 種類の導きは vitest のサーバ境界が言い、ここは欄から札の文言への配線だけ(ADR 0107)。
test("観測で閉じた question の行と question 面にだけ観測の札が出る", async ({ boot, page }) => {
  const t = await boot();
  // 閉じた木は盤面から消えるので、question は開いた親の下に立てる
  const parent = await registerWork(t, "the parent stays open");
  const ask = (title: string) =>
    registerQuestion(t, {
      title,
      purpose: "p",
      completion_criteria: "c",
      parent_id: parent.id,
      question: [{ title, options: ["retry", "abandon"], recommendation: "retry" }],
    });
  const observed = ask("settled by the board");
  settleQuestionAsObserved(t.db, observed.id, { kind: "pr_promotion_observed" }, t.clock.now());
  const answered = ask("answered by a human");
  expect((await api(t.baseUrl, "POST", `/api/tasks/${answered.id}/answer`, { answers: ["abandon"] })).status).toBe(200);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Board" }).click();
  await expect(page.getByTestId(`settled-by-observation-${observed.id}`)).toHaveText("observed · PR promoted");
  await expect(page.getByTestId(`settled-by-observation-${answered.id}`)).toHaveCount(0);

  await page.goto(`${t.baseUrl}?question=${observed.id}`);
  await expect(page.getByTestId("settled-by-observation")).toContainText("observed · PR promoted");
  await page.goto(`${t.baseUrl}?question=${answered.id}`);
  await expect(page.getByText("This question is no longer available")).toBeVisible();
  await expect(page.getByTestId("settled-by-observation")).toHaveCount(0);
});
