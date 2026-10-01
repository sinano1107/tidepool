import { afterEach, expect, it } from "vitest";
import { createBehaviorCandidate, proposeMemoryChange } from "../src/memory.js";
import { type QuestionProposal, registerTask } from "../src/tasks.js";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

// 承認 question(決裁権外の子の登録から生まれた question)は `approval` 注釈を持ち、
// approve で親の risk が上がるかを盤面が判定して載せる(issue #757)。WebUI の単体
// ビューは親の行を持たないので、GET /api/tasks と GET /api/tasks/:id の両方に載る。

let t: Tidepool;
afterEach(() => t?.stop());

type Child = { title: string; risk_flag?: boolean; assignee?: string };

async function decompose(t: Tidepool, parentId: string, children: Child[]) {
  const client = await mcpClient(t.mcpBaseUrl, parentId);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "some children need sign-off",
      children: children.map((c) => ({
        purpose: `purpose of ${c.title}`,
        completion_criteria: `criteria of ${c.title}`,
        ...c,
      })),
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();
}

async function approvalOf(t: Tidepool, childTitle: string) {
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const row = board.find(
    (x: any) => x.type === "question" && x.question_pending_child?.title === childTitle,
  );
  const single = (await api(t.baseUrl, "GET", `/api/tasks/${row.id}`)).json;
  // 一覧と単体ビューは同じ判定を返す
  expect(single.approval).toEqual(row.approval);
  return row.approval;
}

it("risk ありの子 × risk なしの親の承認 question は、approve で親の risk が上がると注釈する", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  await decompose(t, parent.id, [{ title: "migrate the prod table", risk_flag: true }]);

  expect(await approvalOf(t, "migrate the prod table")).toEqual({ raises_parent_risk: true });
});

it("通常の escalate question は承認の注釈を持たない", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  await client.callTool({
    name: "escalate",
    arguments: {
      context: "ordinary escalation",
      questions: [{ title: "which way?", options: ["a", "b"], recommendation: "a" }],
    },
  });
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const question = board.find((x: any) => x.type === "question" && x.parent_id === parent.id);
  expect(question.approval).toBeNull();
  const single = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(single.approval).toBeNull();
});

it("親が既に risk ありなら、risk ありの子の承認 question でも親の risk は上がらないと注釈する", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  await decompose(t, parent.id, [
    { title: "migrate the prod table", risk_flag: true },
    { title: "rotate the prod keys", risk_flag: true },
  ]);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const first = board.find((x: any) => x.question_pending_child?.title === "migrate the prod table");
  // 1つ目の approve が親の risk を上げる — 2つ目は現在の親に対して評価される
  await api(t.baseUrl, "POST", `/api/tasks/${first.id}/answer`, { answers: ["approve"] });

  expect(await approvalOf(t, "rotate the prod keys")).toEqual({ raises_parent_risk: false });
});

it("理由必須の選択肢の一覧 needs_comment は memory 提案で reject と defer、routing / registry 提案と承認 question で reject、ほかは空で、一覧と単体ビューに載る(ADR 0179 決定4)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  await decompose(t, parent.id, [{ title: "migrate the prod table", risk_flag: true }]);
  const at = t.clock.now();
  const question = (proposal?: QuestionProposal) =>
    registerTask(
      t.db,
      {
        type: "question",
        title: "q",
        purpose: "p",
        completion_criteria: "a human answer is recorded",
        question: [{ title: "t", options: ["approve", "reject"], recommendation: "approve" }],
        ...(proposal && { proposal }),
      },
      at,
    ).id;
  const candidate = createBehaviorCandidate(
    t.db,
    { scope: null, path: "habits", title: "Split migrations", text: "Split migrations.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    at,
  ).entry_id;
  const ids = {
    memory: proposeMemoryChange(t.db, registerTask(t.db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at).id, { op: "approve", candidate_id: candidate, rationale: "r" }, "auditor", at).question_id,
    routing: question({ kind: "routing", op: "promote", pin: { promoted: false } }),
    registry: question({ kind: "registry", op: "agent_tier", agent: "reef-crab", to: "economy", pin: { tier: "standard", rows: [] }, evidence: [1] }),
    plain: question(),
  };
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const needsComment = async (row: any) => {
    expect((await api(t.baseUrl, "GET", `/api/tasks/${row.id}`)).json.needs_comment).toEqual(row.needs_comment);
    return row.needs_comment;
  };
  const byId = (id: string) => board.find((x) => x.id === id);

  expect(await needsComment(byId(ids.memory))).toEqual(["reject", "defer"]);
  expect(await needsComment(byId(ids.routing))).toEqual(["reject"]);
  expect(await needsComment(byId(ids.registry))).toEqual(["reject"]);
  expect(await needsComment(board.find((x) => x.question_pending_child?.title === "migrate the prod table"))).toEqual(["reject"]);
  expect(await needsComment(byId(ids.plain))).toEqual([]);
});

it("assignee だけが理由の承認 question は、親の risk は上がらないと注釈する", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", assignable_to: ["deckhand"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  await decompose(t, parent.id, [{ title: "tune the indexes", assignee: "dba-specialist" }]);

  expect(await approvalOf(t, "tune the indexes")).toEqual({ raises_parent_risk: false });
});
