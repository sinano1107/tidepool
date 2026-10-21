import { HOUR, queueWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

/** ADR 0294 決定1: 最後の poll の失敗は queue 画面に1行で見える(後始末の行と同じ「行 + いつ」の形)。 */
test("候補の読みが投げた poll の後、queue 画面に最後の poll の失敗の行と本文が見える", async ({ boot, page }) => {
  let broken = false;
  const t = await boot({
    taskExecutionCandidates: () => {
      if (broken) throw new Error("registry is broken");
      return [];
    },
  });
  queueWork(t, "waits for the registry");
  broken = true;
  await t.clock.advance(HOUR);
  broken = false;

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("last poll failed · the next poll retries")).toBeVisible();
  await expect(page.getByText(/^registry is broken · at \d\d:\d\d$/)).toBeVisible();
});
