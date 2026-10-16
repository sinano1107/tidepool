import { completedWork, queuedForAutoMerge } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// Issue #2082: done の work の行に着地の状態の英語の札が出て、状態の無い行には出ない(ADR 0265 決定7)。
// 状態の導きは vitest の domain 層が言い、ここは欄から札の文言への配線だけ(ADR 0107)。
test("着地の状態を持つ done の work の行にだけ着地の札が出る", async ({ boot, page }) => {
  const t = await boot();
  // 完了時レビューが todo で残るので、どちらの木も盤面に残る
  const queued = queuedForAutoMerge(t.db, t.clock.now(), "tako");
  const unopened = completedWork(t.db, t.clock.now(), "tako");

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Board" }).click();
  await expect(page.getByTestId(`landing-state-${queued.id}`)).toHaveText("landing · auto-merge queue");
  await expect(page.getByTestId(`landing-state-${unopened.id}`)).toHaveCount(0);
});
