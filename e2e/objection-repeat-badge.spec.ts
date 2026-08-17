import { HOUR, mcpClient, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// issue #251: 同一ログエントリへの2件目の異議が、triage 画面のローカル state で
// entry key ごとに文字列1本として上書きされ、注釈バッジに最後の1件しか残らない。
test("同一エントリに2件の異議を打つと、注釈バッジに両方残る(issue #251)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "二重の異議 e2e");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, work.id);
  await client.callTool({ name: "log_decision", arguments: { line: "一度きりの判断" } });
  await client.close();

  await page.goto(t.baseUrl);
  await page.getByText("一度きりの判断").click();
  await page.getByRole("textbox").fill("1件目の方向コメント");
  await page.getByRole("button", { name: "Object", exact: true }).click();
  await expect(page.getByText("objection: 1件目の方向コメント")).toBeVisible();

  await page.getByText("一度きりの判断").click();
  await page.getByRole("textbox").fill("2件目の方向コメント");
  await page.getByRole("button", { name: "Object", exact: true }).click();

  await expect(page.getByText("1件目の方向コメント")).toBeVisible();
  await expect(page.getByText("2件目の方向コメント")).toBeVisible();
});

// issue #251: 束ね表示を足す変更が、1件だけの異議の見た目を変えていないことの確認。
test("1件だけの異議は箇条書きにならず、従来どおり素の文言で表示される(issue #251)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "単発の異議 e2e");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, work.id);
  await client.callTool({ name: "log_decision", arguments: { line: "唯一の判断" } });
  await client.close();

  await page.goto(t.baseUrl);
  await page.getByText("唯一の判断").click();
  await page.getByRole("textbox").fill("たった1つの方向コメント");
  await page.getByRole("button", { name: "Object", exact: true }).click();

  await expect(page.getByText("objection: たった1つの方向コメント")).toBeVisible();
  await expect(page.getByText("- たった1つの方向コメント")).not.toBeVisible();
});
