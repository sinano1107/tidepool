import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import {
  api,
  bootTidepool,
  commitWork,
  FULL_HANDOFF,
  HOUR,
  makeWorkspace,
  mcpClient,
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

/** 付帯子(親を持ち、based_on_decision を持たず、question でない子)を盤面の DB へ直に
 *  足す — 人間面の /api/tasks は parent_id つきの登録に decompose_reason を要求する
 *  (= 分解子になる)ので、付帯子の fixture はこの seam を通す。 */
function attachChild(pool: Tidepool, parentId: string, title: string): void {
  const db = openDb(join(pool.dir, "board.sqlite"));
  try {
    registerTask(
      db,
      {
        type: "work",
        title,
        purpose: `purpose of ${title}`,
        completion_criteria: `criteria of ${title}`,
        parent_id: parentId,
        assignee: "human",
      },
      pool.clock.now(),
    );
  } finally {
    db.close();
  }
}

async function completeViaMcp(pool: Tidepool, taskId: string): Promise<void> {
  const client = await mcpClient(pool.mcpBaseUrl, taskId);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
}

async function questions(pool: Tidepool): Promise<any[]> {
  return (await api(pool.baseUrl, "GET", "/api/tasks")).json.filter(
    (candidate: any) => candidate.type === "question",
  );
}

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
  attachChild(t, task.id, "repair: ship the feature");

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
  attachChild(t, task.id, "repair: ship the feature");
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
