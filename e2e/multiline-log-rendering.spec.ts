import { HOUR, mcpClient, registerQuestion, registerWork } from "../tests/harness.js";
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
