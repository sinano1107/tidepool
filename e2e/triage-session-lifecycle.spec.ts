import { api, HOUR, registerQuestion, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

test("未読のある Triage を描画しても pickup は止まらない(issue #225)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const skimmed = await registerWork(t, "skimmed human work", undefined, false, "human");
  await api(t.baseUrl, "POST", `/api/tasks/${skimmed.id}/complete`, {});
  await registerWork(t, "still pickable after a skim");

  await page.goto(t.baseUrl);
  await expect(page.getByText("1 decisions made overnight.")).toBeVisible();
  await expect
    .poll(async () => {
      const events = (await api(t.baseUrl, "GET", `/api/tasks/${skimmed.id}/events`)).json;
      return events.some((event: { kind: string }) => event.kind === "log_entry_displayed");
    })
    .toBe(true);

  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.title)).toEqual(["still pickable after a skim"]);
});

test("Triage の最初の回答でセッションが開き pickup が止まる(issue #225)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  const work = await registerWork(t, "blocked once steering starts");
  const question = registerQuestion(t, {
    title: "which way?",
    purpose: "choose a direction",
    completion_criteria: "the choice is recorded",
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });

  await page.goto(t.baseUrl);
  const answer = page.getByRole("button", { name: /^left/ });
  await answer.click();
  await expect
    .poll(async () => (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status)
    .toBe("done");

  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).not.toBe(null);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).not.toBe(null);
  await api(t.baseUrl, "POST", `/api/tasks/${work.id}/move`, { after: null });
  expect(t.worker.started).toEqual([]);
});

test("開いている triage session 中に queue の ↑ を押すと、停止理由と解除口が全タブで見える(#225 / ADR 0058)", async ({
  boot,
  page,
}) => {
  const t = await boot();
  await registerWork(t, "blocked by the active triage");
  await api(t.baseUrl, "POST", "/api/triage/start");

  await page.goto(t.baseUrl);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByText("triage in progress · nothing starts")).toBeVisible();
  await page.getByRole("button", { name: "↑", exact: true }).click();

  await expect(page.getByText("moved to front — pickup blocked")).toBeVisible();
  await expect(page.getByText("triage in progress — commit it to resume")).toBeVisible();
  await expect(page.getByText("triage in progress — pickup is stopped")).toBeVisible();
  await page.getByRole("button", { name: "Board" }).click();
  await expect(page.getByText("triage in progress — pickup is stopped")).toBeVisible();
  await page.getByRole("button", { name: "commit triage" }).click();
  await expect(page.getByText("triage in progress — pickup is stopped")).not.toBeVisible();
});
