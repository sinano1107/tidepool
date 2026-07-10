import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

function makeAgentRegistered(known: string[]) {
  return (name: string) => known.includes(name);
}

it("registry に存在しない agent 名での登録は 400 で拒否される(ADR 0012 / issue #36: workspace 版と対称)", async () => {
  t = await bootTidepool({ agentRegistered: makeAgentRegistered(["deckhand"]) });

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "delegate to a made-up agent",
    purpose: "purpose",
    completion_criteria: "criteria",
    assignee: "not-a-real-agent",
  });

  expect(res.status).toBe(400);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board).toEqual([]);
});

it("registry に存在する agent 名での登録は通常どおり成功する", async () => {
  t = await bootTidepool({ agentRegistered: makeAgentRegistered(["deckhand", "navigator"]) });

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "delegate to a real agent",
    purpose: "purpose",
    completion_criteria: "criteria",
    assignee: "navigator",
  });

  expect(res.status).toBe(201);
  expect(res.json.assignee).toBe("navigator");
});

it("assignee: human は agentRegistered の対象外として常に受理される(human は registry の agent ではない)", async () => {
  t = await bootTidepool({ agentRegistered: makeAgentRegistered(["deckhand"]) });

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "register for a human",
    purpose: "purpose",
    completion_criteria: "criteria",
    assignee: "human",
  });

  expect(res.status).toBe(201);
  expect(res.json.assignee).toBe("human");
});

it("agentRegistered が configure されていなければ、どの agent 名でも登録できる(registry 未配線と同じ挙動)", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "no registry tracking",
    purpose: "purpose",
    completion_criteria: "criteria",
    assignee: "anything-goes",
  });

  expect(res.status).toBe(201);
});
