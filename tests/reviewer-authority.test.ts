import { afterEach, expect, it } from "vitest";
import type { AuthorityProfile } from "../src/registry.js";
import { api, bootTidepool, FULL_HANDOFF, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

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
  const reviewed = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "wire the moisture sensor",
      purpose: "purpose",
      completion_criteria: "criteria",
      assignee: "reef-crab",
    })
  ).json;
  const review = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "RCA for the sensor task",
      purpose: "purpose",
      completion_criteria: "criteria",
      parent_id: reviewed.id,
      assignee: "auditor",
    })
  ).json;
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
      review_flag: true,
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

it("task_completed が無ければ最後の pickup executor を修理先にでき、pickup 自体が無ければ免除は成立しない(ADR 0054 / issue #217)", async () => {
  t = await bootTidepool();
  const pickedParent = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "unfinished reviewed work",
      purpose: "purpose",
      completion_criteria: "criteria",
    })
  ).json;
  await t.clock.advance(HOUR); // picked up as fake-worker, but never completed
  const parentClient = await mcpClient(t.mcpBaseUrl, pickedParent.id);
  await parentClient.callTool({
    name: "log_decision",
    arguments: { line: "the unfinished decision under review" },
  });
  const entry = (await api(t.baseUrl, "GET", "/api/log")).json.entries.find(
    (event: any) => event.payload.line === "the unfinished decision under review",
  );
  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "repair the unfinished decision",
  });
  await api(t.baseUrl, "POST", "/api/triage/commit");
  const pickedParentReview = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) =>
      task.type === "review" &&
      task.parent_id === pickedParent.id &&
      task.title.startsWith("rca (auditor):"),
  );
  await parentClient.callTool({
    name: "decompose",
    arguments: {
      reason: "pause the unfinished parent without completing it",
      children: [{ title: "remaining work", purpose: "p", completion_criteria: "c" }],
    },
  });
  await parentClient.close();
  await api(t.baseUrl, "POST", `/api/tasks/${pickedParentReview.id}/move`, { after: null });
  await t.clock.advance(HOUR); // auditor review picked up
  const pickedReviewClient = await mcpClient(t.mcpBaseUrl, pickedParentReview.id);
  await pickedReviewClient.callTool({
    name: "decompose",
    arguments: {
      reason: "return the repair to the recorded executor",
      children: [
        {
          title: "repair unfinished work",
          purpose: "p",
          completion_criteria: "c",
          assignee: "fake-worker",
        },
      ],
    },
  });
  await pickedReviewClient.close();
  const pickedBoard = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const pickedParentVerdict = {
    repairRegistered: pickedBoard.some((task: any) => task.title === "repair unfinished work"),
    approvalQuestionRegistered: pickedBoard.some(
      (task: any) => task.type === "question" && task.parent_id === pickedParentReview.id,
    ),
  };

  await t.stop();
  t = await bootTidepool();
  const untouchedParent = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "untouched reviewed work",
      purpose: "purpose",
      completion_criteria: "criteria",
    })
  ).json;
  const untouchedParentReview = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "review untouched work",
      purpose: "purpose",
      completion_criteria: "criteria",
      parent_id: untouchedParent.id,
      assignee: "auditor",
    })
  ).json;
  await api(t.baseUrl, "POST", `/api/tasks/${untouchedParentReview.id}/move`, { after: null });
  await t.clock.advance(HOUR); // review picked up before its untouched parent
  const untouchedReviewClient = await mcpClient(t.mcpBaseUrl, untouchedParentReview.id);
  await untouchedReviewClient.callTool({
    name: "decompose",
    arguments: {
      reason: "there is no executor to exempt",
      children: [
        {
          title: "repair untouched work",
          purpose: "p",
          completion_criteria: "c",
          assignee: "fake-worker",
        },
      ],
    },
  });
  await untouchedReviewClient.close();
  const untouchedBoard = (await api(t.baseUrl, "GET", "/api/tasks")).json;

  expect({
    pickedParent: pickedParentVerdict,
    untouchedParent: {
      repairRegistered: untouchedBoard.some(
        (task: any) => task.title === "repair untouched work",
      ),
      approvalQuestionRegistered: untouchedBoard.some(
        (task: any) => task.type === "question" && task.parent_id === untouchedParentReview.id,
      ),
    },
  }).toEqual({
    pickedParent: { repairRegistered: true, approvalQuestionRegistered: false },
    untouchedParent: { repairRegistered: false, approvalQuestionRegistered: true },
  });
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
  const reviewed = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "wire the moisture sensor 2",
      purpose: "purpose",
      completion_criteria: "criteria",
      assignee: "reef-crab",
    })
  ).json;
  const review = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "RCA for the sensor task 2",
      purpose: "purpose",
      completion_criteria: "criteria",
      parent_id: reviewed.id,
      assignee: "auditor",
    })
  ).json;
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
