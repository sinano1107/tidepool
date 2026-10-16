import type { AgentView } from "../src/agent-create.js";
import { settleQuestionAsObserved } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
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
});

// 回答の直前に前提が崩れた tier の提案は 200 + 印で返る —— question 面は盤面へ戻らず、回答が記録されていないことを札で言う
test("question 面で答えた提案が観測で閉じたら、面に留まり観測の札を出す", async ({ boot, page }) => {
  // registry の deckhand は既に standard —— 提案の pin(frontier)が崩れている
  const t = await boot({ agentAdmin: { list: () => [{ name: "deckhand", tier: "standard", provider: "openai" } as AgentView], changeTier: async () => "c0ffee" } });
  const title = "lower deckhand to standard";
  const proposal = registerQuestion(t, {
    title,
    purpose: "p",
    completion_criteria: "c",
    question: [{ title, options: ["approve", "reject"], recommendation: "approve" }],
    question_kind: {
      kind: "proposal",
      proposal: { kind: "registry", op: "agent_tier", agent: "deckhand", to: tierIdOf(t.db, "standard"), pin: { tier: tierIdOf(t.db, "frontier"), rows: [] }, evidence: [] },
    },
  });

  await page.goto(`${t.baseUrl}?question=${proposal.id}`);
  await page.getByRole("button", { name: /^approve/ }).click();
  await page.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByTestId("settled-by-observation")).toContainText("observed · routing proposal stale");
});
