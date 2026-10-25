import { afterEach, expect, it, vi } from "vitest";
import { executionSettingsFor } from "../src/execution-setting.js";
import { IssueGoneError } from "../src/github.js";
import { registerTask } from "../src/tasks.js";
import { healthyOpenai } from "./fakes.js";
import { api, bootTidepool, GIT_FIXTURE_TEST_TIMEOUT, HOUR, HUMAN_WEBUI, makeWorkspace, queueWork, type Tidepool } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

// scheduler は head を選んでから issue 本文の取得を await する(issue #972)。その窓で人間の
// 扉が head を書き換えたら、scheduler は pickup を取りやめ、slot を空けたまま次の poll で選び直す
it.each([
  ["assignee を human に付け替えた", (id: string) => api(t.baseUrl, "PATCH", `/api/tasks/${id}`, { assignee: "human" })],
  ["直接 cancel した", (id: string) => api(t.baseUrl, "POST", `/api/tasks/${id}/cancel`, {})],
])("issue 本文の取得中に %s task は走らず、slot は次の task に空いたままになる(issue #972)", async (_, mutate) => {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  const head = registerTask(t.db, { type: "work", workspace: "tidepool", github_issue_number: 49 }, t.clock.now(), ...HUMAN_WEBUI);
  t.github.scriptIssue(49, { title: "t", body: "b", comments: [] });
  let release!: () => void;
  t.github.scriptIssueGate(new Promise((r) => (release = r)));

  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.github.issueFetches.length).toBe(1));
  // 保留するのは scheduler の取得だけ —— 扉の応答が issue を live 表示する取得は通す
  t.github.scriptIssueGate(null);
  expect((await mutate(head.id)).status).toBe(200);
  release();
  await new Promise((r) => setImmediate(r));

  expect(t.worker.started).toEqual([]);

  const next = queueWork(t, "next");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([next.id]);
});

// 実行設定と task_picked_up の帰属は選んだ head の assignee から決まる(issue #973)。窓の間に別の agent へ
// 付け替えられた head は旧 agent の設定で走らせず、次の poll が新しい agent で選び直す
it("issue 本文の取得中に assignee を別の agent へ付け替えた task は、次の poll で新しい agent の実行設定で走る(issue #973)", async () => {
  const providers: Record<string, string> = { "claude-agent": "anthropic", "codex-agent": "openai" };
  t = await bootTidepool({
    workspace: await makeWorkspace("tidepool"),
    openaiUsage: healthyOpenai,
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, { provider: [{ name: providers[task.assignee!]!, advisor: false }], tier: undefined }, task),
  });
  const head = registerTask(
    t.db,
    { type: "work", workspace: "tidepool", github_issue_number: 49, assignee: "claude-agent" },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
  t.github.scriptIssue(49, { title: "t", body: "b", comments: [] });
  let release!: () => void;
  t.github.scriptIssueGate(new Promise((r) => (release = r)));

  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.github.issueFetches.length).toBe(1));
  t.github.scriptIssueGate(null);
  expect((await api(t.baseUrl, "PATCH", `/api/tasks/${head.id}`, { assignee: "codex-agent" })).status).toBe(200);
  release();
  await new Promise((r) => setImmediate(r));

  expect(t.worker.started).toEqual([]);

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([head.id]);
  expect(t.worker.startedSettings[0]!.provider).toBe("openai");
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${head.id}/events`)).json;
  expect(events.filter((e: any) => e.kind === "task_picked_up").map((e: any) => e.actor_id)).toEqual(["codex-agent"]);
});

// IssueGone の failure question は、行がまだ選んだ head のときだけ立つ(issue #973)。窓の間の人間の扉の決定は上書きしない
it.each([
  ["直接 cancel した", (id: string) => api(t.baseUrl, "POST", `/api/tasks/${id}/cancel`, {}), "cancelled"],
  ["assignee を human に付け替えた", (id: string) => api(t.baseUrl, "PATCH", `/api/tasks/${id}`, { assignee: "human" }), "todo"],
])("issue 本文の取得中に %s task には、issue が消えていても failure question が立たない(issue #973)", async (_, mutate, status) => {
  t = await bootTidepool({ workspace: await makeWorkspace("tidepool") });
  const head = registerTask(t.db, { type: "work", workspace: "tidepool", github_issue_number: 49 }, t.clock.now(), ...HUMAN_WEBUI);
  t.github.scriptIssue(49, { title: "t", body: "b", comments: [] });
  let release!: () => void;
  t.github.scriptIssueGate(new Promise((r) => (release = r)));

  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.github.issueFetches.length).toBe(1));
  t.github.scriptIssueGate(null);
  expect((await mutate(head.id)).status).toBe(200);
  t.github.scriptIssueFailure(new IssueGoneError({ path: "/x", number: 49 }, "closed"));
  release();
  await new Promise((r) => setImmediate(r));

  expect((await api(t.baseUrl, "GET", `/api/tasks/${head.id}`)).json.status).toBe(status);
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json.filter((x: any) => x.parent_id === head.id)).toEqual([]);
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${head.id}/events`)).json;
  expect(events.some((e: any) => e.kind === "task_escalated")).toBe(false);
});
