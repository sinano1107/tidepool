import { afterEach, expect, it } from "vitest";
import { reportProviderUsage } from "../src/throttle.js";
import { TRIAGE_TIMEOUT } from "../src/triage.js";
import { FakeAttributionClient } from "./fakes.js";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** Put one decision line in the log for the slot task and return its entry. */
async function loggedEntry(t: Tidepool, taskId: string, line: string) {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  await client.callTool({ name: "log_decision", arguments: { line } });
  await client.close();
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  return log.entries.find((e: any) => e.payload.line === line);
}

async function objectedWork(t: Tidepool, title: string, lines: string[]) {
  const task = await registerWork(t, title);
  await t.clock.advance(HOUR);
  const entries = [];
  for (const line of lines) entries.push(await loggedEntry(t, task.id, line));
  await api(t.baseUrl, "POST", "/api/triage/start");
  return { task, entries };
}

async function object(t: Tidepool, entryId: number, comment: string) {
  return (await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: entryId, comment }))
    .json.id as number;
}

async function children(t: Tidepool, taskId: string) {
  return (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((x: any) => x.parent_id === taskId);
}

async function attributions(t: Tidepool, taskId: string) {
  return (await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.filter(
    (e: any) => e.kind === "objection_attributed",
  );
}

it("好みの異議(preference)だけの commit では修理だけが立ち、帰責は entry ごとの判断種別の event に残る", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "naming", ["named the flag --dry"]);
  attributionClient.scriptJudgment(entries[0].id, {
    cause: "preference",
    evidence: "the steering asks for a different spelling of the same flag",
  });
  const objectionId = await object(t, entries[0].id, "call it --dry-run, that's what I'm used to");

  await api(t.baseUrl, "POST", "/api/triage/close");

  const kids = await children(t, task.id);
  expect(kids.map((x: any) => x.title)).toEqual(["repair: naming"]);
  expect(kids[0].purpose).toContain("call it --dry-run, that's what I'm used to");
  expect((await attributions(t, task.id)).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    [
      "tidepool",
      "board",
      {
        kind: "objection_attributed",
        entry_id: entries[0].id,
        objection_event_ids: [objectionId],
        cause: "preference",
        evidence: "the steering asks for a different spelling of the same flag",
        round: "initial",
      },
    ],
  ]);
  // the judgment is not a log entry: the human's decision log does not show it
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  expect(log.entries.some((e: any) => e.kind === "objection_attributed")).toBe(false);
});

it("同じタスクに好みと能力の異議が混ざると entry ごとに別の cause が残り、RCA の purpose には RCA を要する entry だけ、修理には全 entry が載る", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "mixed", ["named the flag --dry", "skipped the fixtures"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "preference", evidence: "spelling" });
  attributionClient.scriptJudgment(entries[1].id, { cause: "capability", evidence: "the fixtures were required" });
  await object(t, entries[0].id, "call it --dry-run");
  await object(t, entries[1].id, "bring the fixtures back");

  await api(t.baseUrl, "POST", "/api/triage/close");

  const kids = await children(t, task.id);
  expect(kids.map((x: any) => x.title).sort()).toEqual([
    "rca (auditor): mixed",
    "rca (self): mixed",
    "repair: mixed",
  ]);
  const repair = kids.find((x: any) => x.title === "repair: mixed");
  expect(repair.purpose).toBe(
    'objections raised against decisions of "mixed":\n\n' +
      "> named the flag --dry\n- call it --dry-run\n\n" +
      "> skipped the fixtures\n- bring the fixtures back",
  );
  expect(kids.find((x: any) => x.title === "rca (self): mixed").purpose).toBe(
    'objections raised against decisions fake-worker made on "mixed":\n\n' +
      "> skipped the fixtures\n- bring the fixtures back",
  );
  expect(kids.find((x: any) => x.title === "rca (auditor): mixed").purpose).toBe(
    'objections raised against decisions of "mixed":\n\n' +
      "> skipped the fixtures\n- bring the fixtures back",
  );
  expect((await attributions(t, task.id)).map((e: any) => [e.payload.entry_id, e.payload.cause])).toEqual([
    [entries[0].id, "preference"],
    [entries[1].id, "capability"],
  ]);
});

it("Board call の失敗は uncertain + 失敗理由の evidence になり、commit は止まらず RCA が立つ(他の entry の判定は生きる)", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "flaky", ["named the flag --dry", "skipped the fixtures"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "preference", evidence: "spelling" });
  attributionClient.scriptJudgment(entries[1].id, new Error("claude CLI timed out"));
  await object(t, entries[0].id, "call it --dry-run");
  await object(t, entries[1].id, "bring the fixtures back");

  const res = await api(t.baseUrl, "POST", "/api/triage/close");

  expect(res.json.outcome).toBe("closed_now");
  expect((await attributions(t, task.id)).map((e: any) => [e.payload.cause, e.payload.evidence])).toEqual([
    ["preference", "spelling"],
    ["uncertain", "Board call failed: claude CLI timed out"],
  ]);
  const kids = await children(t, task.id);
  expect(kids.map((x: any) => x.title).sort()).toEqual([
    "rca (auditor): flaky",
    "rca (self): flaky",
    "repair: flaky",
  ]);
  expect(kids.find((x: any) => x.title === "rca (self): flaky").purpose).not.toContain("--dry");
});

it("流し読みだけで閉じる経路(close_only)は Board call を呼ばず、異議は uncertain のまま従来どおり RCA が立つ", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "skimmed", ["picked the quick hack"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "preference", evidence: "would be ignored" });
  await object(t, entries[0].id, "do it properly");

  await api(t.baseUrl, "POST", "/api/triage/close", { close_only: true });

  expect(attributionClient.calls).toEqual([]);
  expect((await attributions(t, task.id)).map((e: any) => e.payload)).toMatchObject([
    {
      cause: "uncertain",
      evidence: "not attributed: the session was closed by close-only without a Board call",
    },
  ]);
  expect((await children(t, task.id)).map((x: any) => x.title).sort()).toEqual([
    "rca (auditor): skimmed",
    "rca (self): skimmed",
    "repair: skimmed",
  ]);
});

it("timeout の watchdog が閉じる session も Board call を呼ばず、異議は uncertain のまま従来どおり RCA が立つ", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "abandoned", ["skipped the fixtures"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "preference", evidence: "would be ignored" });
  await object(t, entries[0].id, "bring the fixtures back");

  await t.clock.advance(TRIAGE_TIMEOUT);

  expect(attributionClient.calls).toEqual([]);
  expect((await attributions(t, task.id)).map((e: any) => e.payload)).toMatchObject([
    {
      cause: "uncertain",
      evidence: "not attributed: the session was closed by the timeout watchdog without a Board call",
    },
  ]);
  expect((await children(t, task.id)).map((x: any) => x.title).sort()).toEqual([
    "rca (auditor): abandoned",
    "rca (self): abandoned",
    "repair: abandoned",
  ]);
});

it("人間が書いたエントリへの異議は capability でも self RCA を生まず、auditor RCA と修理だけが立つ", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const humanTask = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "approve the vendor invoice",
      purpose: "p",
      completion_criteria: "c",
      assignee: "human",
    })
  ).json;
  await api(t.baseUrl, "POST", `/api/tasks/${humanTask.id}/complete`, {});
  const humanEntry = (await api(t.baseUrl, "GET", "/api/log")).json.entries.find(
    (e: any) => e.kind === "task_completed" && e.task_id === humanTask.id,
  );
  attributionClient.scriptJudgment(humanEntry.id, { cause: "capability", evidence: "one signature" });
  await api(t.baseUrl, "POST", "/api/triage/start");
  await object(t, humanEntry.id, "this needed a second signature");

  await api(t.baseUrl, "POST", "/api/triage/close");

  expect((await children(t, humanTask.id)).map((x: any) => x.title).sort()).toEqual([
    "rca (auditor): approve the vendor invoice",
    "repair: approve the vendor invoice",
  ]);
});

it("Board call は異議されたエントリ本文・steering 列・当時の decision log(完了報告込み)を受け取り、model 名や価格は受け取らない", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const task = await registerWork(t, "context");
  await t.clock.advance(HOUR);
  const first = await loggedEntry(t, task.id, "chose plan B");
  await loggedEntry(t, task.id, "dropped the cache layer");
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({
    name: "complete_task",
    arguments: {
      handoff: {
        outcome: "shipped plan B",
        deliverables: "the code",
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
    },
  });
  await client.close();
  await api(t.baseUrl, "POST", "/api/triage/start");
  await object(t, first.id, "plan A was the agreed plan");
  await object(t, first.id, "and plan B breaks the fixtures");

  await api(t.baseUrl, "POST", "/api/triage/close");

  expect(attributionClient.calls).toEqual([
    {
      input: {
        entry_id: first.id,
        entry: "chose plan B",
        steering: ["plan A was the agreed plan", "and plan B breaks the fixtures"],
        decision_log: ["chose plan B", "dropped the cache layer", "completion report: shipped plan B"],
      },
      // the board's own frontier row (seed) pins the judge, never the worker's model
      setting: expect.objectContaining({ model: "fable", effort: "high" }),
    },
  ]);
});

it("Board call の model の窓が閉じている間は client を呼ばず、異議は throttled の evidence で uncertain になる", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "throttled", ["picked the quick hack"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "preference", evidence: "would be ignored" });
  await object(t, entries[0].id, "do it properly");
  reportProviderUsage(t.db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: t.clock.now(),
    windows: [
      {
        window: "fable",
        model: "fable",
        usedPercent: 100,
        durationMs: HOUR,
        resetsAt: new Date(t.clock.now().getTime() + HOUR),
        throttled: true,
        resumesAt: new Date(t.clock.now().getTime() + HOUR),
      },
    ],
  });

  await api(t.baseUrl, "POST", "/api/triage/close");

  expect(attributionClient.calls).toEqual([]);
  expect((await attributions(t, task.id)).map((e: any) => e.payload)).toMatchObject([
    { cause: "uncertain", evidence: "Board call not made: the Anthropic window is closed (throttled)" },
  ]);
});

it("requirement_change / environment だけの commit でも修理だけが立つ", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "shifted", ["kept the v1 endpoint", "retried the flaky mirror"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "requirement_change", evidence: "v2 came later" });
  attributionClient.scriptJudgment(entries[1].id, { cause: "environment", evidence: "mirror outage" });
  await object(t, entries[0].id, "we moved to v2 yesterday");
  await object(t, entries[1].id, "use the primary mirror");

  await api(t.baseUrl, "POST", "/api/triage/close");

  expect((await children(t, task.id)).map((x: any) => x.title)).toEqual(["repair: shifted"]);
});
