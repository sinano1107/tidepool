import { api, HOUR, registerQuestion, registerWork } from "../tests/harness.js";
import { expect, test } from "./fixtures.js";

test("未読のある Triage を描画しても pickup は止まらない(issue #225)", async ({
  boot,
  page,
}) => {
  const startRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/triage/start") {
      startRequests.push(request.url());
    }
  });
  const t = await boot();
  await registerWork(t, "still pickable after a skim");
  registerQuestion(t, {
    title: "which way?",
    purpose: "choose a direction",
    completion_criteria: "the choice is recorded",
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });

  await page.goto(t.baseUrl);
  await expect(page.getByText("The tide brought 1 question.")).toBeVisible();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

  expect(startRequests).toEqual([]);
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
  registerQuestion(t, {
    title: "which way?",
    purpose: "choose a direction",
    completion_criteria: "the choice is recorded",
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });

  await page.goto(t.baseUrl);
  const answer = page.getByRole("button", { name: /^left/ });
  await answer.click();
  await expect(answer).toHaveCSS("cursor", "default");

  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).not.toBe(null);
  await page.getByRole("button", { name: "Queue" }).click();
  await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).not.toBe(null);
  await api(t.baseUrl, "POST", `/api/tasks/${work.id}/move`, { after: null });
  expect(t.worker.started).toEqual([]);
});
