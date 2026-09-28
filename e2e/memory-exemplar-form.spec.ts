import type { Page } from "@playwright/test";
import { appendEvent } from "../src/events.js";
import { recordKnowledge } from "../src/memory.js";
import { FakeAttributionClient } from "../tests/fakes.js";
import { api, HOUR, loggedEntry, memoryEntries, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

/** settings の Memory card で exemplar の下書きフォームを開く */
async function openExemplarForm(page: Page, baseUrl: string) {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-section-board").click();
  await page.getByRole("button", { name: "Write", exact: true }).click();
  // form の Kind は一覧の絞り込みの Kind より前に出る
  await page.getByLabel("Kind").first().selectOption("exemplar");
}

// Issue #953 の恒久 smoke: settings の Memory card の Exemplar form の配線 —— 決定ログの一覧から事例を選ぶと
// case 描画がその場に出て、描画の文字列を選択すると注釈の anchor が埋まり、送信で exemplar エントリができる。
// 選択 → anchor の配線は JSX にしか無く、vitest では測れない層(ADR 0029)。レイアウトは見ない。
test("決定ログのエントリを事例に選び、描画の選択で anchor を埋めて送ると exemplar ができる", async ({ boot, page }) => {
  const t = await boot();
  const work = await registerWork(t, "exemplar form e2e");
  await t.clock.advance(HOUR);
  const decision = await loggedEntry(t, work.id, "split the migration into two commits");

  await openExemplarForm(page, t.baseUrl);
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

// issue #1102: 記憶ケース選択の異議も triage の log と同じく、開いているセッションのものだけが commit 待ち(ADR 0085)
test("記憶ケース選択で、閉じたセッションの異議は bundled、開いているセッションの異議は commit 待ちとして出る(issue #1102)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "ケース選択の異議 e2e");
  await t.clock.advance(HOUR);
  const bundled = await loggedEntry(t, work.id, "束ね済みの異議を持つ判断");
  const pending = await loggedEntry(t, work.id, "commit 待ちの異議を持つ判断");
  await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: bundled.id, comment: "閉じたセッションの方向コメント" });
  await api(t.baseUrl, "POST", "/api/triage/close");
  await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: pending.id, comment: "開いているセッションの方向コメント" });

  await openExemplarForm(page, t.baseUrl);

  const bundledRow = page.getByTestId(`memory-case-row-${bundled.id}`);
  await expect(bundledRow.getByText("bundled")).toBeVisible();
  await expect(bundledRow.getByText("閉じたセッションの方向コメント")).toBeVisible();
  await expect(bundledRow.getByText("objection: 閉じたセッションの方向コメント")).toHaveCount(0);
  const pendingRow = page.getByTestId(`memory-case-row-${pending.id}`);
  await expect(pendingRow.getByText("objection: 開いているセッションの方向コメント")).toBeVisible();
  await expect(pendingRow.getByText("bundled")).toHaveCount(0);
});

test("記憶ケース選択の memory の帰責のリンクは記憶一覧のその entry へ何度でもスクロールし、下書きもケース未選択も保つ(issue #1102)", async ({
  boot,
  page,
}) => {
  const t = await boot({ attributionClient: new FakeAttributionClient() });
  const work = await registerWork(t, "ケース選択の帰責リンク e2e");
  await t.clock.advance(HOUR);
  const decided = await loggedEntry(t, work.id, "誤ったメモに従った判断");
  const note = recordKnowledge(
    t.db,
    { scope: null, path: "build", title: "Squash before merge", text: "Squash before merge.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    t.clock.now(),
  ).entry_id;
  await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: decided.id, comment: "そのメモが間違っています" });
  await api(t.baseUrl, "POST", "/api/triage/close");
  // setup のみ: 門を通った memory の帰責を最新として足す(Board call は撃たない)
  appendEvent(t.db, {
    taskId: work.id,
    workerId: "tidepool",
    origin: "board",
    at: t.clock.now(),
    payload: { kind: "objection_attributed", entry_id: decided.id, objection_event_ids: [], cause: "memory", evidence: "followed the note", entries: [note], round: "after_rca" },
  });

  await openExemplarForm(page, t.baseUrl);
  await page.getByLabel("Path").fill("habits/memory");
  await page.getByLabel("Title (English)").fill("Check the note first");

  const link = page.getByTestId(`memory-case-row-${decided.id}`).getByRole("link", { name: `#${note}` });
  const target = page.getByTestId(`memory-entry-${note}`);
  // 2回目も効く —— 1回目の後にリンクの所へ戻り、entry が見えない状態から押し直す
  for (let i = 0; i < 2; i++) {
    await link.scrollIntoViewIfNeeded();
    await expect(target).not.toBeInViewport();
    await link.click();
    await expect(target).toBeInViewport();
  }

  await expect(page.getByTestId("memory-case-picker")).toBeVisible();
  await expect(page.getByTestId("memory-case")).toHaveCount(0);
  await expect(page.getByLabel("Path")).toHaveValue("habits/memory");
  await expect(page.getByLabel("Title (English)")).toHaveValue("Check the note first");
});
