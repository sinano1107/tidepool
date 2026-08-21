import { HOUR, mcpClient, registerQuestion, registerWork, type Tidepool } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

/** 着地 question を盤面の DB へ直に立てる — `registerLocalMergeQuestion` と同じ形
 *  (`pending_local_merge_task_id` を持つ question)。着地の門そのものは vitest 側
 *  (層1/層2)が覆っているので、この spec の主題は画面だけ。 */
function landQuestion(t: Tidepool, taskId: string, title: string) {
  return registerQuestion(t, {
    title,
    purpose: "the completed task branch awaits a merge decision",
    completion_criteria: "a human decides whether to land the completed task branch",
    question: [{ title, options: ["merge", "hold"], recommendation: "merge" }],
    pending_local_merge_task_id: taskId,
  });
}

test("一本道は5段で、着地 question は質問ステップではなく merge 判断ステップに出る(ADR 0092 決定4)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "the branch that waits to land");
  landQuestion(t, work.id, "land completed task: the branch that waits to land");
  registerQuestion(t, {
    title: "which way?",
    purpose: "an agent escalated a decision",
    completion_criteria: "the answer is recorded",
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });

  await page.goto(t.baseUrl);

  await expect(page.getByText("1 / 5 — questions")).toBeVisible();
  await expect(page.getByText("which way?").first()).toBeVisible();
  await expect(page.getByText("land completed task:")).toHaveCount(0);

  await page.getByRole("button", { name: /^Log skim/ }).click();
  await expect(page.getByText("2 / 5 — decision log")).toBeVisible();

  await page.getByRole("button", { name: "Merge decisions" }).click();
  await expect(page.getByText("3 / 5 — merge decisions")).toBeVisible();
  await expect(page.getByText("land completed task:").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^merge/ })).toBeVisible();

  await page.getByRole("button", { name: "Queue check" }).click();
  await expect(page.getByText("4 / 5 — queue")).toBeVisible();

  await page.getByRole("button", { name: "Wrap up" }).click();
  await expect(page.getByText("5 / 5 — commit")).toBeVisible();
});

test("流し読みで異議を打ったタスクの着地 question は、件数と理由の1行になり merge ボタンが出ない(ADR 0092 決定5)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "the objected branch");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, work.id);
  await client.callTool({ name: "log_decision", arguments: { line: "異議を打たれる判断" } });
  await client.close();
  landQuestion(t, work.id, "land completed task: the objected branch");

  await page.goto(t.baseUrl);
  await expect(page.getByText("2 / 5 — decision log")).toBeVisible();

  // 異議はこの面に来るまでに打たれる — 凍結した snapshot ではなく、merge 判断に
  // 入る瞬間の盤面が回答可否を答えなければ、押せば 409 になる merge ボタンが出る
  await page.getByText("異議を打たれる判断").click();
  await page.getByRole("textbox").fill("この判断のまま着地させたくない");
  await page.getByRole("button", { name: "Object", exact: true }).click();

  await page.getByRole("button", { name: "Merge decisions" }).click();

  await expect(page.getByText("1 landing question not yet answerable — objections await commit")).toBeVisible();
  await expect(page.getByText("land completed task:")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^merge/ })).toHaveCount(0);
});
