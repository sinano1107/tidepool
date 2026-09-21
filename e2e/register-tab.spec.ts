import { expect, test } from "./fixtures.js";

// #746: 常駐 e2e(52 件)は Register タブを一度も開いていなかった —— triage で
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

  await expect(
    page.getByPlaceholder("what needs doing, in your own words", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "LLM unavailable? use the plain form" }),
  ).toBeVisible();

  expect(errors).toEqual([]);
});
