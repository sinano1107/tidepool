import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// human 宛てタスクの居場所と閉じ方(issue #13 / #301)。行集合は /api/your-tasks、
// 実行キューは /api/queue と出所が別なので、片方だけ動かすと human タスクが盤面上の
// どこにも出なくなる — issue #300 が実際に踏んだ穴。その1本を CI に据える。
test("孤立した human タスクは Your tasks に現れ、ワンタップの Done で消える", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const title = "physically water the greenhouse";
  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: "the seedlings need it today",
    completion_criteria: "the beds are damp through",
    assignee: "human",
  });

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();

  const row = page.getByText(title).locator("..");
  await expect(row).toBeVisible();
  // 塞いでいる親が無いので確認ダイアログは挟まらない
  await row.getByRole("button", { name: "Done" }).click();

  await expect(page.getByText(title)).toHaveCount(0);
  await expect(page.getByText("none.")).toBeVisible();
});
