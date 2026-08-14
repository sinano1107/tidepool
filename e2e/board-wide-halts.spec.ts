import { quarantineCliAuth } from "../src/cli-auth.js";
import { openDb } from "../src/db.js";
import { usagePanelText } from "../tests/fakes.js";
import { api, HOUR, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

test("Pause 中の queue ↑ は操作を隠さず、slot と toast が停止理由を名指す(ADR 0058)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await registerWork(t, "waits for resume");

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await page.getByRole("button", { name: "pause pickup" }).click();
  await expect(page.getByText("pickup paused — nothing starts until resumed")).toBeVisible();

  await page.getByRole("button", { name: "↑", exact: true }).click();
  await expect(page.getByText("moved to front — pickup is paused")).toBeVisible();
  await expect(page.getByText("resume to run it")).toBeVisible();
});

test("封じ込め能力が不成立なら slot と queue ↑ の toast が同じ停止理由を示す(ADR 0058)", async ({
  boot,
  page,
}) => {
  const t = await boot({
    sandboxCapability: () => ({ available: false, reason: "sandbox unavailable" }),
  });
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

test("Claude 認証が失効したら slot と queue ↑ の toast が同じ停止理由を示す(ADR 0070)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const db = openDb(`${t.dir}/board.sqlite`);
  quarantineCliAuth(db, t.clock.now());
  db.close();
  await registerWork(t, "waits for Claude authentication repair");

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("Claude authentication unavailable · nothing starts")).toBeVisible();
  await page.getByRole("button", { name: "↑", exact: true }).click();
  await expect(page.getByText("Claude authentication is unavailable")).toBeVisible();
});

test("usage 観測が遅い queue ↑ は pickup 成功を名乗らず、再評価中を slot と toast に示す(ADR 0058)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await registerWork(t, "waits for a fresh usage observation");
  let release!: () => void;
  t.worker.scriptUsageGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await page.getByRole("button", { name: "↑", exact: true }).click();
  await expect(page.getByText("moved to front — usage is being re-evaluated")).toBeVisible();
  await expect(page.getByText("usage re-evaluation in progress · nothing starts")).toBeVisible();

  release();
  await expect(page.getByText("usage re-evaluation in progress · nothing starts")).not.toBeVisible({
    timeout: 5_000,
  });
});

// ADR 0068 決定6/決定7 の裏側: 盤面全体の停止が行から消えた代わりに、資源単位の
// 停止(quarantine・fable 線)が初めてブラウザに現れる。面は流れているので
// スロット行は「止まっている」とは言わない。
test("fable 線で止まった行だけがキューで減光し、盤面は流れ続けると slot が言う(ADR 0068)", async ({
  boot,
  page,
}) => {
  const t = await boot({ fableAgents: () => ["fable-artisan"] });
  const now = t.clock.now();
  await registerWork(t, "paced fable work", undefined, undefined, "fable-artisan");
  // session/week は健全、fable 線だけ超過 — tests/throttle.test.ts と同じ観測
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 0, resetsAt: new Date(now.getTime() + 3 * HOUR) },
      week: { percent: 5, resetsAt: new Date(now.getTime() + 2 * 24 * HOUR) },
      fable: { percent: 84, resetsAt: new Date(now.getTime() + 12 * HOUR) },
    }),
  );
  await t.clock.advance(HOUR);

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("slot free — fable tasks paced")).toBeVisible();
  await expect(page.getByText("skipped", { exact: true })).toBeVisible();
});

// 決定1 の並び順は interface である。以前はキュー画面の pausedSlot がスロット行を
// 作り直していたため、triage と Pause が同時に立つとサーバ順序を画面が上書きして
// いた。行の作成をやめた今、先頭(triage)がそのまま出る。
test("triage と Pause が同時なら slot はサーバ順序の先頭(triage)を描く(ADR 0068 決定1)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await registerWork(t, "waits behind both halts");
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
// (issue #34)。pausedSlot から app.jsx へ移した分岐の pin。
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
