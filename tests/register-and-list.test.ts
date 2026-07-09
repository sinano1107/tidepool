import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("a registered task joins the queue tail and can be listed", async () => {
  t = await bootTidepool();

  const first = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "set up the greenhouse sensor",
    purpose: "know soil moisture without walking out",
    completion_criteria: "dashboard shows a live moisture reading",
  });
  expect(first.status).toBe(201);
  expect(first.json.id).toBeTruthy();
  expect(first.json.status).toBe("todo");

  const second = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "water the tomatoes",
    purpose: "keep plants alive",
    completion_criteria: "soil moist to 5cm",
  });

  const list = await api(t.baseUrl, "GET", "/api/tasks");
  expect(list.status).toBe(200);
  expect(list.json.map((x: any) => x.id)).toEqual([first.json.id, second.json.id]);
  expect(list.json.map((x: any) => x.status)).toEqual(["todo", "todo"]);

  const got = await api(t.baseUrl, "GET", `/api/tasks/${first.json.id}`);
  expect(got.status).toBe(200);
  expect(got.json.purpose).toBe("know soil moisture without walking out");
});

it("registration accepts assignee, workspace, and risk_flag — the same fields a brain-dump draft fills in", async () => {
  t = await bootTidepool();

  const registered = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "add usage-limit gate to hourly poll",
    purpose: "stop starting tasks when any rate-limit window is rejected",
    completion_criteria: "rejected window blocks new starts; resumes at resets_at",
    assignee: "reef-crab",
    workspace: "tidepool",
    risk_flag: true,
  });
  expect(registered.status).toBe(201);
  expect(registered.json.assignee).toBe("reef-crab");
  expect(registered.json.workspace).toBe("tidepool");
  expect(registered.json.risk_flag).toBe(1);

  const got = await api(t.baseUrl, "GET", `/api/tasks/${registered.json.id}`);
  expect(got.json.assignee).toBe("reef-crab");
  expect(got.json.workspace).toBe("tidepool");
  expect(got.json.risk_flag).toBe(1);
});
