import { api } from "../tests/harness.js";
import { expect, test, workspaceList } from "./fixtures.js";

// ADR 0110 決定1 で agent.md から model / effort が消え、ADR 0410 決定3 で段も agent フォームから消えて、draft の
// 形が `{advisor: boolean}` になった。この層は vitest が守らない(ADR 0027 / 0029)—— 実際、消えたフィールドを
// 読み続けた dirty 判定が編集フォームを描画のたびに TypeError で落としており、サーバー境界のテストは全部緑の
// ままだった。恒久 smoke にしているのはその面である: 盤面の既定ティアが表示に出て、フォームに段の select は無く、
// advisor のチェックボックスの編集で Save が有効になること。

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
    advisor: true,
  },
  // 既定ティアも advisor も持たない agent —— 盤面既定に委ねた側の見え方
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

test("盤面の既定ティアと advisor を持つ agent は両方を見せ、フォームに段の select は無い", async ({ boot, page }) => {
  const t = await boot(seams);
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "agent_tier", agent: "reef-crab", tier: "frontier" })).status).toBe(200);
  await page.goto(t.baseUrl);
  await openAgents(page);
  await page.getByTestId("settings-record-agents-reef-crab").click();

  await expect(page.getByText("frontier")).toBeVisible();
  await expect(page.getByText("yes")).toBeVisible();

  // 編集フォームが描画されること自体が主張の半分 —— 消えたフィールドを読む
  // dirty 判定はここで落ちていた
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(saveButton(page)).toBeDisabled();
  await expect(page.getByLabel("Default tier")).toHaveCount(0);
  await page.getByLabel(/^advisor/).uncheck();
  await expect(saveButton(page)).toBeEnabled();
});

test("既定ティアも advisor も持たない agent は既定の見え方を出し、advisor のトグルで Save が開く", async ({ boot, page }) => {
  const t = await boot(seams);
  await page.goto(t.baseUrl);
  await openAgents(page);
  await page.getByTestId("settings-record-agents-anemone").click();

  await expect(page.getByText("board default")).toBeVisible();
  await expect(page.getByText("no advisor")).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(saveButton(page)).toBeDisabled();
  await page.getByLabel(/^advisor/).check();
  await expect(saveButton(page)).toBeEnabled();
});

test("新規 agent フォームも advisor のチェックボックスを持ち段の select を持たず、描画で落ちない", async ({ boot, page }) => {
  const t = await boot(seams);
  await page.goto(t.baseUrl);
  await openAgents(page);
  await page.getByRole("button", { name: "Add" }).click();

  await expect(page.getByLabel(/^advisor/)).toBeVisible();
  await expect(page.getByLabel("Default tier")).toHaveCount(0);
  // model / effort はもう入力面に無い(ADR 0110 決定1 —— 表が決める)。exact
  // でないと advisor の説明文に含まれる "model" を拾う
  await expect(page.getByLabel("Model", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Effort", { exact: true })).toHaveCount(0);
});
