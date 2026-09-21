import { api } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// #746: 常駐 e2e は Register タブを一度も開いていなかった —— triage で
// main 上で確認済み、RegisterScreen の本体先頭に throw を入れて bundle を
// 再ビルドしても全部緑のままだった。このスモークは描画だけを見る: Register に
// 切り替えたら brain dump の入力欄と plain form への切替ボタンが出て、その間
// console error も pageerror も出ないこと。

test("Register タブを開くと brain dump フォームが描画され、console/pageerror が出ない", async ({
  boot,
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  const t = await boot();
  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Register" }).click();

  await expect(page.getByPlaceholder("what needs doing, in your own words")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "LLM unavailable? use the plain form" }),
  ).toBeVisible();

  expect(errors).toEqual([]);
});

test("pending dump の行ごとに Use / Discard の aria-label が一意で、行を識別できる(#861)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const seed = async (line: string) => {
    await api(t.baseUrl, "POST", "/api/triage/start");
    const scratch = (await api(t.baseUrl, "POST", "/api/triage/scratchpad", { line })).json;
    await api(t.baseUrl, "POST", "/api/triage/close", {
      scratchpad: [{ id: scratch.id, disposition: "register" }],
    });
  };
  const firstLine = "最初の pending dump";
  const secondLine = "2番目の pending dump";
  await seed(firstLine);
  await seed(secondLine);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Register" }).click();

  await expect(page.getByText(firstLine)).toBeVisible();
  await expect(page.getByText(secondLine)).toBeVisible();

  const useFirst = page.getByRole("button", { name: `use ${firstLine}`, exact: true });
  const discardFirst = page.getByRole("button", { name: `discard ${firstLine}`, exact: true });
  const useSecond = page.getByRole("button", { name: `use ${secondLine}`, exact: true });
  const discardSecond = page.getByRole("button", { name: `discard ${secondLine}`, exact: true });
  await expect(useFirst).toHaveCount(1);
  await expect(discardFirst).toHaveCount(1);
  await expect(useSecond).toHaveCount(1);
  await expect(discardSecond).toHaveCount(1);

  // Use は自分の行の本文だけをフォームへ流す
  await useSecond.click();
  await expect(page.getByPlaceholder("what needs doing, in your own words")).toHaveValue(secondLine);

  // Discard は自分の行だけを消す — もう一方は残る
  await discardFirst.click();
  await expect(page.getByText(firstLine)).toHaveCount(0);
  await expect(useSecond).toHaveCount(1);
});
