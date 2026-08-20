import { usagePanelText } from "../tests/fakes.js";
import { api, HOUR, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

const MIN = 60 * 1000;

test("spend-down の有効化・取り消しは、再評価中を示して新しい観測結果を引き取る(#227 / ADR 0058)", async ({
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
  await page.getByRole("button", { name: "arm session", exact: true }).click();
  await expect(page.getByText("usage re-evaluation in progress · nothing starts")).toBeVisible();
  await expect(page.getByText(/last observed \d{2}:\d{2}/)).toBeVisible();

  release();
  await expect(page.getByText(/week line · resumes/)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("usage re-evaluation in progress · nothing starts")).not.toBeVisible();

  await t.clock.advance(MIN);
  t.worker.scriptUsageGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await page.getByRole("button", { name: "cancel session", exact: true }).click();
  await expect(page.getByText("usage re-evaluation in progress · nothing starts")).toBeVisible();

  release();
  await expect(page.getByText(/session \+ week line · resumes/)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("usage re-evaluation in progress · nothing starts")).not.toBeVisible();

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.throttle.observedAt).toBe(
    t.clock.now().toISOString(),
  );
});
