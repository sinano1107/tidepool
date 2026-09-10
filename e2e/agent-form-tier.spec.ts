import { expect, test, workspaceList } from "./fixtures.js";

// ADR 0110 決定1 で agent.md から model / effort が消え、draft の形が
// `{tier, advisor: boolean}` になった。この層は vitest が守らない(ADR 0027 /
// 0029)—— 実際、消えたフィールドを読み続けた dirty 判定が編集フォームを描画の
// たびに TypeError で落としており、サーバー境界のテストは全部緑のままだった。
// 恒久 smoke にしているのはその面である: tier の select と advisor の
// チェックボックスが描画され、どちらの編集でも Save が有効になること。

const AGENTS = [
  {
    name: "reef-crab",
    version: "1",
    authority: "implementer",
    provider: "anthropic",
    description: "implementation work",
    icon: "🦀",
    skills: ["@workspace"],
    systemPrompt: "Prefers small commits.",
    tier: "frontier",
    advisor: true,
  },
  // tier / advisor を書かない agent —— 盤面既定に委ねた側の見え方
  {
    name: "anemone",
    version: "1",
    authority: "implementer",
    provider: "anthropic",
    description: "review only",
    icon: "🪸",
    skills: ["@workspace"],
  },
];

const PROFILES = [
  { name: "implementer", guidance: "g", assignable_to: ["*"], allowed_workspaces: ["*"], merge: "escalate" },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
const seams = {
  workspaceAdmin: { list: () => workspaceList([]) as any },
  agentAdmin: { list: () => AGENTS as any, authorityProfiles: () => ["implementer"] },
  profileAdmin: { list: () => PROFILES as any },
  hostSkills: async () => ["deep-research"],
} as any;

const openAgents = async (page: any) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-section-agents").click();
};

const saveButton = (page: any) => page.getByRole("button", { name: /^Save changes/ });

test("tier と advisor を持つ agent は両方を見せ、tier の変更で Save が開く", async ({ boot, page }) => {
  const t = await boot(seams);
  await page.goto(t.baseUrl);
  await openAgents(page);
  await page.getByTestId("settings-record-agents-reef-crab").click();

  await expect(page.getByText("frontier")).toBeVisible();
  await expect(page.getByText("yes")).toBeVisible();

  // 編集フォームが描画されること自体が主張の半分 —— 消えたフィールドを読む
  // dirty 判定はここで落ちていた
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(saveButton(page)).toBeDisabled();
  await page.getByLabel("Default tier").selectOption("economy");
  await expect(saveButton(page)).toBeEnabled();
});

test("tier も advisor も書かない agent は既定の見え方を出し、advisor のトグルで Save が開く", async ({ boot, page }) => {
  const t = await boot(seams);
  await page.goto(t.baseUrl);
  await openAgents(page);
  await page.getByTestId("settings-record-agents-anemone").click();

  await expect(page.getByText("board default")).toBeVisible();
  await expect(page.getByText("no advisor")).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(saveButton(page)).toBeDisabled();
  // DS の Checkbox は本物の input を視覚的に隠すので、testId は label 側に付いている
  await page.getByTestId("agent-advisor").click();
  await expect(saveButton(page)).toBeEnabled();
});

test("新規 agent フォームも同じ2つの入力を持ち、描画で落ちない", async ({ boot, page }) => {
  const t = await boot(seams);
  await page.goto(t.baseUrl);
  await openAgents(page);
  await page.getByRole("button", { name: "Add" }).click();

  await expect(page.getByLabel("Default tier")).toBeVisible();
  await expect(page.getByTestId("agent-advisor")).toBeVisible();
  // model / effort はもう入力面に無い(ADR 0110 決定1 —— 表が決める)。exact
  // でないと advisor の説明文に含まれる "model" を拾う
  await expect(page.getByLabel("Model", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Effort", { exact: true })).toHaveCount(0);
});
