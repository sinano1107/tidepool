import { afterEach, expect, it } from "vitest";
import type { RegistryCandidates } from "../src/registry.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("without a configured registry, candidates are empty rather than an error", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "GET", "/api/registry/candidates");
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ assignees: [], workspaces: [], icons: {} });
});

it("returns the configured assignee and workspace candidates", async () => {
  t = await bootTidepool({
    registryCandidates: {
      assignees: ["deckhand", "reef-crab", "human"],
      workspaces: ["tidepool", "sandbox"],
      icons: {},
    },
  });

  const res = await api(t.baseUrl, "GET", "/api/registry/candidates");
  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    assignees: ["deckhand", "reef-crab", "human"],
    workspaces: ["tidepool", "sandbox"],
    icons: {},
  });
});

it("returns the configured icon for agents that have one, omitting agents without one (issue #52: AgentChip falls back to initials when absent)", async () => {
  t = await bootTidepool({
    registryCandidates: {
      assignees: ["deckhand", "tako", "human"],
      workspaces: ["tidepool"],
      icons: { tako: "🐙" },
    },
  });

  const res = await api(t.baseUrl, "GET", "/api/registry/candidates");
  expect(res.status).toBe(200);
  expect(res.json.icons).toEqual({ tako: "🐙" });
});

it("re-reads candidates per request, so an agent/workspace created live through settings shows up without a restart (issue #78)", async () => {
  // the provider stands in for the registry loader; mutating what it returns
  // is a settings-surface creation between two register-screen visits
  let snapshot: RegistryCandidates = { assignees: ["human"], workspaces: [], icons: {} };
  t = await bootTidepool({ registryCandidates: () => snapshot });

  const before = await api(t.baseUrl, "GET", "/api/registry/candidates");
  expect(before.json.assignees).toEqual(["human"]);
  expect(before.json.workspaces).toEqual([]);

  snapshot = { assignees: ["deckhand", "human"], workspaces: ["tidepool"], icons: {} };

  const after = await api(t.baseUrl, "GET", "/api/registry/candidates");
  // a boot-time snapshot would still report the first values here
  expect(after.json.assignees).toEqual(["deckhand", "human"]);
  expect(after.json.workspaces).toEqual(["tidepool"]);
});
