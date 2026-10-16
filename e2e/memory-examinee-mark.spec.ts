import { recordKnowledge } from "../src/memory.js";
import { interviewPinChild, rememberedNote } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// Issue #2070: settings の Memory card の一覧で、受験者(Interview の pin の子)が書いたエントリの行にだけ
// 書いた pin の子と Interview の対象の印が出る(ADR 0264 決定1)。欄から行の文言への配線は JSX にしか無い(ADR 0107)。
test("受験者が書いたエントリの行にだけ examinee の印が出る", async ({ boot, page }) => {
  const t = await boot();
  const production = rememberedNote(t, "Production note");
  const pinChild = interviewPinChild(t.db, t.clock.now());
  const examinee = recordKnowledge(
    t.db,
    { scope: null, path: "build", title: "Examinee note", text: "Examinee note.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    t.clock.now(),
    pinChild.id,
  ).entry_id;

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-section-board").click();

  await expect(page.getByTestId(`memory-entry-${examinee}`)).toContainText(`examinee: anthropic claude-opus-5-5 high (task ${pinChild.id})`);
  await expect(page.getByTestId(`memory-entry-${production}`)).not.toContainText("examinee");
});
