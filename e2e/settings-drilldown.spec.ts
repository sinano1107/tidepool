import { expect, test } from "./fixtures.js";

// Issue #208 で昇格した恒久 smoke。目次 → 各セクション → レコード → Edit → Cancel、
// unavailable の見え方と未保存破棄ガードを実ブラウザで通す。

const WORKSPACES = [
  {
    name: "tidepool",
    repo: "github.com/masaki/tidepool",
    branch: "main",
    notes: "the board's own registry clone",
    protected: true,
    registrySelf: true,
  },
  { name: "sandbox", path: "/home/masaki/sandbox", notes: "", registrySelf: false },
];

const AGENTS = [
  {
    name: "reef-crab",
    version: "1",
    authority: "implementer",
    description: "implementation work",
    icon: "🦀",
    skills: ["@workspace", "docs:*"],
    systemPrompt: "Prefers small commits.",
  },
  {
    name: "anemone",
    version: "1",
    authority: "reviewer",
    description: "review only",
    icon: "🪸",
    skills: ["@workspace"],
    model: "sonnet",
  },
];

const PROFILES = [
  {
    name: "implementer",
    guidance: "full read/write in assigned workspaces",
    assignable_to: ["reef-crab"],
    allowed_workspaces: ["tidepool"],
    merge: "escalate",
  },
  { name: "reviewer", guidance: "read-only", assignable_to: ["anemone"], allowed_workspaces: ["*"] },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
const seams = {
  workspaceAdmin: { list: () => WORKSPACES as any },
  agentAdmin: {
    list: () => AGENTS as any,
    authorityProfiles: () => ["implementer", "reviewer"],
  },
  profileAdmin: { list: () => PROFILES as any },
  hostSkills: async () => ["review", "docs"],
} as any;

test("index → section → record → edit → cancel", async ({ boot, page }) => {
  const scriptRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scriptRequests.push(request.url());
  });
  const t = await boot(seams);
  const boardOrigin = new URL(t.baseUrl).origin;
  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();

  // level 1: 4 行の目次。各行が現在値の要約を持つ
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByTestId("settings-section-board")).toBeVisible();
  await expect(page.getByTestId("settings-section-workspaces")).toContainText("2 · 1 protected");
  await expect(page.getByTestId("settings-section-agents")).toContainText("2 agents");
  await expect(page.getByTestId("settings-section-profiles")).toContainText("2 profiles");
  expect(scriptRequests.filter((url) => new URL(url).origin !== boardOrigin)).toEqual([]);

  // 閲覧が主: 目次に入力部品は一切無い
  expect(await page.locator("input, select, textarea").count()).toBe(0);

  // level 2: Agents
  await page.getByTestId("settings-section-agents").click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(page.getByTestId("settings-record-agents-reef-crab")).toBeVisible();
  expect(await page.locator("input, select, textarea").count()).toBe(0);

  // level 3: 1 レコード。閲覧表示のみで入力部品は無い
  await page.getByTestId("settings-record-agents-reef-crab").click();
  await expect(page.getByRole("heading", { name: "reef-crab" })).toBeVisible();
  await expect(page.getByText("implementation work")).toBeVisible();
  await expect(page.getByText("Prefers small commits.")).toBeVisible();
  await expect(page.getByText("adapter default").first()).toBeVisible(); // model 未設定
  await expect(page.getByText("docs:*")).toBeVisible();
  expect(await page.locator("input, select, textarea").count()).toBe(0);

  // Edit → 編集フォーム。Save は未変更なので不活性、Cancel は常時
  await page.getByRole("button", { name: "Edit" }).click();
  const save = page.getByRole("button", { name: "Save changes — commits to the registry" });
  await expect(save).toBeDisabled();
  await page.getByPlaceholder("adapter default if empty").first().fill("opus");
  await expect(save).toBeEnabled();

  // Cancel は明示的な破棄なので確認を挟まず閲覧に戻る(確認は「別カード/画面/タブへ
  // 移る」経路だけ — 決定4)
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  expect(await page.locator("input, select, textarea").count()).toBe(0);

  // 戻る導線
  await page.getByRole("button", { name: "Agents" }).first().click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(page.getByTestId("settings-section-workspaces")).toBeVisible();
});

test("workspace record shows origin, protection and the add form behind Add", async ({ boot, page }) => {
  const t = await boot(seams);
  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-section-workspaces").click();

  // Add は作成フォームを開く(常時開放の作成フォームは廃止)
  expect(await page.locator("input, select, textarea").count()).toBe(0);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("button", { name: "Add workspace — commits to the registry" })).toBeDisabled();
  await page.getByRole("button", { name: "Close" }).click();
  expect(await page.locator("input, select, textarea").count()).toBe(0);

  // レコード: repo · branch と protected の読み取り表示
  await page.getByTestId("settings-record-workspaces-tidepool").click();
  await expect(page.getByText("github.com/masaki/tidepool · main")).toBeVisible();
  await expect(page.getByText("protected", { exact: true }).first()).toBeVisible();
  expect(await page.locator("input, select, textarea").count()).toBe(0);
});

test("profile record renders tags and the wildcard", async ({ boot, page }) => {
  const t = await boot(seams);
  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-section-profiles").click();
  await page.getByTestId("settings-record-profiles-reviewer").click();
  await expect(page.getByText("read-only")).toBeVisible();
  await expect(page.getByText("* — every workspace")).toBeVisible();
  await expect(page.getByText("merge authority", { exact: true })).toBeVisible();
});

test("an unreachable registry says so on the index, not behind a lie", async ({ boot, page }) => {
  const t = await boot(); // seam 無し → registry 未設定
  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("settings-section-workspaces")).toContainText("no registry configured");
  await page.getByTestId("settings-section-workspaces").click();
  await expect(page.getByText(/no registry configured on this board/)).toBeVisible();
  // Add は出さない
  await expect(page.getByRole("button", { name: "Add" })).toHaveCount(0);
});

test("a tab switch with unsaved changes asks first", async ({ boot, page }) => {
  const t = await boot(seams);
  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-section-profiles").click();
  await page.getByTestId("settings-record-profiles-implementer").click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByPlaceholder("how an agent carrying this authority should act").fill("changed");

  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("Discard unsaved changes?")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByRole("heading", { name: "implementer" })).toBeVisible();

  await page.getByRole("button", { name: "Queue" }).click();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("heading", { name: "implementer" })).toHaveCount(0);
});

// Keep editing のあとも編集は開いたまま — そこから画面内を移る経路が
// もう一度きちんと訊きにくるか(editing が孤児にならないか)
test("keep editing leaves the slot intact for the next move", async ({ boot, page }) => {
  const t = await boot(seams);
  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-section-profiles").click();
  await page.getByTestId("settings-record-profiles-implementer").click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByPlaceholder("how an agent carrying this authority should act").fill("changed");

  // 1回目: タブ切替を止める
  await page.getByRole("button", { name: "Queue" }).click();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByPlaceholder("how an agent carrying this authority should act")).toHaveValue("changed");

  // 2回目: 画面内の「戻る」も同じように訊いてくる
  await page.getByRole("button", { name: "Authority Profiles" }).first().click();
  await expect(page.getByText("Discard unsaved changes?")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing" }).click();

  // 3回目: 破棄すると一覧へ抜け、編集スロットは空になっている
  await page.getByRole("button", { name: "Authority Profiles" }).first().click();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("heading", { name: "Authority Profiles" })).toBeVisible();
  expect(await page.locator("input, select, textarea").count()).toBe(0);

  // スロットが空なので、次のタブ切替はもう訊かない
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("Discard unsaved changes?")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Authority Profiles" })).toHaveCount(0);
});
