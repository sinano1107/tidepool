import { api, HOUR, loggedEntry, mcpClient, memoryAttributedObjection, object, registerQuestion, registerWork } from "../tests/harness.js";
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
const LONG_TOKEN = "x".repeat(200);

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

// issue #1113: memory の帰責(cause・#id リンク群・evidence)は異議コメントの下の独立した行に置かれ、
// `#id` は番号の途中で割れない。実運用に近い4桁の id を10件名指し、約200字の evidence を付ける。
const CAUSE_ENTRY_IDS = Array.from({ length: 10 }, (_, i) => 1004 + i);
const LONG_EVIDENCE = "followed the stale note about squashing ".repeat(5).trim();

for (const band of ["bundled", "plain"] as const) {
  test(`スマホ幅で memory の帰責が異議コメントの下の行に置かれ、#id が途中で割れず行がはみ出さない(${band} の帯、issue #1113)`, async ({
    boot,
    page,
  }) => {
    const t = await boot();
    await page.setViewportSize({ width: 390, height: 844 });
    const work = await registerWork(t, `帰責の配置 ${band}`);
    await t.clock.advance(HOUR);
    const decided = await loggedEntry(t, work.id, `帰責の配置の対象 ${band}`);
    await memoryAttributedObjection(t, work.id, decided.id, CAUSE_ENTRY_IDS, LONG_EVIDENCE);
    // plain の帯: 束ね済みの異議の後にもう1つ異議を打つと、帰責は plain の帯に付く
    if (band === "plain") await object(t, decided.id, "plain の異議コメント");

    await page.goto(t.baseUrl);
    const row = page.locator(".tp-log-entry").filter({ hasText: `帰責の配置の対象 ${band}` });
    const comment = band === "plain" ? row.getByText("objection: plain の異議コメント") : row.getByText("そのメモが間違っています");
    await expect(row.getByRole("link", { name: `#${CAUSE_ENTRY_IDS[9]}` })).toBeVisible();

    const [scrollWidth, clientWidth] = await row.evaluate((el) => [el.scrollWidth, el.clientWidth]);
    expect(scrollWidth, `scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth);
    const rects = await row.getByRole("link").evaluateAll((els) => els.map((el) => el.getClientRects().length));
    expect(rects).toEqual(CAUSE_ENTRY_IDS.map(() => 1));
    const commentBottom = await comment.evaluate((el) => el.getBoundingClientRect().bottom);
    const causeTop = await row.getByText("cause: memory").evaluate((el) => el.getBoundingClientRect().top);
    expect(causeTop, `cause top ${causeTop} < comment bottom ${commentBottom}`).toBeGreaterThanOrEqual(commentBottom);
  });
}
