import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

async function pendingDump(t: Tidepool, line: string) {
  await api(t.baseUrl, "POST", "/api/triage/start");
  const scratch = (await api(t.baseUrl, "POST", "/api/triage/scratchpad", { line })).json;
  await api(t.baseUrl, "POST", "/api/triage/close", {
    scratchpad: [{ id: scratch.id, disposition: "register" }],
  });
  return (await api(t.baseUrl, "GET", "/api/pending-dumps")).json.find(
    (d: any) => d.line === line,
  );
}

it("lists pending dumps in the order they were registered", async () => {
  t = await bootTidepool();
  await pendingDump(t, "first irritation");
  await pendingDump(t, "second irritation");

  const dumps = (await api(t.baseUrl, "GET", "/api/pending-dumps")).json;
  expect(dumps.map((d: any) => d.line)).toEqual(["first irritation", "second irritation"]);
});

it("discarding a pending dump removes it without registering a task", async () => {
  t = await bootTidepool();
  const dump = await pendingDump(t, "not worth writing up after all");

  const res = await api(t.baseUrl, "DELETE", `/api/pending-dumps/${dump.id}`);
  expect(res.status).toBe(200);

  const dumps = (await api(t.baseUrl, "GET", "/api/pending-dumps")).json;
  expect(dumps).toEqual([]);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.some((x: any) => x.title === "not worth writing up after all")).toBe(false);
});

it("a pending dump's line flows into the register flow and, once registered, the dump is consumed via the same delete", async () => {
  t = await bootTidepool();
  const dump = await pendingDump(t, "set up the greenhouse sensor, needs proper writeup");

  // Register screen: pick the pending dump → its line seeds the brain dump →
  // draft/plain form → confirm → POST /api/tasks, same data model
  // register-draft.test.ts exercises for issue #12's draft flow
  const registered = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "set up the greenhouse sensor",
    purpose: "know soil moisture without walking out",
    completion_criteria: "dashboard shows a live moisture reading",
  });
  expect(registered.status).toBe(201);

  // the client consumes the pending dump once registration succeeds
  const consumed = await api(t.baseUrl, "DELETE", `/api/pending-dumps/${dump.id}`);
  expect(consumed.status).toBe(200);

  const dumps = (await api(t.baseUrl, "GET", "/api/pending-dumps")).json;
  expect(dumps).toEqual([]);
});

it("an unknown pending dump id is a no-op delete, not an error", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "DELETE", "/api/pending-dumps/999999");
  expect(res.status).toBe(200);
});
