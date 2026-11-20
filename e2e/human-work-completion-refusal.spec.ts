import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { api, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// #3204: 人間の work の完了 dialog の拒否文(作業台の path を運ぶ —— #3273)は toast でなく dialog の中に次の送信まで残る
test("完了 dialog の拒否文は dialog の中に作業台の path ごと折り返して残り、直して送り直せば完了する", async ({ boot, workspace, page }) => {
  const t = await boot({ workspace: await workspace("e2e-human-refusal") });
  const started = await registerWork(t, "write it myself", undefined, "human");
  const path = (await api(t.baseUrl, "POST", `/api/tasks/${started.id}/start-work`, {})).json.path;
  writeFileSync(join(path, "draft.txt"), "not committed yet\n");

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await page.getByRole("button", { name: `done ${started.id}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  for (const label of ["outcome vs criteria", "deliverable location", "key decision refs", "dead ends", "context to resume", "known issues (no task)"]) {
    await page.getByLabel(label).fill("n/a");
  }
  const refused = page.waitForResponse((r) => r.url().endsWith("/complete"));
  await dialog.getByRole("button", { name: "Done" }).click();
  const response = await refused;
  expect(response.status()).toBe(409);
  const { error } = await response.json();
  expect(error).toContain(path);

  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText(error);
  await expect(page.getByText("complete failed")).toHaveCount(0);
  // toast の自動消去(3.2 秒)を過ぎても残る
  await page.waitForTimeout(3500);
  await expect(alert).toHaveText(error);
  await expect(page.getByLabel("dead ends")).toHaveValue("n/a");

  // 本物の path は '-' で折り返せてしまうので、空白も '-' も無い長い path の拒否を1回だけ差し込み、送り直しで置き換わるのを見る
  const unbreakable = `the workbench at /srv/${"workbench".repeat(40)} has uncommitted changes. Then complete again.`;
  await page.route("**/complete", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: unbreakable }) }));
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(alert).toHaveText(unbreakable);
  expect(await alert.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.unroute("**/complete");

  await rm(join(path, "draft.txt"));
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "Complete task" })).toHaveCount(0);
  await expect.poll(async () => (await api(t.baseUrl, "GET", `/api/tasks/${started.id}`)).json.status).toBe("done");
});
