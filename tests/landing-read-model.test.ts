import { afterEach, expect, it, vi } from "vitest";
import {
  api,
  attachChild,
  bootTidepool,
  commitWork,
  completeIntegrationReviews,
  completeViaMcp,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  makeWorkspace,
  questions,
  registerQuestion,
  registerWork,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;

afterEach(async () => {
  await t?.stop();
});

/** 着地 question が立つところまで進めた purely-local な盤面。 */
async function landedQuestion(): Promise<any> {
  const workspace = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  await completeIntegrationReviews(t, task.id);
  return task;
}

it("読み口は着地 question に回答可否を添え、一般 question は landing を持たない", async () => {
  const task = await landedQuestion();
  registerQuestion(t, {
    title: "which way?",
    purpose: "a human decides the direction",
    completion_criteria: "the answer is recorded",
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });

  const rows = await questions(t);

  expect(rows.find((q: any) => q.question_pending_local_merge_task_id === task.id).landing).not.toBe(null);
  expect(rows.find((q: any) => q.question_items[0].title === "which way?").landing).toBe(null);
});

it("単体ビューの読み口は一覧と同じ landing を返す(ADR 0190)", async () => {
  const task = await landedQuestion();
  attachChild(t, task.id, "repair: ship the feature", "human");
  registerQuestion(t, {
    title: "which way?",
    purpose: "a human decides the direction",
    completion_criteria: "the answer is recorded",
    question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
  });

  const rows = await questions(t);

  for (const row of rows) {
    expect((await api(t.baseUrl, "GET", `/api/tasks/${row.id}`)).json.landing).toEqual(row.landing);
  }
  expect(rows.map((q: any) => q.landing)).toEqual(expect.arrayContaining([{ blocked_by: "attached_children" }, null]));
});
