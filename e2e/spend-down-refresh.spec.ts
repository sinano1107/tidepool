import { usagePanelText } from "../tests/fakes.js";
import { api, HOUR, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

const MIN = 60 * 1000;

test("spend-down の有効化・取り消しは、再評価中を示して新しい観測へ追従し、完了後は追従を止める(#227 / ADR 0058)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 85, resetsAt },
      week: { percent: 85, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );
  await registerWork(t, "waits behind both pace lines");
  await t.clock.advance(HOUR);

  let pauseReads = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url() === `${t.baseUrl}/api/pause`) pauseReads++;
  });
  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText(/session \+ week line · resumes/)).toBeVisible();
  await expect(page.getByText(/observed \d{2}:\d{2}/)).toBeVisible();

  let release!: () => void;
  t.worker.scriptUsageGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await page.getByRole("button", { name: "session", exact: true }).click();
  await expect(page.getByText("usage re-evaluation in progress · nothing starts")).toBeVisible();
  await expect(page.getByText(/last observed \d{2}:\d{2}/)).toBeVisible();

  release();
  await expect(page.getByText(/week line · resumes/)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("usage re-evaluation in progress · nothing starts")).not.toBeVisible();
  const readsAfterEnable = pauseReads;
  await page.waitForTimeout(2_300);
  expect(pauseReads).toBe(readsAfterEnable);

  await t.clock.advance(MIN);
  t.worker.scriptUsageGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await page.getByRole("button", { name: "cancel", exact: true }).click();
  await expect(page.getByText("usage re-evaluation in progress · nothing starts")).toBeVisible();

  release();
  await expect(page.getByText(/session \+ week line · resumes/)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("usage re-evaluation in progress · nothing starts")).not.toBeVisible();
  const readsAfterCancel = pauseReads;
  await page.waitForTimeout(2_300);
  expect(pauseReads).toBe(readsAfterCancel);

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.throttle.observedAt).toBe(
    t.clock.now().toISOString(),
  );
});
