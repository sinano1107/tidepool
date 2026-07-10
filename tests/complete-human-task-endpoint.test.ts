import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("人間タスクが親のエージェントタスクを block し、完了で親がアンブロックされ即時ポーリングが走る(issue #13)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "greenhouse rollout");
  const human = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "physically install the sensor",
      purpose: "the agent can't reach the greenhouse",
      completion_criteria: "sensor mounted and powered",
      assignee: "human",
      parent_id: parent.id,
    })
  ).json;

  // 親は human 子タスクに block されて動かない
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("blocked");

  // ドキュメント完全任意で complete できる(AC4)
  const completed = await api(t.baseUrl, "POST", `/api/tasks/${human.id}/complete`, {});
  expect(completed.status).toBe(200);
  expect(completed.json.status).toBe("done");

  // 親がアンブロックされ、clock を進めなくても即時ポーリングでもう pickup 済み(AC2)
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("in_progress");
  expect(t.worker.started.map((x: any) => x.id)).toEqual([parent.id]);
});

it("assignee が human 以外のタスクは /complete で完了できない — MCP の complete_task をバイパスする経路にしない(issue #13 code review)", async () => {
  t = await bootTidepool();
  const agentTask = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "agent-executable todo",
      purpose: "p",
      completion_criteria: "c",
      assignee: "reef-crab",
    })
  ).json;

  const res = await api(t.baseUrl, "POST", `/api/tasks/${agentTask.id}/complete`, {
    handoff: {
      outcome: "o",
      deliverables: "d",
      decision_refs: "r",
      dead_ends: "e",
      resume_context: "c",
      known_issues: "k",
    },
  });
  expect(res.status).toBe(409);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${agentTask.id}`)).json.status).toBe("todo");
});

it("何も block していない孤立した人間タスクはワンタップで閉じられる(ドキュメント完全任意)", async () => {
  t = await bootTidepool();
  const orphan = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "approve the vendor invoice",
      purpose: "p",
      completion_criteria: "c",
      assignee: "human",
    })
  ).json;

  const completed = await api(t.baseUrl, "POST", `/api/tasks/${orphan.id}/complete`, {});
  expect(completed.status).toBe(200);
  expect(completed.json.status).toBe("done");
  expect(completed.json.handoff_doc).toBeNull();
});
