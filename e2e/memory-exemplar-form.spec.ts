import { HOUR, loggedEntry, memoryEntries, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// Issue #953 の恒久 smoke: settings の Memory card の Exemplar form の配線 —— 決定ログの一覧から事例を選ぶと
// case 描画がその場に出て、描画の文字列を選択すると注釈の anchor が埋まり、送信で exemplar エントリができる。
// 選択 → anchor の配線は JSX にしか無く、vitest では測れない層(ADR 0029)。レイアウトは見ない。
test("決定ログのエントリを事例に選び、描画の選択で anchor を埋めて送ると exemplar ができる", async ({ boot, page }) => {
  const t = await boot();
  const work = await registerWork(t, "exemplar form e2e");
  await t.clock.advance(HOUR);
  const decision = await loggedEntry(t, work.id, "split the migration into two commits");

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-section-board").click();
  await page.getByRole("button", { name: "Write", exact: true }).click();
  // form の Kind は一覧の絞り込みの Kind より前に出る
  await page.getByLabel("Kind").first().selectOption("exemplar");
  await page.getByLabel("Path").fill("habits/commits");
  await page.getByLabel("Title (English)").fill("Separate schema commits");
  await page.getByRole("button", { name: "Add annotation" }).click();

  await page.getByTestId(`memory-case-row-${decision.id}`).getByRole("button", { name: "This entry" }).click();
  const field = page.getByTestId("memory-case").locator('[data-field="decision"]');
  await expect(field).toHaveText("split the migration into two commits");
  await field.selectText();
  await expect(page.getByTestId("exemplar-anchor")).toContainText("decision “split the migration into two commits”");

  await page.getByLabel("Polarity").selectOption("imitate");
  await page.getByLabel("Annotation (English)").fill("Keep the schema change in its own commit.");
  await page.getByRole("button", { name: "Save exemplar" }).click();

  await expect(page.getByText("Separate schema commits")).toBeVisible();
  expect(await memoryEntries(t, "?kind=exemplar")).toMatchObject([
    {
      source: { kind: "event", ref: decision.id },
      annotations: [{ anchor: { field: "decision", quote: "split the migration into two commits" } }],
    },
  ]);
});
