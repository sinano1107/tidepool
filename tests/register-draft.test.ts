import { afterEach, expect, it } from "vitest";
import { BoardCallUsageError, listBoardCalls } from "../src/board-call-usage.js";
import { CliAuthError } from "../src/cli-auth.js";
import { BOARD_CALL_USAGE, FakeDraftClient } from "./fakes.js";
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

it("a task draft leaves one task_draft row with the row the call ran on (ADR 0299 決定1)", async () => {
  const draftClient = new FakeDraftClient();
  t = await bootTidepool({ draftClient });

  await api(t.baseUrl, "POST", "/api/tasks/draft", { dump: "set up the greenhouse sensor" });

  const rows = listBoardCalls(t.db);
  expect(rows).toEqual([
    { use: "task_draft", ...draftClient.setting, fragments: null, usage: BOARD_CALL_USAGE, createdAt: t.clock.now().toISOString() },
  ]);
});

it("a draft that failed after its CLI reported usage still 503s and still leaves its task_draft row (ADR 0299 決定3)", async () => {
  const draftClient = new FakeDraftClient();
  draftClient.scriptFailure(new BoardCallUsageError("answer did not match the schema", draftClient.setting, BOARD_CALL_USAGE));
  t = await bootTidepool({ draftClient });

  const res = await api(t.baseUrl, "POST", "/api/tasks/draft", { dump: "set up the greenhouse sensor" });

  expect(res.status).toBe(503);
  const rows = listBoardCalls(t.db);
  expect(rows.map((row) => row.use)).toEqual(["task_draft"]);
});

it("a draft that ended with a 401 still 503s and leaves no row (ADR 0299 決定3)", async () => {
  const draftClient = new FakeDraftClient();
  draftClient.scriptFailure(new CliAuthError("Invalid API key"));
  t = await bootTidepool({ draftClient });

  const res = await api(t.baseUrl, "POST", "/api/tasks/draft", { dump: "set up the greenhouse sensor" });

  expect(res.status).toBe(503);
  const rows = listBoardCalls(t.db);
  expect(rows).toEqual([]);
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
    review_flag: true,
  });
  t = await bootTidepool({ draftClient });

  const drafted = await api(t.baseUrl, "POST", "/api/tasks/draft", {
    dump: "set up the greenhouse sensor, sloppy is fine here",
  });
  expect(drafted.status).toBe(200);

  // 下書きの review_flag をそのまま送れるのは子追加だけ(ルートは flag によらずレビューされる、issue #1467)。
  // 親は human 担当にして slot を取らせず(走行中の親には子を足せない)、risk の子が承認 question に変わらないよう
  // 親にも risk を付ける
  const existing = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "water the tomatoes",
    purpose: "keep plants alive",
    completion_criteria: "soil moist to 5cm",
    assignee: "human",
    risk_flag: true,
  });

  const registered = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    parent_id: existing.json.id,
    decompose_reason: "split the sensor out",
    ...drafted.json,
  });
  expect(registered.status).toBe(201);
  expect(registered.json.title).toBe("set up the greenhouse sensor");
  expect(registered.json.assignee).toBe("reef-crab");
  expect(registered.json.workspace).toBe("tidepool");
  expect(registered.json.risk_flag).toBe(1);
  expect(registered.json.review_flag).toBe(1);

  const list = await api(t.baseUrl, "GET", "/api/tasks");
  expect(list.json.map((x: any) => x.id)).toEqual([existing.json.id, registered.json.id]);
});
