import { FakeContainerRuntime } from "../tests/fakes.js";
import { api, HOUR, queueWork, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

test("Pause 中の queue ↑ は操作を隠さず、slot と toast が停止理由を名指す(ADR 0058)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  queueWork(t, "waits for resume");

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await page.getByRole("button", { name: "pause pickup" }).click();
  await expect(page.getByText("pickup paused — nothing starts until resumed")).toBeVisible();

  await page.getByRole("button", { name: "↑", exact: true }).click();
  await expect(page.getByText("moved to front — pickup is paused")).toBeVisible();
  await expect(page.getByText("resume to run it")).toBeVisible();
});

test("容器機構が不成立なら slot と queue ↑ の toast が同じ停止理由を示す(ADR 0058)", async ({
  boot,
  page,
}) => {
  const containers = new FakeContainerRuntime();
  containers.scriptPreflight("container runtime unavailable");
  const t = await boot({ containerRuntime: containers });
  await registerWork(t, "waits for containment repair");

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("worker containment unavailable · nothing starts")).toBeVisible();
  await page.getByRole("button", { name: "↑", exact: true }).click();
  await expect(page.getByText("worker containment is not established")).toBeVisible();
});

test("registry remote に到達できなければ slot と queue ↑ の toast が同じ停止理由を示す(ADR 0058)", async ({
  boot,
  page,
}) => {
  const t = await boot({
    registryReachability: async () => ({ available: false, reason: "origin unreachable" }),
  });
  await registerWork(t, "waits for registry repair");
  await t.clock.advance(HOUR);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("registry remote unreachable · nothing starts")).toBeVisible();
  await page.getByRole("button", { name: "↑", exact: true }).click();
  await expect(page.getByText("registry remote is unreachable")).toBeVisible();
});

// 決定1 の並び順は interface である。以前はキュー画面の pausedSlot がスロット行を
// 作り直していたため、triage と Pause が同時に立つとサーバ順序を画面が上書きして
// いた。行の作成をやめた今、先頭(triage)がそのまま出る。
test("triage と Pause が同時なら slot はサーバ順序の先頭(triage)を描く(ADR 0068 決定1)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  queueWork(t, "waits behind both halts");
  await api(t.baseUrl, "POST", "/api/triage/start");

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("triage in progress · nothing starts")).toBeVisible();
  await page.getByRole("button", { name: "pause pickup" }).click();
  await expect(page.getByRole("button", { name: "resume pickup" })).toBeVisible();
  await expect(page.getByText("triage in progress · nothing starts")).toBeVisible();
  await expect(page.getByText("pickup paused — nothing starts until resumed")).toHaveCount(0);
});

// Pause だけは実行中タスクの上でも喋る — 言うことがそのタスクの行く末だから
// (issue #34)。pausedSlot から app.tsx へ移した分岐の pin。
test("実行中に Pause すると slot が「完走して後が続かない」と言う(issue #34)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await registerWork(t, "already running");
  await t.clock.advance(HOUR); // picked up — the fake worker never finishes it

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await page.getByRole("button", { name: "pause pickup" }).click();
  await expect(page.getByText("pickup paused · task finishes, nothing new starts")).toBeVisible();
});
