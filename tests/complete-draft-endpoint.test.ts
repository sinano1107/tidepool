import { afterEach, expect, it } from "vitest";
import { FakeDraftClient } from "./fakes.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("POST /api/tasks/:id/complete/draft は自由文ダンプから6項目ハンドオフを下書きし、欠落項目を warning として返す。タスク自体は完了しない(issue #13)", async () => {
  const draftClient = new FakeDraftClient();
  draftClient.scriptHandoffDraft({
    outcome: "sensor mounted and reading",
    deliverables: "greenhouse, north wall",
  });
  t = await bootTidepool({ draftClient });

  const human = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "physically install the sensor",
      purpose: "p",
      completion_criteria: "c",
      assignee: "human",
    })
  ).json;

  const res = await api(t.baseUrl, "POST", `/api/tasks/${human.id}/complete/draft`, {
    dump: "mounted the sensor on the north wall",
  });
  expect(res.status).toBe(200);
  expect(res.json.outcome).toBe("sensor mounted and reading");
  expect(res.json.deliverables).toBe("greenhouse, north wall");
  expect(res.json.missing.sort()).toEqual(
    ["decision_refs", "dead_ends", "resume_context", "known_issues"].sort(),
  );

  // 下書きは complete させない — 人間が確認/編集してから /complete を別途呼ぶ
  expect((await api(t.baseUrl, "GET", `/api/tasks/${human.id}`)).json.status).toBe("todo");
  expect(draftClient.handoffDumps).toEqual(["mounted the sensor on the north wall"]);
});

it("assignee が human 以外のタスクは /complete/draft を叩けない(issue #13 code review)", async () => {
  const draftClient = new FakeDraftClient();
  t = await bootTidepool({ draftClient });
  const agentTask = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "agent-executable todo",
      purpose: "p",
      completion_criteria: "c",
      assignee: "reef-crab",
    })
  ).json;

  const res = await api(t.baseUrl, "POST", `/api/tasks/${agentTask.id}/complete/draft`, {
    dump: "did the thing",
  });
  expect(res.status).toBe(409);
  expect(draftClient.handoffDumps).toEqual([]);
});

it("draftClient は設定済みだが draftHandoff が失敗する場合も 503 を返す — 出力不能と同じシグナル(issue #13 code review, #12 の draftTask 障害フォールバックと対称)", async () => {
  const draftClient = new FakeDraftClient();
  draftClient.scriptHandoffFailure(new Error("claude CLI timed out"));
  t = await bootTidepool({ draftClient });
  const human = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "physically install the sensor",
      purpose: "p",
      completion_criteria: "c",
      assignee: "human",
    })
  ).json;

  const res = await api(t.baseUrl, "POST", `/api/tasks/${human.id}/complete/draft`, {
    dump: "mounted the sensor",
  });
  expect(res.status).toBe(503);
});

it("LLM draft client が未設定なら 503 を返す(#12 の draftTask と同じフォールバック)", async () => {
  t = await bootTidepool();
  const human = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "approve the invoice",
      purpose: "p",
      completion_criteria: "c",
      assignee: "human",
    })
  ).json;

  const res = await api(t.baseUrl, "POST", `/api/tasks/${human.id}/complete/draft`, {
    dump: "approved it, no changes needed",
  });
  expect(res.status).toBe(503);
});
