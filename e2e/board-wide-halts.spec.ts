import { HOUR, registerWork } from "../tests/harness.js";
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
