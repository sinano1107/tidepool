import { api, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// タスクブランチを持つ人間担当の work の完了(ADR 0374 決定1・10、#3293): 完了の dialog は handoff の6欄を必須にし、作業台があれば
// それを消すこと(spec #3273 text C4)を言う。タスクブランチの無い task は今どおり1タップで閉じる —— 2つの扉の分岐に錘を置く。
test("書き始めた人間担当の work の Done は6欄必須の dialog と text C4 を出し、タスクブランチの無い task は1タップで閉じる", async ({ boot, workspace, page }) => {
  const t = await boot({ workspace: await workspace("e2e-human-work") });
  const started = await registerWork(t, "write it myself", undefined, "human");
  const plain = await registerWork(t, "water the plants", undefined, "human");
  const path = (await api(t.baseUrl, "POST", `/api/tasks/${started.id}/start-work`, {})).json.path;

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();

  // aria-label に task id が入っているので exact match で行を1つに絞れる(#861)
  await page.getByRole("button", { name: `done ${plain.id}`, exact: true }).click();
  await expect(page.getByText("water the plants")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Complete task" })).toHaveCount(0);

  await page.getByRole("button", { name: `done ${started.id}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Complete task" })).toBeVisible();
  await expect(page.getByText(`Completing deletes the workbench at ${path}, including ignored files.`)).toBeVisible();
  const done = page.getByRole("dialog").getByRole("button", { name: "Done" });
  await expect(done).toBeDisabled();
  for (const label of ["outcome vs criteria", "deliverable location", "key decision refs", "dead ends", "context to resume", "known issues (no task)"]) {
    await page.getByLabel(label).fill("n/a");
  }
  await expect(done).toBeEnabled();
  await done.click();
  await expect.poll(async () => (await api(t.baseUrl, "GET", `/api/tasks/${started.id}`)).json.status).toBe("done");
});

// ADR 0374 決定2 / spec #3273 group C(Surfaces): 書き始めた人間担当の work の task の dialog は、作業台の在り処と、そこへ移るコマンドと
// clone の remote に足すコマンドを、写せる形で出す
test("書き始めた人間担当の work の task の dialog は作業台の在り処と cd・git remote add のコマンドを出す", async ({ boot, workspace, page }) => {
  const t = await boot({ workspace: await workspace("e2e-human-workbench") });
  const started = await registerWork(t, "write it myself", undefined, "human");
  const path = (await api(t.baseUrl, "POST", `/api/tasks/${started.id}/start-work`, {})).json.path;

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Board" }).click();
  await page.getByText("write it myself").click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(`workbench: ${path}`)).toBeVisible();
  for (const command of [`cd ${path}`, `git remote add <name> <ssh-host>:${path}`]) {
    await expect(dialog.getByText(command, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: `copy ${command}` })).toBeVisible();
  }
});
