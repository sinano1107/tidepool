import { afterEach, expect, it } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import type { AgentDeletionReferences, DeleteAgentInput } from "../src/agent-create.js";
import { appendEvent } from "../src/events.js";
import { registerPrPromotionFailureQuestion } from "../src/landing.js";
import { UnknownAgentError } from "../src/registry.js";
import {
  DeletionBlockedError,
  DeletionConfirmationRequiredError,
} from "../src/registry-write.js";
import { registerTask } from "../src/tasks.js";
import {
  type DeleteWorkspaceInput,
  deleteWorkspace,
  type WorkspaceDeletionReferences,
} from "../src/workspace-create.js";
import {
  AUTH_HEADERS,
  api,
  bootTidepool,
  completedWork,
  HUMAN_WEBUI,
  registerWork,
  settleReviews,
  type Tidepool,
} from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("DELETE /api/agents/:name は名前と confirm を verb へ渡し、200 を返す(issue #205)", async () => {
  const calls: DeleteAgentInput[] = [];
  t = await bootTidepool({
    agentAdmin: {
      delete: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/agents/tako", { confirm: true });

  expect(res.status).toBe(200);
  expect(calls).toEqual([{ name: "tako", confirm: true }]);
});

it("DELETE /api/agents/:name は未決着タスクの件数・既定 agent 名・Auditor 名・Interviewer 名を参照検査の事実として渡す(issue #376 / ADR 0269 決定2)", async () => {
  const refs: AgentDeletionReferences[] = [];
  t = await bootTidepool({
    workerId: "tako",
    agentAdmin: {
      delete: async (_input, references) => {
        refs.push(references);
      },
    },
  });
  await registerWork(t, "unsettled one", undefined, "fugu");
  await registerWork(t, "unsettled two", undefined, "fugu");
  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "reviewed later",
    purpose: "p",
    completion_criteria: "c",
    review_by: ["fugu"],
  });
  // review は組み込みへ落ちても壊れないので、shadow の扉の work の数えには入らない(ADR 0228 決定3)
  registerTask(t.db, { type: "review", title: "review by fugu", purpose: "p", completion_criteria: "c", assignee: "fugu" }, new Date(), ...HUMAN_WEBUI);

  await api(t.baseUrl, "DELETE", "/api/agents/fugu", { confirm: true });

  expect(refs).toEqual([
    { unsettledTaskCount: 4, unsettledWorkTaskCount: 2, awaitingLandingTaskIds: [], defaultAgentName: "tako", auditorName: "fugu", interviewerName: "suzumedai" },
  ]);
});

it("DELETE /api/agents/:name は確認なしの拒否を 409 confirm_required に写す", async () => {
  t = await bootTidepool({
    agentAdmin: {
      delete: async () => {
        throw new DeletionConfirmationRequiredError("agent", "tako");
      },
    },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/agents/tako", {});

  expect(res.status).toBe(409);
  expect(res.json.confirm_required).toBe(true);
  // 削除は「権限を広げる値」ではないので、危険な値の理由コード列には載らない
  expect(res.json.dangerous_values).toBeUndefined();
});

it("本文なしの DELETE も確認の門まで届く(400 のスキーマ拒否で止まらない)", async () => {
  t = await bootTidepool({
    agentAdmin: {
      delete: async () => {
        throw new DeletionConfirmationRequiredError("agent", "tako");
      },
    },
  });

  const res = await fetch(`${t.baseUrl}/api/agents/tako`, {
    method: "DELETE",
    headers: { ...AUTH_HEADERS, "content-type": "application/json" },
  });

  expect(res.status).toBe(409);
});

it("DELETE /api/agents/:name は確認で買えない拒否を 409 blocked と理由で返す", async () => {
  t = await bootTidepool({
    agentAdmin: {
      delete: async () => {
        throw new DeletionBlockedError("agent", "tako", [{ code: "unsettled_tasks", count: 3 }]);
      },
    },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/agents/tako", { confirm: true });

  expect(res.status).toBe(409);
  expect(res.json.blocked).toBe(true);
  expect(res.json.reasons).toEqual([{ code: "unsettled_tasks", count: 3 }]);
  expect(res.json.confirm_required).toBeUndefined();
});

it("DELETE /api/agents/:name は未知の agent を 404、未設定を 503 で返す", async () => {
  t = await bootTidepool({
    agentAdmin: {
      delete: async () => {
        throw new UnknownAgentError("ghost");
      },
    },
  });
  expect((await api(t.baseUrl, "DELETE", "/api/agents/ghost", { confirm: true })).status).toBe(404);

  await t.stop();
  t = await bootTidepool();
  expect((await api(t.baseUrl, "DELETE", "/api/agents/tako", { confirm: true })).status).toBe(503);
});

it("DELETE /api/workspaces/:name は未決着タスクの件数と既定 workspace 名を渡し、残る checkout の場所を返す", async () => {
  const calls: Array<[DeleteWorkspaceInput, WorkspaceDeletionReferences]> = [];
  t = await bootTidepool({
    workspaceAdmin: {
      delete: async (input, references) => {
        calls.push([input, references]);
        return "/home/pi/work/lagoon";
      },
    },
  });
  await registerWork(t, "unsettled", "lagoon");

  const res = await api(t.baseUrl, "DELETE", "/api/workspaces/lagoon", { confirm: true });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({ checkout: "/home/pi/work/lagoon" });
  expect(calls[0]?.[0]).toEqual({ name: "lagoon", confirm: true });
  expect(calls[0]?.[1].unsettledTaskCount).toBe(1);
});

it("DELETE /api/workspaces/:name はその workspace で着地を待つ完了タスクの件数を渡す(ADR 0226)", async () => {
  const refs: WorkspaceDeletionReferences[] = [];
  t = await bootTidepool({
    workspaceAdmin: {
      delete: async (_input, references) => {
        refs.push(references);
        return "/home/pi/work/lagoon";
      },
    },
  });
  const now = new Date();
  const work = completedWork(t.db, now, "tako", undefined, "lagoon");
  registerPrPromotionFailureQuestion(t.db, work, "boom", now);

  await api(t.baseUrl, "DELETE", "/api/workspaces/lagoon", { confirm: true });

  expect(refs[0]?.awaitingLandingTaskIds).toEqual([work.id]);
});

it("DELETE refuses a workspace referenced only through an unsettled task's ancestor", async () => {
  const dir = await makeRegistry();
  t = await bootTidepool({
    workspaceAdmin: {
      delete: (input, refs) => deleteWorkspace(input, {
        ...refs, db: t.db, registry: { dir, mode: "purely-local" }, workspacesBaseDir: t.dir,
      }),
    },
  });
  const at = t.clock.now();
  const parent = completedWork(t.db, at, "deckhand", undefined, "tidepool");
  settleReviews(t.db, at);
  appendEvent(t.db, { taskId: parent.id, at, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "nothing_to_land", base: "main" } });
  registerTask(t.db, { type: "memory_repair", title: "repair", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, ...HUMAN_WEBUI);

  const res = await api(t.baseUrl, "DELETE", "/api/workspaces/tidepool", { confirm: true });

  expect(res.status).toBe(409);
  expect(res.json).toMatchObject({ blocked: true, reasons: [{ code: "unsettled_tasks", count: 1 }] });
});

it("DELETE /api/workspaces/:name は開いた Quarantine と基準の拒否を他の理由と同じ 409 で返す(ADR 0373 決定14)", async () => {
  t = await bootTidepool({
    workspaceAdmin: {
      delete: async () => {
        throw new DeletionBlockedError("workspace", "lagoon", [{ code: "open_quarantine", question_id: "q1" }]);
      },
    },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/workspaces/lagoon", { confirm: true });

  expect(res.status).toBe(409);
  expect(res.json.blocked).toBe(true);
  expect(res.json.reasons).toEqual([{ code: "open_quarantine", question_id: "q1" }]);
});

it("DELETE /api/profiles/:name は名前と confirm を verb へ渡し、200 を返す", async () => {
  const calls: unknown[] = [];
  t = await bootTidepool({
    profileAdmin: {
      delete: async (input) => {
        calls.push(input);
      },
    },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/profiles/standard", { confirm: true });

  expect(res.status).toBe(200);
  expect(calls).toEqual([{ name: "standard", confirm: true }]);
});
