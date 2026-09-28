import { appendEvent } from "../src/events.js";
import { recordKnowledge } from "../src/memory.js";
import { FakeAttributionClient } from "../tests/fakes.js";
import { api, completeViaMcp, HOUR, loggedEntry, mcpClient, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// issue #371: 異議バッジは triage 画面のローカル state だけで描かれており、
// リロードやセッションが開いたままの再オープンで消えていた。ログ配信
// (`GET /api/log`)がエントリごとの異議注釈を運ぶようになったので、リロード
// 後も commit 待ちの注釈が残ることを確認する。
test("異議を打った後にリロードしても、同じエントリに注釈バッジと bundle 件数が残る(issue #371)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "リロード後も残る異議 e2e");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, work.id);
  await client.callTool({ name: "log_decision", arguments: { line: "リロード対象の判断" } });
  await client.close();

  await page.goto(t.baseUrl);
  await page.getByText("リロード対象の判断").click();
  await page.getByRole("textbox").fill("リロードしても残るはずの方向コメント");
  await page.getByRole("button", { name: "Object", exact: true }).click();
  await expect(page.getByText("objection: リロードしても残るはずの方向コメント")).toBeVisible();

  await page.reload();

  await expect(page.getByText("objection: リロードしても残るはずの方向コメント")).toBeVisible();
  await page.getByRole("button", { name: "Merge decisions" }).click();
  await page.getByRole("button", { name: "Queue check" }).click();
  await page.getByRole("button", { name: "Wrap up" }).click();
  await expect(page.getByText("1 objection bundle into repair tasks at commit")).toBeVisible();
});

// issue #371: 打った異議は束ねられた後もログエントリの注釈として残る
// (ADR 0085)。セッションが commit で閉じた後にリロードすると、その異議は
// 「束ね済み」の退いた見た目になり、bundle 件数からは外れる。
test("異議を打ったセッションが commit で閉じた後にリロードすると、注釈は bundled として残り bundle 件数には数えない(issue #371)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "束ね済みになる異議 e2e");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, work.id);
  await client.callTool({ name: "log_decision", arguments: { line: "束ね済み対象の判断" } });
  await client.close();

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const entry = log.entries.find((e: any) => e.payload.line === "束ね済み対象の判断");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "束ね済みになる方向コメント",
  });
  await api(t.baseUrl, "POST", "/api/triage/close"); // このセッションを commit で閉じる

  await page.goto(t.baseUrl);

  await expect(page.getByText("bundled")).toBeVisible();
  await expect(page.getByText("束ね済みになる方向コメント")).toBeVisible();
  // 束ね済みは commit 待ちの見た目(`objection: …` の素の接頭辞)を名乗らない
  await expect(page.getByText("objection: 束ね済みになる方向コメント")).not.toBeVisible();
  await page.getByRole("button", { name: "Merge decisions" }).click();
  await page.getByRole("button", { name: "Queue check" }).click();
  await page.getByRole("button", { name: "Wrap up" }).click();
  await expect(page.getByText(/objections? bundle into repair tasks at commit/)).not.toBeVisible();
});

test("異議注釈の横に最新の cause が読み取り専用で並び uncertain は未確定と分かる(issue #576)", async ({
  boot,
  page,
}) => {
  const attributionClient = new FakeAttributionClient();
  const t = await boot({ attributionClient });
  const work = await registerWork(t, "帰責表示 e2e");
  await t.clock.advance(HOUR);
  const decided = await loggedEntry(t, work.id, "明示された条件を落とした判断");
  const uncertain = await loggedEntry(t, work.id, "証拠だけでは決められない判断");
  attributionClient.scriptJudgment(decided.id, { cause: "capability", evidence: "criterion was explicit" });
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: decided.id,
    comment: "明示条件を満たしてください",
  });
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: uncertain.id,
    comment: "RCA で原因を確かめてください",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  await page.goto(t.baseUrl);

  const decidedRow = page.locator(".tp-log-entry").filter({ hasText: "明示された条件を落とした判断" });
  const uncertainRow = page.locator(".tp-log-entry").filter({ hasText: "証拠だけでは決められない判断" });
  const decidedCause = decidedRow.getByText("cause: capability", { exact: true });
  const uncertainCause = uncertainRow.getByText("cause: not yet determined (uncertain)", { exact: true });
  await expect(decidedCause).toBeVisible();
  await expect(uncertainCause).toBeVisible();
  await expect(decidedCause).toHaveJSProperty("tagName", "SPAN");
  await expect(uncertainCause).toHaveJSProperty("tagName", "SPAN");
});

test("memory の帰責は異議バッジに cause と名指された entry へのリンクを出し、リンクは settings の記憶一覧のその entry へ移る(issue #1045)", async ({
  boot,
  page,
}) => {
  const t = await boot({ attributionClient: new FakeAttributionClient() });
  const work = await registerWork(t, "記憶への帰責 e2e");
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

  await page.goto(t.baseUrl);

  const row = page.locator(".tp-log-entry").filter({ hasText: "誤ったメモに従った判断" });
  await expect(row.getByText("cause: memory")).toBeVisible();
  // リンクは行の Object 押下面の入れ子にならない(issue #1090)
  const objectSurface = row.getByRole("button", { name: /誤ったメモに従った判断/ });
  await expect(objectSurface).toHaveCount(1);
  await expect(objectSurface.getByRole("link")).toHaveCount(0);
  await row.getByRole("link", { name: `#${note}` }).click();

  await expect(page.getByTestId(`memory-entry-${note}`)).toBeInViewport();

  // キーボードでも同じ所へ移る —— Enter が行の Object に吸われない
  await page.goto(t.baseUrl);
  await row.getByRole("link", { name: `#${note}` }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(`memory-entry-${note}`)).toBeInViewport();
});

test("異議注釈の帯を押しても Object の composer は開かず、行の本文を押すと開く(issue #1090)", async ({ boot, page }) => {
  const t = await boot();
  const work = await registerWork(t, "注記の帯は押下面の外 e2e");
  await t.clock.advance(HOUR);
  const decided = await loggedEntry(t, work.id, "帯の外側を押す判断");
  await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: decided.id, comment: "帯の中の方向コメント" });

  await page.goto(t.baseUrl);

  const row = page.locator(".tp-log-entry").filter({ hasText: "帯の外側を押す判断" });
  await row.getByText("objection: 帯の中の方向コメント").click();
  await expect(row).not.toHaveAttribute("data-active");
  await expect(page.getByRole("textbox")).toHaveCount(0);

  await row.getByText("帯の外側を押す判断").click();
  await expect(row).toHaveAttribute("data-active", "");
  await expect(page.getByRole("textbox")).toBeVisible();
});

test("行の Object 押下面に focus して Enter でも Space でも Object の composer が開く(issue #1090)", async ({ boot, page }) => {
  const t = await boot();
  const work = await registerWork(t, "キーボードで異議 e2e");
  await t.clock.advance(HOUR);
  await loggedEntry(t, work.id, "キーボードで開く判断");

  for (const key of ["Enter", "Space"]) {
    await page.goto(t.baseUrl);
    const row = page.locator(".tp-log-entry").filter({ hasText: "キーボードで開く判断" });
    await row.getByRole("button", { name: /キーボードで開く判断/ }).focus();
    await page.keyboard.press(key);
    await expect(row).toHaveAttribute("data-active", "");
    await expect(page.getByRole("textbox")).toBeVisible();
  }
});

test("完了エントリの Expand ボタンは handoff を開閉する(issue #1090)", async ({ boot, page }) => {
  const t = await boot();
  const task = await registerWork(t, "handoff を開閉する e2e");
  await t.clock.advance(HOUR);
  await completeViaMcp(t, task.id);

  await page.goto(t.baseUrl);
  // landing 先の無い完了は PR 昇格失敗の question を出すので、ログまで進む
  await page.getByRole("button", { name: /Log skim/ }).click();

  const expand = page.getByRole("button", { name: "Expand handoff" });
  const handoff = page.getByText(`handoff — ${task.id}`);
  await expand.click();
  await expect(handoff).toBeVisible();
  await expand.click();
  await expect(handoff).toHaveCount(0);
});
