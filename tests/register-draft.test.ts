import { afterEach, expect, it } from "vitest";
import { FakeDraftClient } from "./fakes.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("without a configured DraftClient, drafting reports the LLM as unreachable so the UI falls back to the plain form", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/tasks/draft", {
    dump: "set up the greenhouse sensor, sloppy is fine here",
  });
  expect(res.status).toBe(503);
});

it("drafts structured fields from a brain-dump via the configured DraftClient", async () => {
  const draftClient = new FakeDraftClient();
  draftClient.scriptDraft({
    title: "set up the greenhouse sensor",
    purpose: "know soil moisture without walking out",
    completion_criteria: "dashboard shows a live moisture reading",
    assignee: "reef-crab",
    workspace: "tidepool",
    risk_flag: false,
  });
  t = await bootTidepool({ draftClient });

  const res = await api(t.baseUrl, "POST", "/api/tasks/draft", {
    dump: "set up the greenhouse sensor, sloppy is fine here",
  });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    title: "set up the greenhouse sensor",
    purpose: "know soil moisture without walking out",
    completion_criteria: "dashboard shows a live moisture reading",
    assignee: "reef-crab",
    workspace: "tidepool",
    risk_flag: false,
  });
  expect(draftClient.dumps).toEqual(["set up the greenhouse sensor, sloppy is fine here"]);
});

it("a DraftClient failure surfaces as 503, not a crash — the same outage signal as no client configured", async () => {
  const draftClient = new FakeDraftClient();
  draftClient.scriptFailure(new Error("claude CLI timed out"));
  t = await bootTidepool({ draftClient });

  const res = await api(t.baseUrl, "POST", "/api/tasks/draft", {
    dump: "set up the greenhouse sensor",
  });
  expect(res.status).toBe(503);
});

it("a drafted response registers unmodified through /api/tasks and appends to the queue tail — same API/data model as the plain form", async () => {
  const draftClient = new FakeDraftClient();
  draftClient.scriptDraft({
    title: "set up the greenhouse sensor",
    purpose: "know soil moisture without walking out",
    completion_criteria: "dashboard shows a live moisture reading",
    assignee: "reef-crab",
    workspace: "tidepool",
    risk_flag: true,
  });
  t = await bootTidepool({ draftClient });

  const drafted = await api(t.baseUrl, "POST", "/api/tasks/draft", {
    dump: "set up the greenhouse sensor, sloppy is fine here",
  });
  expect(drafted.status).toBe(200);

  const existing = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "water the tomatoes",
    purpose: "keep plants alive",
    completion_criteria: "soil moist to 5cm",
  });

  const registered = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    ...drafted.json,
  });
  expect(registered.status).toBe(201);
  expect(registered.json.title).toBe("set up the greenhouse sensor");
  expect(registered.json.assignee).toBe("reef-crab");
  expect(registered.json.workspace).toBe("tidepool");
  expect(registered.json.risk_flag).toBe(1);

  const list = await api(t.baseUrl, "GET", "/api/tasks");
  expect(list.json.map((x: any) => x.id)).toEqual([existing.json.id, registered.json.id]);
});
