import type { Locator, Page } from "@playwright/test";
import { api, HOUR, mcpClient, registerQuestion, registerWork, type Tidepool } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// #3204: 回答の拒否文は消える toast でなく、拒まれた question のカードの中に次の送信まで残る(方向は #3191)。

/** toast の自動消去(webui/app.tsx の App の `setTimeout(dismissToast, 3200)`)を過ぎるまで待つ長さ。 */
const PAST_TOAST_DISMISS_MS = 3500;

/** Submit を押し、盤面が返した拒否の status と文を返す。 */
async function submitRefused(page: Page, card: Locator) {
  const refused = page.waitForResponse((r) => r.url().endsWith("/answer"));
  await card.getByRole("button", { name: "Submit" }).click();
  const response = await refused;
  return { status: response.status(), error: (await response.json()).error as string };
}

function whichWayQuestion(t: Tidepool) {
  return registerQuestion(t, {
    title: "which way?",
    purpose: "an agent escalated a decision",
    completion_criteria: "the answer is recorded",
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });
}

/** 着地 question を盤面の DB へ直に立てる(triage-merge-decision-step.spec.ts と同じ形)。workspace の無い盤面では
 *  merge の回答は盤面に拒まれ、hold は通る —— 実際の API が拒む、答え直せる拒否。 */
function landQuestion(t: Tidepool, taskId: string, title: string) {
  return registerQuestion(t, {
    title,
    purpose: "the completed task branch awaits a merge decision",
    completion_criteria: "a human decides whether to land the completed task branch",
    question: [{ title, options: ["merge", "hold"], recommendation: "merge" }],
    question_kind: { kind: "local_merge", task_id: taskId },
  });
}

test("merge の段で拒まれた着地 question の拒否文はカードに残り、段を往復しても消えず、答え直すと消えて回答済みになる", async ({ boot, page }) => {
  const t = await boot();
  const work = await registerWork(t, "the branch that waits to land");
  const title = "land completed task: the branch that waits to land";
  const question = landQuestion(t, work.id, title);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Merge decisions" }).click();
  const card = page.getByTestId(`question-card-${question.id}`);
  await card.getByRole("button", { name: /^merge/ }).click();
  const { status, error } = await submitRefused(page, card);
  expect(status).toBe(409);

  await expect(card.getByRole("alert")).toHaveText(error);
  await expect(page.getByText("answer failed")).toHaveCount(0);
  await page.waitForTimeout(PAST_TOAST_DISMISS_MS);
  await expect(card.getByRole("alert")).toHaveText(error);

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText("2 / 5 — decision log")).toBeVisible();
  await page.getByRole("button", { name: "Merge decisions" }).click();
  await expect(card.getByRole("alert")).toHaveText(error);

  await card.getByRole("button", { name: /^hold/ }).click();
  await card.getByRole("button", { name: "Submit" }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Submit" })).toHaveCount(0);
});

test("拒否を持つ着地 question が merge の段に入り直して回答不能の側へ移っても、その行に拒否文が出る", async ({ boot, page }) => {
  const t = await boot();
  const work = await registerWork(t, "the objected branch");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, work.id);
  await client.callTool({ name: "log_decision", arguments: { line: "異議を打たれる判断" } });
  await client.close();
  const title = "land completed task: the objected branch";
  const question = landQuestion(t, work.id, title);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Merge decisions" }).click();
  const card = page.getByTestId(`question-card-${question.id}`);
  await card.getByRole("button", { name: /^merge/ }).click();
  const { error } = await submitRefused(page, card);
  await expect(card.getByRole("alert")).toHaveText(error);

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByText("異議を打たれる判断").click();
  await page.getByRole("textbox").fill("この判断のまま着地させたくない");
  await page.getByRole("button", { name: "Object", exact: true }).click();
  await page.getByRole("button", { name: "Merge decisions" }).click();

  await expect(page.getByText("1 landing question not yet answerable — objections await commit")).toBeVisible();
  await expect(page.getByRole("button", { name: /^merge/ })).toHaveCount(0);
  await expect(page.getByTestId(`landing-refusal-${question.id}`)).toContainText(question.id);
  await expect(page.getByTestId(`landing-refusal-${question.id}`).getByRole("alert")).toHaveText(error);
});

// 空白を含まない長い path・コマンドと改行を運ぶ回答の拒否は安く起こせないので、最初の送信だけ差し込む
test("一般 question の段の拒否文は改行を保ち長い path も枠の中で折り返し、入力を残し、段を往復しても残り、答え直して通ればカードは回答済みになる", async ({ boot, page }) => {
  const t = await boot();
  const question = whichWayQuestion(t);
  const path = `/srv/tidepool/workbenches/${"deepsegment".repeat(30)}`;
  const refusal = `task/x does not merge cleanly into 'main'.\nIn the workbench at ${path}, run \`git merge board/main\`, then answer again.`;
  let refuseOnce = true;
  await page.route(`**/api/tasks/${question.id}/answer`, async (route) => {
    if (!refuseOnce) return route.continue();
    refuseOnce = false;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: refusal }) });
  });

  await page.goto(t.baseUrl);
  const card = page.getByTestId(`question-card-${question.id}`);
  await card.getByRole("button", { name: /^left/ }).click();
  await card.getByLabel("Comment (optional)").fill("go left");
  await card.getByRole("button", { name: "Submit" }).click();

  const alert = card.getByRole("alert");
  await expect(alert).toHaveText(refusal);
  // toHaveText は空白を畳むので、改行が保たれているかは描かれた文そのもので見る
  expect(await alert.innerText()).toBe(refusal);
  await expect(page.getByText("answer failed")).toHaveCount(0);
  const [cardBox, alertBox] = [await card.boundingBox(), await alert.boundingBox()];
  expect(alertBox!.x + alertBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
  expect(await alert.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(card.getByLabel("Comment (optional)")).toHaveValue("go left");
  await expect(card.getByRole("button", { name: "Submit" })).toBeEnabled();
  await page.waitForTimeout(PAST_TOAST_DISMISS_MS);
  await expect(alert).toHaveText(refusal);

  await page.getByRole("button", { name: /^Log skim/ }).click();
  await expect(page.getByText("2 / 5 — decision log")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(alert).toHaveText(refusal);

  await card.getByRole("button", { name: /^left/ }).click();
  await card.getByRole("button", { name: "Submit" }).click();
  await expect(alert).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Submit" })).toHaveCount(0);
});

test("単独 question 画面の拒否文はカードの中にだけ出て次の送信まで残る(画面下の固定表示は無い)", async ({ boot, page }) => {
  const t = await boot();
  const question = whichWayQuestion(t);

  await page.goto(`${t.baseUrl}/?question=${question.id}`);
  await page.getByRole("button", { name: /^left/ }).click();
  // 画面を開いた後に別の扉が答える —— この画面の送信は盤面に実際に拒まれる
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["right"] });
  const card = page.getByTestId(`question-card-${question.id}`);
  const { status, error } = await submitRefused(page, card);
  expect(status).toBe(409);

  await expect(card.getByRole("alert")).toHaveText(error);
  await expect(page.getByText(error)).toHaveCount(1);
  await page.waitForTimeout(PAST_TOAST_DISMISS_MS);
  await expect(card.getByRole("alert")).toHaveText(error);

  // 次の送信は別の拒否文で置き換わる —— 同じ盤面の拒否は同じ文なので、違う文は差し込んで見分ける
  const next = "a second refusal for the next submit";
  await page.route(`**/api/tasks/${question.id}/answer`, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: next }) }));
  await card.getByRole("button", { name: "Submit" }).click();
  await expect(card.getByRole("alert")).toHaveText(next);
  await expect(page.getByText(error)).toHaveCount(0);
});
