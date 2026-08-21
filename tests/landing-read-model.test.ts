import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  api,
  attachChild,
  bootTidepool,
  commitWork,
  completeViaMcp,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  questions,
  registerQuestion,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];

afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 着地 question が立つところまで進めた purely-local な盤面。 */
async function landedQuestion(): Promise<any> {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
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

  expect(rows).toContainEqual(
    expect.objectContaining({
      question_pending_local_merge_task_id: task.id,
      landing: { blocked_by: null },
    }),
  );
  expect(rows.filter((q: any) => q.landing !== null)).toHaveLength(1);
  expect(rows.find((q: any) => q.question_items[0].title === "which way?").landing).toBe(null);
});

it("未決着の付帯子を持つ着地 question は attached_children で回答不能として返る", async () => {
  const task = await landedQuestion();
  attachChild(t, task.id, "repair: ship the feature", "human");

  const [landing] = await questions(t);

  expect(landing.landing).toEqual({ blocked_by: "attached_children" });
});

it("同じ triage で異議を raise したタスクの着地 question は objections で回答不能として返る", async () => {
  const task = await landedQuestion();
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const entry = log.entries.find(
    (candidate: any) => candidate.kind === "task_completed" && candidate.task_id === task.id,
  );
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "この完了報告の判断に異議がある",
  });

  const [landing] = await questions(t);

  expect(landing.landing).toEqual({ blocked_by: "objections" });
});

it("付帯子と異議が両方あれば attached_children を名乗る — 回答経路が返す 409 と同じ理由", async () => {
  const task = await landedQuestion();
  attachChild(t, task.id, "repair: ship the feature", "human");
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const entry = log.entries.find(
    (candidate: any) => candidate.kind === "task_completed" && candidate.task_id === task.id,
  );
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "この完了報告の判断に異議がある",
  });

  const [landing] = await questions(t);

  expect(landing.landing).toEqual({ blocked_by: "attached_children" });
  expect(
    (await api(t.baseUrl, "POST", `/api/tasks/${landing.id}/answer`, { answers: ["merge"] })).json
      .error,
  ).toContain("attached child task(s) unsettled");
});

/** PR の merge question が立つところまで進めた remote-backed な盤面(`escalate`)。 */
async function landedPrQuestion(): Promise<any> {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const task = await registerWork(t, "ship remotely");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  return task;
}

it("PR の merge question も着地 question として分かれ、回答可否が付く", async () => {
  const task = await landedPrQuestion();

  expect(await questions(t)).toMatchObject([
    { question_pending_merge_pr: 1, landing: { blocked_by: null } },
  ]);

  attachChild(t, task.id, "repair: ship remotely", "human");

  expect((await questions(t))[0].landing).toEqual({ blocked_by: "attached_children" });
});

it("PR から着地タスクを引けない merge question は読み口でも回答不能として返る", async () => {
  await landedPrQuestion();
  // `taskIdForPr` が引けない盤面を作る — 実際には `recordPrOpened` が pr_number を
  // 書いてから question を立てるので起きないが、fail-closed は UI に依らず盤面が守る
  const db = openDb(join(t.dir, "board.sqlite"));
  try {
    db.prepare("UPDATE tasks SET pr_number = NULL WHERE pr_number IS NOT NULL").run();
  } finally {
    db.close();
  }

  const [landing] = await questions(t);

  expect(landing.landing).not.toBe(null);
  expect(landing.landing.blocked_by).not.toBe(null);
});
