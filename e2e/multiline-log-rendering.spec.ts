import { api, HOUR, loggedEntry, mcpClient, registerQuestion, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// issue #230: エージェント著述の複数行散文が white-space の指定漏れで1行に
// 潰れて描画されていた。`textContent` は CSS に関係なく生テキストを返すため
// バグが残っていても通ってしまう(issue 本文の指摘) —— ここでは
// `innerText`(描画されたとおりの見え方)で改行の保持を主張する。
const MULTILINE_PURPOSE = `tools/ には現在 json2md.js のみが直下に置かれている。

案A: ツールごとにサブディレクトリを切る
  tools/json2md/index.js
  tools/json2md/index.test.js
案B: 種類ごとにトップレベルディレクトリを切る
  tools/src/json2md.js
  tools/test/json2md.test.js`;

const MULTILINE_DECISION = `全面 pre-wrap を採用し、markdown は描かない。

対象は7箇所:
  question 本文の描画点
  decision log 本文の描画点
訳文も同じ扱いとする。`;

// issue #1103: 空白の無い長いトークン(URL・ハッシュなど)は途中で切れないため、
// `overflowWrap` の指定が無いと行が画面横にはみ出す。`scrollWidth <=
// clientWidth` で行の中に収まっていることを主張する(vitest では CSS の効き目を
// 測れないので e2e の層で言う)。
const LONG_TOKEN = Array.from({ length: 200 }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[i % 36]).join("");

test("question 本文が空行とインデントを含む複数行のまま描画される(issue #230)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  registerQuestion(t, {
    title: "tools/ の再編方針は?",
    purpose: MULTILINE_PURPOSE,
    completion_criteria: "方針が選ばれる",
    question: [{ title: "tools/ の再編方針は?", options: ["案A", "案B"], recommendation: "案A" }],
  });

  await page.goto(t.baseUrl);
  const context = page.getByText("tools/ には現在 json2md.js のみが直下に置かれている。");
  await expect(context).toBeVisible();
  expect(await context.innerText()).toBe(MULTILINE_PURPOSE);
});

test("decision log のエントリが空行とインデントを含む複数行のまま描画される(issue #230)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "pre-wrap の適用範囲を決める");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, work.id);
  await client.callTool({ name: "log_decision", arguments: { line: MULTILINE_DECISION } });
  await client.close();

  await page.goto(t.baseUrl);
  const entry = page.getByText("全面 pre-wrap を採用し、markdown は描かない。");
  await expect(entry).toBeVisible();
  expect(await entry.innerText()).toContain(MULTILINE_DECISION);
});

test("スマホ幅で本文に空白の無い長いトークンが入っても行が画面横にはみ出さない(issue #1103)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await page.setViewportSize({ width: 390, height: 844 });
  const work = await registerWork(t, "長いトークンを含む判断");
  await t.clock.advance(HOUR);
  await loggedEntry(t, work.id, `長いトークンを含む判断: ${LONG_TOKEN}`);

  await page.goto(t.baseUrl);
  const row = page.locator(".tp-log-entry").filter({ hasText: "長いトークンを含む判断" });
  await expect(row).toBeVisible();
  const [scrollWidth, clientWidth] = await row.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(scrollWidth, `scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth);
});

test("スマホ幅で異議コメントに空白の無い長いトークンが入っても、注記の帯を含む行が画面横にはみ出さない(issue #1103)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await page.setViewportSize({ width: 390, height: 844 });
  const work = await registerWork(t, "長いトークンの異議 e2e");
  await t.clock.advance(HOUR);
  const decided = await loggedEntry(t, work.id, "長いトークンの異議対象の判断");
  await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: decided.id, comment: LONG_TOKEN });

  await page.goto(t.baseUrl);
  const row = page.locator(".tp-log-entry").filter({ hasText: "長いトークンの異議対象の判断" });
  await expect(row.getByText(`objection: ${LONG_TOKEN}`)).toBeVisible();
  const [scrollWidth, clientWidth] = await row.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(scrollWidth, `scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth);
});
