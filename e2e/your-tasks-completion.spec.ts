import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// human 宛てタスクの居場所と閉じ方(issue #13 / #301)。行集合は /api/your-tasks、
// 実行キューは /api/queue と出所が別なので、片方だけ動かすと human タスクが盤面上の
// どこにも出なくなる — issue #300 が実際に踏んだ穴。その1本を CI に据える。
test("孤立した human タスクは Your tasks に現れ、行を識別する Done で消える", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const title = "physically water the greenhouse";
  const otherTitle = "restock the greenhouse gloves";
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title,
      purpose: "the seedlings need it today",
      completion_criteria: "the beds are damp through",
      assignee: "human",
    })
  ).json;
  const otherTask = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: otherTitle,
      purpose: "hands need protecting too",
      completion_criteria: "gloves are back on the shelf",
      assignee: "human",
    })
  ).json;

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();

  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText(otherTitle)).toBeVisible();
  // 2行あっても aria-label に task id が入っているので exact match で1件に絞れる(#861)
  const done = page.getByRole("button", { name: `done ${task.id}`, exact: true });
  await expect(done).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: `done ${otherTask.id}`, exact: true }),
  ).toHaveCount(1);
  await done.click();

  await expect(page.getByText(title)).toHaveCount(0);
  await expect(done).toHaveCount(0);
  // 塞いでいる親が無いので確認ダイアログも挟まらない — もう一方の行は残る
  await expect(page.getByText(otherTitle)).toBeVisible();
});
