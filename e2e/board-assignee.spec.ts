import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

test("assignee 未指定の review は Board で Auditor の名前とアイコンを描く(issue #221)", async ({ boot, page }) => {
  const t = await boot({
    auditorName: "fugu",
    registryCandidates: { assignees: ["fugu"], workspaces: [], icons: { fugu: "🐡" } },
  });
  const title = "independent review uses the Auditor";
  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "review",
    title,
    purpose: "review independently",
    completion_criteria: "record findings",
  });

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Board" }).click();

  const card = page.getByText(title).locator("..");
  await expect(card).toContainText("fugu");
  await expect(card).toContainText("🐡");
  await expect(card).not.toContainText("—");
});
