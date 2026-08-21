import { api, HOUR, mcpClient, registerWork } from "../tests/harness.js";
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
