import { afterEach, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents, type TaskScopedPayload } from "../src/events.js";
import type { AuthorityProfile } from "../src/registry.js";
import { assigneeNeedsApproval, editTask, getTask, humanDecomposeTask, listChildren, pickupTask, type RegisterTaskInput, registerTask, returnToQueue, reviewedTaskExecutor } from "../src/tasks.js";
import { commitTriage, raiseObjection } from "../src/triage.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import { api, bootTidepool, FULL_HANDOFF, HOUR, HUMAN_WEBUI, markPickedUp, mcpClient, type Tidepool, WORKER_SPAWNED } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** 人間の扉を通さない登録。扉の登録は pickup の契機(ADR 0119 決定2)なので、レビュー対象を
 *  slot に入れずに review だけを先頭へ動かすテストはこちらで行を置く。 */
const seed = (input: RegisterTaskInput) => registerTask(t.db, input, t.clock.now(), ...HUMAN_WEBUI);

const PERMISSIVE_AUTHORITY: AuthorityProfile = {
  name: "permissive",
  guidance: "",
  // no allowed_workspaces — unrestricted
};

function resolveAuthority(assignee: string | null): AuthorityProfile | undefined {
  if (assignee === "reef-crab") return PERMISSIVE_AUTHORITY;
  return undefined;
}

it("review タスクは実行 assignee 自身の authority profile がどれだけ緩くても、常に読み取り専用の reviewer profile で decompose が検査される(ADR 0013): task 型が profile を上書きする", async () => {
  t = await bootTidepool({ resolveAuthority });
  const review = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "review the widget",
      purpose: "purpose",
      completion_criteria: "criteria",
      assignee: "reef-crab",
    })
  ).json;
  await api(t.baseUrl, "POST", `/api/tasks/${review.id}/move`, { after: null });
  await t.clock.advance(HOUR); // review picked up

  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "found an issue that needs a fix in prod",
      children: [
        {
          title: "patch prod directly",
          purpose: "p",
          completion_criteria: "c",
          workspace: "prod",
        },
      ],
    },
  });
  await client.close();
  expect(res.isError ?? false).toBe(false);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  // reef-crab's own profile is unrestricted — if it applied, this child would
  // register directly. The reviewer profile applies instead (task type
  // overrides authority), so it converts to an approval question.
  expect(board.find((x: any) => x.title === "patch prod directly")).toBeUndefined();
  const question = board.find((x: any) => x.type === "question" && x.parent_id === review.id);
  expect(question).toBeDefined();
});

it("review タスクの分解子を、レビュー対象タスクの assignee と同じ宛先にする割当は、reviewer profile の assignable_to(空)に関わらず常に許可される(ADR 0013: 修理の宛先はレビュー対象の実行者)", async () => {
  t = await bootTidepool();
  const reviewed = seed({ type: "work", title: "wire the moisture sensor", purpose: "purpose", completion_criteria: "criteria", assignee: "reef-crab" });
  markPickedUp(t.db, reviewed.id, t.clock.now(), "reef-crab");
  const review = seed({
    type: "review",
    title: "RCA for the sensor task",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: reviewed.id,
    assignee: "auditor",
  });
  await api(t.baseUrl, "POST", `/api/tasks/${review.id}/move`, { after: null });
  await t.clock.advance(HOUR); // review picked up

  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "found a root cause that needs a fix",
      children: [
        {
          title: "fix the root cause",
          purpose: "p",
          completion_criteria: "c",
          assignee: "reef-crab",
        },
      ],
    },
  });
  await client.close();
  expect(res.isError ?? false).toBe(false);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const repair = board.find((x: any) => x.title === "fix the root cause");
  expect(repair).toBeDefined();
  expect(repair.type).toBe("work");
  expect(repair.assignee).toBe("reef-crab");
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
});

it("assignee 未設定の完了タスクを review すると、記録された executor だけが roster と decompose の両方で直接の修理先になる(ADR 0054 / issue #217)", async () => {
  t = await bootTidepool({
    listAgents: () => [
      { name: "fake-worker", description: "The recorded executor" },
      { name: "someone-else", description: "Another agent" },
    ],
  });
  const reviewed = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "wire the default sensor",
      purpose: "purpose",
      completion_criteria: "criteria",
    })
  ).json;
  await t.clock.advance(HOUR); // reviewed task picked up as fake-worker
  const workClient = await mcpClient(t.mcpBaseUrl, reviewed.id);
  await workClient.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await workClient.close();

  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.type === "review" && task.parent_id === reviewed.id,
  );
  await t.clock.advance(HOUR); // review picked up

  const reviewClient = await mcpClient(t.mcpBaseUrl, review.id);
  const rosterResult: any = await reviewClient.callTool({ name: "list_agents", arguments: {} });
  const roster = JSON.parse(rosterResult.content[0].text).agents;
  await reviewClient.callTool({
    name: "decompose",
    arguments: {
      reason: "the executor should repair its own finding",
      children: [
        {
          title: "repair by the executor",
          purpose: "p",
          completion_criteria: "c",
          assignee: "fake-worker",
        },
        {
          title: "repair by another agent",
          purpose: "p",
          completion_criteria: "c",
          assignee: "someone-else",
        },
      ],
    },
  });
  await reviewClient.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect({
    executorStatus: roster.find((agent: any) => agent.name === "fake-worker")?.status,
    otherStatus: roster.find((agent: any) => agent.name === "someone-else")?.status,
    executorRepairRegistered: board.some((task: any) => task.title === "repair by the executor"),
    otherRepairRegistered: board.some((task: any) => task.title === "repair by another agent"),
    approvalQuestionRegistered: board.some(
      (task: any) => task.type === "question" && task.parent_id === review.id,
    ),
  }).toEqual({
    executorStatus: "direct",
    otherStatus: "needs_approval",
    executorRepairRegistered: true,
    otherRepairRegistered: false,
    approvalQuestionRegistered: true,
  });
});

it("pickup 後の被レビュー task の assignee は空に戻せず、Executor は pickup が書いた worker のまま(ADR 0292 決定1 / ADR 0054 / issue #217)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-01-01T00:00:00Z");
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  returnToQueue(db, pickupTask(db, work, "first-worker", at, { assignee: "first-worker" })!, { kind: "cap_interrupted" }, at);
  const review = registerTask(db, { type: "review", title: "r", purpose: "p", completion_criteria: "c", parent_id: work.id }, at, ...HUMAN_WEBUI);

  expect(() => editTask(db, getTask(db, work.id)!, { assignee: "" }, at, "webui")).toThrow(DomainError);
  expect(reviewedTaskExecutor(db, review)).toBe("first-worker");
});

it("task_completed も pickup も無い被レビュー task では Executor が引けず、免除は成立しない(ADR 0054 / issue #217)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-01-01T00:00:00Z");
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  // 人間名義の review 子は実行前の親に付けられない(ADR 0292 決定2)—— 盤面名義(異議由来の auditor RCA の形)で置く
  const review = registerTask(db, { type: "review", title: "r", purpose: "p", completion_criteria: "c", parent_id: work.id }, at, BOARD_WORKER_ID, "board");

  expect(reviewedTaskExecutor(db, review)).toBeUndefined();
  expect(assigneeNeedsApproval(db, review, "fake-worker", { assignable_to: [] })).toBe(true);
});

it("列を書かない review type の被レビュー task は、task_completed が無ければ最後の pickup の worker が Executor(ADR 0054 / ADR 0233 決定3)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-01-01T00:00:00Z");
  const reviewed = registerTask(db, { type: "review", title: "rv", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  pickupTask(db, reviewed, "worker-x", at);
  const review = registerTask(db, { type: "review", title: "r", purpose: "p", completion_criteria: "c", parent_id: reviewed.id }, at, ...HUMAN_WEBUI);

  expect(getTask(db, reviewed.id)!.assignee).toBeNull();
  expect(reviewedTaskExecutor(db, review)).toBe("worker-x");
});

const PERMISSIVE_AUDITOR_AUTHORITY: AuthorityProfile = {
  name: "permissive-auditor",
  guidance: "",
  // no assignable_to — unrestricted, were it ever consulted
};

it("review タスクの分解子を、レビュー対象タスクの assignee と異なる宛先にする割当は、review 自身の assignee(auditor)が resolveAuthority で無制限の authority を持っていても承認 question に変換される(exemption はレビュー対象の実行者だけに限定され、resolveAuthority は type 上書きにより一切参照されない)", async () => {
  t = await bootTidepool({
    resolveAuthority: (assignee) => (assignee === "auditor" ? PERMISSIVE_AUDITOR_AUTHORITY : undefined),
  });
  const reviewed = seed({ type: "work", title: "wire the moisture sensor 2", purpose: "purpose", completion_criteria: "criteria", assignee: "reef-crab" });
  markPickedUp(t.db, reviewed.id, t.clock.now(), "reef-crab");
  const review = seed({
    type: "review",
    title: "RCA for the sensor task 2",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: reviewed.id,
    assignee: "auditor",
  });
  await api(t.baseUrl, "POST", `/api/tasks/${review.id}/move`, { after: null });
  await t.clock.advance(HOUR); // review picked up

  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "found a root cause that needs a fix, but hands it elsewhere",
      children: [
        {
          title: "fix handed to someone else",
          purpose: "p",
          completion_criteria: "c",
          assignee: "someone-else",
        },
      ],
    },
  });
  await client.close();
  expect(res.isError ?? false).toBe(false);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "fix handed to someone else")).toBeUndefined();
  const question = board.find((x: any) => x.type === "question" && x.parent_id === review.id);
  expect(question).toBeDefined();
});

it("assignee の無い被レビュータスクの Executor は、最後の pickup ではなく最新の task_completed の worker になる(ADR 0054 / issue #1137)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-01-01T00:00:00Z");
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const write = (workerId: string, payload: TaskScopedPayload) =>
    appendEvent(db, { taskId: work.id, workerId, origin: "board", at, payload });
  write("worker-a", { kind: "task_picked_up" });
  write("worker-b", { kind: "task_completed", handoff_present: true, result: null });
  write("worker-c", { kind: "task_picked_up" });
  const review = registerTask(db, { type: "review", title: "r", purpose: "p", completion_criteria: "c", parent_id: work.id }, at, ...HUMAN_WEBUI);

  expect(work.assignee).toBeNull();
  expect(reviewedTaskExecutor(db, review)).toBe("worker-b");
});

/** #2374 の経路: 一度も pickup されていない親への人間の decompose → 異議 → commit が親の下に立てる auditor RCA と、
 *  その spawn(adapter と同じく `worker_spawned` を刻む)の id。 */
function auditorRcaUnderUnexecutedParent(db: Db, at: Date) {
  const parent = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  humanDecomposeTask(db, parent, { reason: "split the work", children: [{ title: "child", purpose: "p", completion_criteria: "c" }] }, at, undefined, "webui");
  raiseObjection(db, listEvents(db, parent.id).find((event) => event.kind === "decision_logged")!.id, "redo it", at);
  commitTriage(db, at, [], new Map(), { agentRegistered: () => false, resolvesToBuiltIn: () => true });
  const rca = listChildren(db, parent.id).find((child) => child.title.startsWith("rca (auditor)"))!;
  const spawned = appendEvent(db, { taskId: rca.id, workerId: "fugu", origin: "board", at, payload: WORKER_SPAWNED });
  return { parent: getTask(db, parent.id)!, rca, spawned };
}

it("実行前の親の下の RCA の Executor は、spawn の後に親が埋めつきで pickup されても「まだ居ない」のままで免除は成立せず、再 spawn は撮り直す(ADR 0295 決定1・2 / #2374)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00Z");
  const { parent, rca, spawned } = auditorRcaUnderUnexecutedParent(db, at);

  pickupTask(db, parent, "tako", at, { assignee: "tako" });

  expect(getTask(db, parent.id)!.assignee).toBe("tako");
  expect(reviewedTaskExecutor(db, rca, spawned)).toBeUndefined();
  expect(reviewedTaskExecutor(db, rca)).toBeUndefined();
  expect(assigneeNeedsApproval(db, rca, "tako", { assignable_to: [] })).toBe(true);
  appendEvent(db, { taskId: rca.id, workerId: "fugu", origin: "board", at, payload: WORKER_SPAWNED });
  expect(reviewedTaskExecutor(db, rca)).toBe("tako");
});

it("一度も pickup されていない親の assignee を Edit しても、RCA の Executor は動かない —— 列は実行の事実ではない(ADR 0295 決定1 / ADR 0233 決定5)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00Z");
  const { parent, rca } = auditorRcaUnderUnexecutedParent(db, at);

  editTask(db, parent, { assignee: "tako" }, at, "webui");

  expect(getTask(db, parent.id)!.assignee).toBe("tako");
  expect(reviewedTaskExecutor(db, rca)).toBeUndefined();
  expect(assigneeNeedsApproval(db, rca, "tako", { assignable_to: [] })).toBe(true);
});

it("review type の親が RCA の spawn の後に別の worker で再 pickup されても、その RCA の Executor は spawn までの pickup の worker のまま(ADR 0295 決定2 / #2373)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-21T00:00:00Z");
  const reviewed = registerTask(db, { type: "review", title: "rv", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const picked = pickupTask(db, reviewed, "worker-a", at)!;
  const rca = registerTask(db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: reviewed.id }, at, BOARD_WORKER_ID, "board");
  const spawned = appendEvent(db, { taskId: rca.id, workerId: "fugu", origin: "board", at, payload: WORKER_SPAWNED });

  returnToQueue(db, picked, { kind: "cap_interrupted" }, at);
  pickupTask(db, getTask(db, reviewed.id)!, "worker-b", at);

  expect(reviewedTaskExecutor(db, rca, spawned)).toBe("worker-a");
  expect(reviewedTaskExecutor(db, rca)).toBe("worker-a");
});

it("実行前の親の下の RCA の session の最中に親が pickup されても、その session の list_agents は親の worker を needs_approval のまま示し、宛てた修理は承認 question になる(ADR 0295 決定3 / #2374)", async () => {
  t = await bootTidepool({ listAgents: () => [{ name: "tako", description: "The parent's later executor" }] });
  const parent = seed({ type: "work", title: "wire the tide gauge", purpose: "purpose", completion_criteria: "criteria" });
  // 盤面名義の RCA(異議由来の auditor RCA の形 —— 人間名義の review 子は実行前の親に付かない、ADR 0292 決定2)
  const rca = registerTask(t.db, { type: "review", title: "RCA for the gauge", purpose: "p", completion_criteria: "c", parent_id: parent.id }, t.clock.now(), BOARD_WORKER_ID, "board");
  await api(t.baseUrl, "POST", `/api/tasks/${rca.id}/move`, { after: null });
  await t.clock.advance(HOUR); // RCA picked up
  // 偽の worker は `worker_spawned` を刻まないので、adapter の代わりに置く
  appendEvent(t.db, { taskId: rca.id, workerId: "fugu", origin: "board", at: t.clock.now(), payload: WORKER_SPAWNED });
  markPickedUp(t.db, parent.id, t.clock.now(), "tako");

  const client = await mcpClient(t.mcpBaseUrl, rca.id);
  const rosterResult: any = await client.callTool({ name: "list_agents", arguments: {} });
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "the parent's executor should repair it",
      children: [{ title: "repair by the later executor", purpose: "p", completion_criteria: "c", assignee: "tako" }],
    },
  });
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect({
    takoStatus: JSON.parse(rosterResult.content[0].text).agents.find((agent: any) => agent.name === "tako")?.status,
    repairRegistered: board.some((task: any) => task.title === "repair by the later executor"),
    approvalQuestionRegistered: board.some((task: any) => task.type === "question" && task.parent_id === rca.id),
  }).toEqual({ takoStatus: "needs_approval", repairRegistered: false, approvalQuestionRegistered: true });
});
