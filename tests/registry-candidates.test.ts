import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("without a configured registry, candidates are empty rather than an error", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "GET", "/api/registry/candidates");
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ assignees: [], workspaces: [] });
});

it("returns the configured assignee and workspace candidates", async () => {
  t = await bootTidepool({
    registryCandidates: {
      assignees: ["deckhand", "reef-crab", "human"],
      workspaces: ["tidepool", "sandbox"],
    },
  });

  const res = await api(t.baseUrl, "GET", "/api/registry/candidates");
  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    assignees: ["deckhand", "reef-crab", "human"],
    workspaces: ["tidepool", "sandbox"],
  });
});
