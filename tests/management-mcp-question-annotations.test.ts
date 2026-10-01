import { afterEach, expect, it, vi } from "vitest";
import { createBehaviorCandidate } from "../src/memory.js";
import {
  api,
  bootTidepool,
  commitWork,
  completeIntegrationReviews,
  completeViaMcp,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  makeWorkspace,
  managementMcpClient,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// 管理MCP の各口は、対応する HTTP の口と同じ注釈を持つ(issue #1179): `list_board` は
// `GET /api/tasks` の5つ(landing・approval・moved・blocking・needs_comment)、`get_task` は
// `GET /api/tasks/:id` の4つ(landing を除く)。注釈の値そのものは HTTP 側のテスト
// (#757・ADR 0162 決定6・ADR 0092 決定4・ADR 0179 決定4)が言うので、ここは HTTP の同じ行との一致だけを言う。
// 各テストの値の assert は、fixture が狙ったケース(承認・移動・着地・通常)になっていることの確認である。

let t: Tidepool;
afterEach(() => t?.stop());

const ANNOTATIONS = ["landing", "approval", "moved", "blocking", "needs_comment"] as const;

/** 同じ task を HTTP の一覧・単体ビューと管理MCP の list_board・get_task から読む。
 *  MCP の読取は DB を変えない — 共有 connection を read-only にしてから読む。 */
async function readFourWays(t: Tidepool, taskId: string) {
  const httpRow = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((x) => x.id === taskId);
  const httpSingle = (await api(t.baseUrl, "GET", `/api/tasks/${taskId}`)).json;
  const client = await managementMcpClient(t.baseUrl);
  try {
    t.db.pragma("query_only = ON");
    const board: any = await client.callTool({ name: "list_board", arguments: {} });
    const single: any = await client.callTool({ name: "get_task", arguments: { task_id: taskId } });
    expect(board.isError ?? false).toBe(false);
    expect(single.isError ?? false).toBe(false);
    const mcpRow = (JSON.parse(board.content[0].text) as any[]).find((x) => x.id === taskId);
    return { httpRow, httpSingle, mcpRow, mcpSingle: JSON.parse(single.content[0].text) };
  } finally {
    await client.close();
  }
}

/** 一覧の口どうしは5つ、単体の口どうしは4つの注釈が同じ値で、単体の口は landing を持たない。 */
function expectSameAnnotations(read: Awaited<ReturnType<typeof readFourWays>>) {
  for (const key of ANNOTATIONS) {
    expect(read.mcpRow).toHaveProperty(key);
    expect(read.mcpRow[key]).toEqual(read.httpRow[key]);
  }
  for (const key of ANNOTATIONS.filter((k) => k !== "landing")) {
    expect(read.mcpSingle).toHaveProperty(key);
    expect(read.mcpSingle[key]).toEqual(read.httpSingle[key]);
  }
  expect(read.mcpSingle).not.toHaveProperty("landing");
}

it("承認 question(risk ありの子 × risk なしの親)は list_board と get_task で HTTP と同じ approval と blocking を持つ", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const worker = await mcpClient(t.mcpBaseUrl, parent.id);
  const decomposed: any = await worker.callTool({
    name: "decompose",
    arguments: {
      reason: "some children need sign-off",
      children: [{ title: "migrate the prod table", purpose: "p", completion_criteria: "c", risk_flag: true }],
    },
  });
  await worker.close();
  expect(decomposed.isError ?? false).toBe(false);
  const question = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find(
    (x) => x.type === "question" && x.question_pending_child?.title === "migrate the prod table",
  );

  const read = await readFourWays(t, question.id);

  expectSameAnnotations(read);
  expect(read.mcpRow.approval).toEqual({ raises_parent_risk: true });
  expect(read.mcpSingle.blocking).toBe(parent.id);
});

it("pin した entry を移した memory の提案 question は list_board と get_task で HTTP と同じ moved を持つ", async () => {
  t = await bootTidepool();
  const candidate = createBehaviorCandidate(
    t.db,
    {
      scope: null,
      path: "habits/commits",
      title: "Keep migrations in their own commit",
      text: "Keep migrations in their own commit, always.",
      addressee: "deckhand",
      source: { commit: "0a46a46" },
      author: { activity: "rca", name: "auditor" },
    },
    "worker",
    t.clock.now(),
  ).entry_id;
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((x) => x.meta_review_subject === "memory");
  const worker = await mcpClient(t.mcpBaseUrl, review.id);
  const proposed: any = await worker.callTool({
    name: "propose_memory_change",
    arguments: { op: "approve", candidate_id: candidate, rationale: "Three RCAs asked for the same split." },
  });
  await worker.close();
  const questionId = JSON.parse(proposed.content[0].text).question_id as string;
  await api(t.baseUrl, "POST", `/api/settings/memory/entries/${candidate}/move`, { workspace: null, path: "habits/moved" });

  const read = await readFourWays(t, questionId);

  expectSameAnnotations(read);
  expect(read.mcpRow.moved).toHaveLength(1);
});

it("着地 question は list_board で HTTP の一覧と同じ landing を持ち、get_task には landing が無い", async () => {
  const workspace = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  await completeIntegrationReviews(t, task.id);
  const question = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find(
    (x) => x.type === "question" && x.question_pending_local_merge_task_id === task.id,
  );

  const read = await readFourWays(t, question.id);

  expectSameAnnotations(read);
  expect(read.mcpRow.landing).toEqual({ blocked_by: null });
});

it("通常の escalate question は list_board と get_task で approval: null・moved: [] を持つ", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const worker = await mcpClient(t.mcpBaseUrl, parent.id);
  const escalated: any = await worker.callTool({
    name: "escalate",
    arguments: {
      context: "ordinary escalation",
      questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }],
    },
  });
  await worker.close();
  expect(escalated.isError ?? false).toBe(false);
  const question = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find(
    (x) => x.type === "question" && x.parent_id === parent.id,
  );

  const read = await readFourWays(t, question.id);

  expectSameAnnotations(read);
  for (const view of [read.mcpRow, read.mcpSingle]) expect(view).toMatchObject({ approval: null, moved: [] });
});

it("question でないタスクは list_board にも get_task にも5つの注釈のキーを持たない", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "plain work");

  const read = await readFourWays(t, task.id);

  for (const key of ANNOTATIONS) {
    expect(read.mcpRow).not.toHaveProperty(key);
    expect(read.mcpSingle).not.toHaveProperty(key);
  }
});
