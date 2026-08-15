import { FakeDraftClient } from "../tests/fakes.js";
import { api, type Tidepool } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

// 親を塞ぐ human タスクの完了(issue #13 / #301)。孤立行のワンタップは
// your-tasks-completion.spec.ts が持ち、こちらはもう一方の扉 —— ハンドオフ下書きを
// 挟む経路を押さえる。2つの扉の分岐がこのスライスの主題なので、両方に錘を置く。

const ROOT = { type: "work", purpose: "p", completion_criteria: "c" } as const;
const PARENT_TITLE = "parent work";
const CHILD_TITLE = "sign the paperwork";

/** 親 → それを塞ぐ human の子、という最小の木。子の id ではなく親の id を返すのは、
 *  行が名指す `blocks <parent>` の相手がそれだから。 */
async function blockingTree(t: Tidepool): Promise<string> {
  const parent = await api(t.baseUrl, "POST", "/api/tasks", { ...ROOT, title: PARENT_TITLE });
  await api(t.baseUrl, "POST", "/api/tasks", {
    ...ROOT,
    title: CHILD_TITLE,
    assignee: "human",
    parent_id: parent.json.id,
    decompose_reason: "the signature is mine to give",
  });
  return parent.json.id;
}

test("親を塞ぐ human タスクの Done は完了ダイアログを開き、draft が6項目を埋めて欠落欄に警告を出す", async ({
  boot,
  page,
}) => {
  const draftClient = new FakeDraftClient();
  // 6項目のうち4つだけ埋まる下書き —— 残る2つが `missing` として返る
  draftClient.scriptHandoffDraft({
    outcome: "greenhouse watered — criteria met",
    deliverables: "the greenhouse itself",
    dead_ends: "the hose kinked at the spigot",
    resume_context: "the spare hose lives in the shed",
  });
  const t = await boot({ draftClient });
  const parentId = await blockingTree(t);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText(`blocks ${parentId}`)).toBeVisible();

  // Done は Your tasks の行にしか無い(この時点でダイアログは閉じている)
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "Complete task" })).toBeVisible();

  await page.getByLabel("How did it go?").fill("watered it, the hose kinked");
  await page.getByRole("button", { name: "Draft handoff" }).click();

  await expect(page.getByLabel("outcome vs criteria")).toHaveValue(
    "greenhouse watered — criteria met",
  );
  await expect(page.getByLabel("key decision refs")).toHaveValue("");
  // 埋まらなかった2欄だけが警告を出す —— 強制はしない
  await expect(page.getByText("the draft found nothing for this")).toHaveCount(2);

  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(CHILD_TITLE)).toHaveCount(0);
});

test("draft client 不在(503)でもダイアログは使え、欄が空のまま完了して親が blocked から外れる", async ({
  boot,
  page,
}) => {
  // draftClient を差さない = LLM 未設定。/complete/draft は必ず 503 を返す
  const t = await boot();
  await blockingTree(t);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  // derived-blocked な行だけが「なぜ飛ばされるか」の tooltip を持つ —— この状態に
  // ロールベースの手がかりは無いので、その属性が唯一の機械可読な印
  const blockedParent = page.locator('div[title^="blocked"]').filter({ hasText: PARENT_TITLE });
  await expect(blockedParent).toHaveCount(1);

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "Complete task" })).toBeVisible();

  await page.getByLabel("How did it go?").fill("signed it");
  await page.getByRole("button", { name: "Draft handoff" }).click();
  await expect(page.getByText("no draft — fill it in yourself")).toBeVisible();

  // 下書きを諦めても欄は使える。空のままでも完了できる(human タスクの免除)
  await expect(page.getByLabel("outcome vs criteria")).toHaveValue("");
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();

  await expect(page.getByText(CHILD_TITLE)).toHaveCount(0);
  // アンブロックはサーバの仕事 —— ブラウザは取り直すだけ
  await expect(blockedParent).toHaveCount(0);
});
