import { afterEach, expect, it } from "vitest";
import type { AuthorityProfile } from "../src/registry.js";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

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
