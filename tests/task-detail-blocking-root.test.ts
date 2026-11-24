import { afterEach, expect, it, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { appendEvent } from "../src/events.js";
import { completeTask, registerTask } from "../src/tasks.js";
import { api, bootTidepool, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, HUMAN_WEBUI, makeWorkspace, type Tidepool } from "./harness.js";
import { recordPrOpenedOutsideConvergence } from "./landing-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0413 決定3: task 単体の読み口もキューの行と同じ理由を返す。述語そのものは domain の釘(next-slot-task-closed-root.test.ts ほか)が言うので、
// ここは GET /api/tasks/:id への配線 —— 保存された status が todo の task に載り、done の task と人間担当の task に載らないこと —— だけを言う

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/tasks/:id は、人間が着地を終えた根の下の todo の子に blocking_root を返し、done の子と人間担当の子には返さない", async () => {
  t = await bootTidepool({ workspace: await makeWorkspace("task-detail-blocking-root") });
  const now = t.clock.now();
  const root = registerTask(t.db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, now, ...HUMAN_WEBUI);
  const waiting = registerTask(t.db, { type: "work", title: "repair", purpose: "p", completion_criteria: "c", parent_id: root.id }, now, ...HUMAN_WEBUI);
  const human = registerTask(t.db, { type: "work", title: "by hand", purpose: "p", completion_criteria: "c", parent_id: root.id, assignee: HUMAN_ACTOR_ID }, now, ...HUMAN_WEBUI);
  const finished = registerTask(t.db, { type: "work", title: "done repair", purpose: "p", completion_criteria: "c", parent_id: root.id }, now, ...HUMAN_WEBUI);
  completeTask(t.db, finished, FULL_HANDOFF, "deckhand", now, "worker");
  const done = completeTask(t.db, root, FULL_HANDOFF, "deckhand", now, "worker");
  recordPrOpenedOutsideConvergence(t.db, done, 1, now);
  appendEvent(t.db, { taskId: root.id, actorId: HUMAN_ACTOR_ID, origin: "webui", payload: { kind: "landing_ended_pr_left", question_ids: [] }, at: now });

  expect((await api(t.baseUrl, "GET", `/api/tasks/${waiting.id}`)).json.blocking_root).toEqual({ task_id: root.id, pr_number: 1, kind: "landing_ended" });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${finished.id}`)).json).not.toHaveProperty("blocking_root");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${human.id}`)).json).not.toHaveProperty("blocking_root");
});
