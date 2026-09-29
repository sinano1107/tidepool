import { afterEach, expect, it } from "vitest";
import type { Cause } from "../src/cause.js";
import { openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { readMemory, recordKnowledge, searchMemory } from "../src/memory.js";
import { attributeObjections, type GatedJudgment, refireRetrospectiveCalls } from "../src/retrospective.js";
import { cancelTaskDirectly, listChildren, logDecision, registerTask } from "../src/tasks.js";
import { reportProviderUsage } from "../src/throttle.js";
import { commitTriage, raiseObjection, startTriage, TRIAGE_TIMEOUT } from "../src/triage.js";
import { FakeAttributionClient, FakeBehaviorDraftClient, noRetrospectiveCalls } from "./fakes.js";
import {
  api,
  bootTidepool,
  children,
  commit,
  completeIntegrationReviews,
  completeViaMcp,
  FULL_HANDOFF,
  HOUR,
  haltedRefires,
  KEEP_FIXTURES,
  loggedEntry,
  managementMcpClient,
  mcpClient,
  memoryEntries,
  nextPoll,
  object,
  objectedForDraft,
  propose,
  registerWork,
  runNow,
  type Tidepool,
  WORKER_SPAWNED,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

async function objectedWork(t: Tidepool, title: string, lines: string[]) {
  const task = await registerWork(t, title);
  await t.clock.advance(HOUR);
  const entries = [];
  for (const line of lines) entries.push(await loggedEntry(t, task.id, line));
  await api(t.baseUrl, "POST", "/api/triage/start");
  return { task, entries };
}

async function attributions(t: Tidepool, taskId: string) {
  return (await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.filter(
    (e: any) => e.kind === "objection_attributed",
  );
}

const attributionsFailed = async (t: Tidepool, taskId: string) =>
  (await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.filter((e: any) => e.kind === "objection_attribution_failed");

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
        entries: null,
        round: "initial",
      },
    ],
  ]);
  // the judgment is not a log entry: the human's decision log does not show it
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  expect(log.entries.some((e: any) => e.kind === "objection_attributed")).toBe(false);
});

it.each(["capability", "task_ambiguity", "missing_information"] as const)(
  "同じタスクに好みと %s の異議が混ざると entry ごとに別の cause が残り、RCA の purpose には RCA を要する entry だけ、修理には全 entry が載る",
  async (rcaCause) => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "mixed", ["named the flag --dry", "skipped the fixtures"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "preference", evidence: "spelling" });
  attributionClient.scriptJudgment(entries[1].id, { cause: rcaCause, evidence: "the fixtures were required" });
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
    [entries[1].id, rcaCause],
  ]);
  },
);

it("初回の Board call の失敗は帰責を書かず round initial の失敗 event を残し、commit は止まらず RCA が立つ(他の entry の判定は生きる)", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "flaky", ["named the flag --dry", "skipped the fixtures"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "preference", evidence: "spelling" });
  attributionClient.scriptJudgment(entries[1].id, new Error("claude CLI timed out"));
  await object(t, entries[0].id, "call it --dry-run");
  await object(t, entries[1].id, "bring the fixtures back");

  const res = await api(t.baseUrl, "POST", "/api/triage/close");

  expect(res.json.outcome).toBe("closed_now");
  expect((await attributions(t, task.id)).map((e: any) => [e.payload.entry_id, e.payload.cause])).toEqual([
    [entries[0].id, "preference"],
  ]);
  expect((await attributionsFailed(t, task.id)).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    ["tidepool", "board", { kind: "objection_attribution_failed", entry_id: entries[1].id, objection_event_id: expect.any(Number), round: "initial", reason: "Board call failed: claude CLI timed out" }],
  ]);
  const kids = await children(t, task.id);
  expect(kids.map((x: any) => x.title).sort()).toEqual([
    "rca (auditor): flaky",
    "rca (self): flaky",
    "repair: flaky",
  ]);
  expect(kids.find((x: any) => x.title === "rca (self): flaky").purpose).not.toContain("--dry");
});

it("容器の前提が成り立たない間の commit は初回の Board call を撃たず、帰責も失敗 event も書かず、RCA が立つ", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "no containment", ["skipped the fixtures"]);
  // 実物の client は前提が不成立だと spawn できずに投げる
  attributionClient.scriptJudgment(entries[0].id, new Error("Board call container precondition failed"));
  await object(t, entries[0].id, "bring the fixtures back");
  t.containers.scriptPreflight("cgroup v2 is not mounted at /sys/fs/cgroup");

  await api(t.baseUrl, "POST", "/api/triage/close");

  expect(attributionClient.calls).toEqual([]);
  expect(await attributions(t, task.id)).toEqual([]);
  expect(await attributionsFailed(t, task.id)).toEqual([]);
  expect((await children(t, task.id)).map((x: any) => x.title).sort()).toEqual([
    "rca (auditor): no containment",
    "rca (self): no containment",
    "repair: no containment",
  ]);
});

it.each([
  ["close-only", () => api(t.baseUrl, "POST", "/api/triage/close", { close_only: true })],
  ["the timeout watchdog", () => t.clock.advance(TRIAGE_TIMEOUT)],
])("%s で閉じる session は Board call を呼ばず帰責の event を1つも書かず、従来どおり RCA が立つ", async (_path, close) => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "skimmed", ["picked the quick hack"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "preference", evidence: "would be ignored" });
  await object(t, entries[0].id, "do it properly");

  await close();

  expect(attributionClient.calls).toEqual([]);
  expect(await attributions(t, task.id)).toEqual([]);
  expect(await attributionsFailed(t, task.id)).toEqual([]);
  expect((await children(t, task.id)).map((x: any) => x.title).sort()).toEqual([
    "rca (auditor): skimmed",
    "rca (self): skimmed",
    "repair: skimmed",
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
    arguments: { handoff: { ...FULL_HANDOFF, outcome: "shipped plan B" } },
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
        memory_read: [],
      },
      // the board's own frontier row (seed) pins the judge, never the worker's model
      setting: expect.objectContaining({ model: "fable", effort: "high" }),
    },
  ]);
});

it("Board call の model の窓が閉じている間は client を呼ばず、帰責の event を1つも書かず、commit は RCA を立てる", async () => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "throttled", ["picked the quick hack"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "preference", evidence: "would be ignored" });
  await object(t, entries[0].id, "do it properly");
  reportFableWindow(t, true);

  await api(t.baseUrl, "POST", "/api/triage/close");

  expect(attributionClient.calls).toEqual([]);
  expect(await attributions(t, task.id)).toEqual([]);
  expect(await attributionsFailed(t, task.id)).toEqual([]);
  expect((await children(t, task.id)).map((x: any) => x.title).sort()).toEqual([
    "rca (auditor): throttled",
    "rca (self): throttled",
    "repair: throttled",
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

/** 完了済みの work に異議を打って commit まで進める(`initial` 未指定 = Fake は未スクリプトの
 *  まま = 初回は uncertain)。完了時に立った統合 review は残る(slot を使う test が片付ける)。 */
async function objectedAndCommitted(title: string, initial?: { cause: Cause; evidence: string }) {
  const attributionClient = new FakeAttributionClient();
  const t = await bootTidepool({ attributionClient });
  const task = await registerWork(t, title);
  await t.clock.advance(HOUR);
  const entry = await loggedEntry(t, task.id, "skipped the fixtures");
  if (initial) attributionClient.scriptJudgment(entry.id, initial);
  await completeViaMcp(t, task.id);
  await api(t.baseUrl, "POST", "/api/triage/start");
  await object(t, entry.id, "bring the fixtures back");
  await api(t.baseUrl, "POST", "/api/triage/close");
  const kids = await children(t, task.id);
  return {
    t,
    attributionClient,
    task,
    entry,
    self: kids.find((x: any) => x.title === `rca (self): ${title}`),
    auditor: kids.find((x: any) => x.title === `rca (auditor): ${title}`),
  };
}

/** 次に空く slot を self RCA に回し、auditor RCA を最後尾へ下げる(どちらも Run now でない
 *  並べ替えなので poll を撃たない)。後始末の完走が pickup の契機なので(ADR 0119 決定3)、
 *  slot は空いた瞬間に先頭へ渡る —— 待たせたい auditor を先頭に残しておくと、それが拾われて
 *  直接 cancel できなくなる。 */
async function lineUpSelfRca(t: Tidepool, selfId: string, auditorId: string) {
  await api(t.baseUrl, "POST", `/api/tasks/${selfId}/move`, { after: null });
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  await api(t.baseUrl, "POST", `/api/tasks/${auditorId}/move`, { after: board.at(-1).id });
}

/** RCA 子を worker として決着させる: 先頭へ移して pickup、所見を1行 log して完了。 */
async function settleRca(t: Tidepool, reviewId: string, finding: string, outcome: string) {
  await api(t.baseUrl, "POST", `/api/tasks/${reviewId}/move`, { after: null });
  // 先頭での2回目の move が Run now(harness の completeIntegrationReviews と同じ)
  await api(t.baseUrl, "POST", `/api/tasks/${reviewId}/move`, { after: null });
  const client = await mcpClient(t.mcpBaseUrl, reviewId);
  await client.callTool({ name: "log_decision", arguments: { line: finding } });
  await client.callTool({ name: "complete_task", arguments: { handoff: { outcome } } });
  await client.close();
}

it("uncertain の entry は RCA 子がすべて決着した後に1度だけ第2回が走り、RCA の findings を証拠にした cause が追記される(初回は消えず、1つでも未決着なら走らない)", async () => {
  const s = await objectedAndCommitted("uncertain");
  t = s.t;
  await lineUpSelfRca(t, s.self.id, s.auditor.id);
  await completeIntegrationReviews(t, s.task.id);
  expect((await attributions(t, s.task.id)).map((e: any) => [e.payload.cause, e.payload.round])).toEqual([
    ["uncertain", "initial"],
  ]);
  s.attributionClient.scriptJudgment(s.entry.id, {
    cause: "capability",
    evidence: "the self RCA found the criteria named the fixtures",
  });

  await settleRca(t, s.self.id, "the criteria named the fixtures explicitly", "fixtures were required");

  // the auditor RCA is still open: no second round yet
  expect(s.attributionClient.calls).toHaveLength(1);
  expect(await attributions(t, s.task.id)).toHaveLength(1);

  await api(t.baseUrl, "POST", `/api/tasks/${s.auditor.id}/cancel`, {});
  await nextPoll(t);

  expect((await attributions(t, s.task.id)).map((e: any) => e.payload)).toEqual([
    expect.objectContaining({ entry_id: s.entry.id, cause: "uncertain", round: "initial" }),
    {
      kind: "objection_attributed",
      entry_id: s.entry.id,
      objection_event_ids: [expect.any(Number)],
      cause: "capability",
      evidence: "the self RCA found the criteria named the fixtures",
      entries: null,
      round: "after_rca",
    },
  ]);
  expect(s.attributionClient.calls[1]?.input).toEqual({
    entry_id: s.entry.id,
    entry: "skipped the fixtures",
    steering: ["bring the fixtures back"],
    decision_log: ["skipped the fixtures", "completion report: done as specified"],
    memory_read: [],
    rca_findings: ["the criteria named the fixtures explicitly", "completion report: fixtures were required"],
  });
});

it("初回で uncertain が無いタスクでは RCA 子がすべて決着しても第2回は走らない", async () => {
  const s = await objectedAndCommitted("decided", { cause: "capability", evidence: "clear" });
  t = s.t;

  const self = await api(t.baseUrl, "POST", `/api/tasks/${s.self.id}/cancel`, {});
  const auditor = await api(t.baseUrl, "POST", `/api/tasks/${s.auditor.id}/cancel`, {});
  await nextPoll(t);

  expect([self.json.status, auditor.json.status]).toEqual(["cancelled", "cancelled"]);
  expect(s.attributionClient.calls).toHaveLength(1);
  expect((await attributions(t, s.task.id)).map((e: any) => e.payload.round)).toEqual(["initial"]);
});

it("ログの HTTP / 管理 MCP 読取は異議の隣に最新の cause を返す", async () => {
  const s = await objectedAndCommitted("read attribution");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, {
    cause: "capability",
    evidence: "RCA found that the implementation skipped an explicit criterion",
  });
  await api(t.baseUrl, "POST", `/api/tasks/${s.self.id}/cancel`, {});
  await api(t.baseUrl, "POST", `/api/tasks/${s.auditor.id}/cancel`, {});
  await nextPoll(t);

  const httpEntry = (await api(t.baseUrl, "GET", "/api/log")).json.entries.find(
    (entry: any) => entry.id === s.entry.id,
  );
  expect(httpEntry).toMatchObject({
    objections: [{ comment: "bring the fixtures back", session_id: expect.any(Number) }],
    cause: "capability",
  });

  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({ name: "read_decision_log", arguments: {} });
    const log = JSON.parse(result.content[0].text);
    expect(log.entries.find((entry: any) => entry.id === s.entry.id)).toMatchObject({
      objections: [{ comment: "bring the fixtures back", session_id: expect.any(Number) }],
      cause: "capability",
    });
  } finally {
    await client.close();
  }
});

// Board call の Behavior candidate 起草(ADR 0120 決定1(b)(c) / issue #617)

const draftsFailed = async (t: Tidepool, taskId: string) =>
  (await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.filter((e: any) => e.kind === "memory_draft_failed");

it.each([
  ["worker", (t: Tidepool) => t.worker.id],
  ["all", () => null],
] as const)(
  "初回の帰責が preference のエントリは commit が促す次の poll で Board call が起草し、author board・出所 = 帰責 event・scope = task の workspace・宛先 = Board call の %s の candidate が載る",
  async (addressee, expected) => {
    const s = await objectedForDraft("naming", { initial: { cause: "preference", evidence: "taste" } });
    t = s.t;
    await api(t.baseUrl, "POST", "/api/settings/memory/definitions", { workspace: "charts", path: "testing", text: "how tests are run" });
    s.behaviorDraftClient.scriptDraft(s.entry.id, { path: "testing/fixtures", title: "Keep fixtures", text: "Always keep the fixtures.", addressee });

    await commit(t, s.task.id, "naming");

    const [attributionEvent] = await attributions(t, s.task.id);
    expect((await memoryEntries(t)).filter((e: any) => e.kind === "behavior")).toEqual([
      expect.objectContaining({
        state: "candidate",
        scope: "charts",
        path: "testing/fixtures",
        title: "Keep fixtures",
        text: "Always keep the fixtures.",
        addressee: expected(t),
        source: { kind: "event", ref: attributionEvent.id },
        author: { activity: "board", name: "tidepool" },
      }),
    ]);
    expect(s.behaviorDraftClient.calls).toEqual([
      {
        input: {
          entry_id: s.entry.id,
          entry: "skipped the fixtures",
          steering: ["always keep the fixtures"],
          decision_log: ["skipped the fixtures", "completion report: done as specified"],
          memory_read: [],
          index: expect.stringContaining("testing/ — how tests are run"),
        },
        setting: expect.objectContaining({ model: "fable", effort: "high" }),
      },
    ]);
  },
);

it("盤面設定 retrospective_tier を standard にすると、帰責の判定も Behavior candidate の起草も anthropic × standard の行で撃たれる(issue #914)", async () => {
  const s = await objectedForDraft("tiered-draft", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "retrospective_tier", value: "standard" })).status).toBe(200);
  s.behaviorDraftClient.scriptDraft(s.entry.id, { path: "testing/fixtures", title: "Keep fixtures", text: "Always keep the fixtures.", addressee: "all" });

  await commit(t, s.task.id, "tiered-draft");

  expect(s.attributionClient.calls).toEqual([
    expect.objectContaining({ setting: expect.objectContaining({ model: "opus", effort: "high" }) }),
  ]);
  expect(s.behaviorDraftClient.calls).toEqual([
    expect.objectContaining({ setting: expect.objectContaining({ model: "opus", effort: "high" }) }),
  ]);
});

it("選んだティアの anthropic 行が無ければ、帰責も起草も client を呼ばず帰責の event も書かず、commit から例外は出ない(issue #914)", async () => {
  // preference を scriptJudgment しても、行が無ければ帰責自身の Board call が撃てず判断が無いので
  // 起草の条件(初回は preference のみ)に届かない —— 3用途は同じ欄を共有する(ADR 0111 追記4)
  const s = await objectedForDraft("tiered-draft-fail", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "retrospective_tier", value: "standard" })).status).toBe(200);
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "anthropic", model: "opus" })).status).toBe(200);

  const { res } = await commit(t, s.task.id, "tiered-draft-fail");

  expect(res.json.outcome).toBe("closed_now");
  expect(s.attributionClient.calls).toEqual([]);
  expect(s.behaviorDraftClient.calls).toEqual([]);
  expect(await attributions(t, s.task.id)).toEqual([]);
  expect(await attributionsFailed(t, s.task.id)).toEqual([]);
  expect(await memoryEntries(t)).toEqual([]);
});

it.each([
  ["preference", null],
  ["capability", "worker"],
  ["task_ambiguity", "planner"],
  ["missing_information", "planner"],
] as const)(
  "第2回で %s に確定すると RCA の findings を入力に Board call が起草し、宛先は cause から導出される(Board call の addressee は preference だけが読む)",
  async (cause, addressee) => {
    const s = await objectedForDraft("second", { registrant: "planner" });
    t = s.t;
    const { self, auditor } = await commit(t, s.task.id, "second");
    expect(s.behaviorDraftClient.calls).toEqual([]);
    s.attributionClient.scriptJudgment(s.entry.id, { cause, evidence: "the RCA decided it" });
    s.behaviorDraftClient.scriptDraft(s.entry.id, { path: "testing/fixtures", title: "Keep fixtures", text: "Always keep the fixtures.", addressee: "all" });
      const repair = (await children(t, s.task.id)).find((x: any) => x.title === "repair: second");
    await lineUpSelfRca(t, self.id, auditor.id);
    await completeViaMcp(t, repair.id);

    await settleRca(t, self.id, "the criteria named the fixtures", "fixtures were required");
    await api(t.baseUrl, "POST", `/api/tasks/${auditor.id}/cancel`, {});
    await nextPoll(t);

    const second = (await attributions(t, s.task.id)).find((e: any) => e.payload.round === "after_rca");
    expect((await memoryEntries(t)).filter((e: any) => e.kind === "behavior")).toEqual([
      expect.objectContaining({
        scope: "charts",
        addressee: addressee === "worker" ? t.worker.id : addressee,
        source: { kind: "event", ref: second.id },
        author: { activity: "board", name: "tidepool" },
      }),
    ]);
    expect(s.behaviorDraftClient.calls.map((c) => c.input)).toEqual([
      expect.objectContaining({
        entry_id: s.entry.id,
        rca_findings: ["the criteria named the fixtures", "completion report: fixtures were required"],
      }),
    ]);
  },
);

it.each(["requirement_change", "environment"] as const)(
  "第2回で %s に確定した場合は起草しない",
  async (cause) => {
    const s = await objectedForDraft("unlearned");
    t = s.t;
    const { self, auditor } = await commit(t, s.task.id, "unlearned");
    s.attributionClient.scriptJudgment(s.entry.id, { cause, evidence: "outside the worker" });

    await api(t.baseUrl, "POST", `/api/tasks/${self.id}/cancel`, {});
    await api(t.baseUrl, "POST", `/api/tasks/${auditor.id}/cancel`, {});
    await nextPoll(t);

    expect((await attributions(t, s.task.id)).map((e: any) => e.payload.cause)).toEqual(["uncertain", cause]);
    expect(s.behaviorDraftClient.calls).toEqual([]);
    expect(await draftsFailed(t, s.task.id)).toEqual([]);
  },
);

it("人間が書いたエントリは preference でも起草しない", async () => {
  const s = await objectedForDraft("by hand", { human: true, initial: { cause: "preference", evidence: "taste" } });
  t = s.t;

  await commit(t, s.task.id, "by hand");

  expect((await attributions(t, s.task.id)).map((e: any) => e.payload.cause)).toEqual(["preference"]);
  expect(s.behaviorDraftClient.calls).toEqual([]);
  expect(await memoryEntries(t)).toEqual([]);
});

it("commit が促す poll の起草の Board call が失敗すると memory_draft_failed を残し、初回の帰責の event と commit の応答はそのまま", async () => {
  const s = await objectedForDraft("flaky draft", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));

  const { res } = await commit(t, s.task.id, "flaky draft");

  expect(res.json.outcome).toBe("closed_now");
  expect((await attributions(t, s.task.id)).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    [
      "tidepool",
      "board",
      {
        kind: "objection_attributed",
        entry_id: s.entry.id,
        objection_event_ids: [expect.any(Number)],
        cause: "preference",
        evidence: "taste",
        entries: null,
        round: "initial",
      },
    ],
  ]);
  expect((await draftsFailed(t, s.task.id)).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    [
      "tidepool",
      "board",
      { kind: "memory_draft_failed", entry_id: s.entry.id, round: "initial", attribution_event_id: expect.any(Number), reason: "claude CLI timed out" },
    ],
  ]);
  expect(await memoryEntries(t)).toEqual([]);
});

/** 第2回の帰責を `cause` に確定させる(RCA 子は2つとも cancel)。 */
async function settleSecondRound(t: Tidepool, s: { attributionClient: FakeAttributionClient; task: any; entry: any }, title: string, cause: Cause) {
  const { self, auditor } = await commit(t, s.task.id, title);
  s.attributionClient.scriptJudgment(s.entry.id, { cause, evidence: "decided after the RCA" });
  await api(t.baseUrl, "POST", `/api/tasks/${self.id}/cancel`, {});
  return api(t.baseUrl, "POST", `/api/tasks/${auditor.id}/cancel`, {});
}

it("workspace を持たない task は Memory の置き場が無いので、起草の呼び出しも失敗 event も無い(1時間後の tick でも)", async () => {
  const s = await objectedForDraft("undraftable", { workspace: null });
  t = s.t;

  await settleSecondRound(t, s, "undraftable", "preference");
  await t.clock.advance(HOUR);

  expect(s.behaviorDraftClient.calls).toEqual([]);
  expect(await draftsFailed(t, s.task.id)).toEqual([]);
});

it("人間が登録した task の task_ambiguity は宛先の agent がいないので、起草の呼び出しも失敗 event も無い(1時間後の tick でも)", async () => {
  const s = await objectedForDraft("no addressee");
  t = s.t;

  await settleSecondRound(t, s, "no addressee", "task_ambiguity");
  await t.clock.advance(HOUR);

  expect((await attributions(t, s.task.id)).map((e: any) => e.payload.cause)).toEqual(["uncertain", "task_ambiguity"]);
  expect(s.behaviorDraftClient.calls).toEqual([]);
  expect(await draftsFailed(t, s.task.id)).toEqual([]);
});

it.each([
  ["preference", false],
  ["capability", false],
  ["preference", true],
  ["capability", true],
] as const)("第2回で %s に確定した起草は、entry の worker が registry にいる(%s)ときだけ撃ち、いなければ呼び出しも失敗 event も candidate も残さない(ADR 0173 決定4)", async (cause, registered) => {
  let gone: string | undefined;
  const s = await objectedForDraft("learner", { agentRegistered: (name) => name !== gone });
  t = s.t;
  if (!registered) gone = t.worker.id;
  const drafts = registered ? 1 : 0;
  s.behaviorDraftClient.scriptDraft(s.entry.id, KEEP_FIXTURES);

  await settleSecondRound(t, s, "learner", cause);
  await t.clock.advance(HOUR);

  expect((await attributions(t, s.task.id)).map((e: any) => e.payload.cause)).toEqual(["uncertain", cause]);
  expect(s.behaviorDraftClient.calls).toHaveLength(drafts);
  expect(await draftsFailed(t, s.task.id)).toEqual([]);
  expect(await behaviors(t)).toHaveLength(drafts);
});

// 起草と第2回の帰責の撃ち直し(ADR 0164 / issue #1065)

const behaviors = async (t: Tidepool) => (await memoryEntries(t)).filter((e: any) => e.kind === "behavior");

it("起草が1回失敗すると帰責 id つきの memory_draft_failed が残り、1時間後の tick で撃ち直して author board・出所 = その帰責の candidate が載る", async () => {
  const s = await objectedForDraft("retried", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "retried");
  const [attributionEvent] = await attributions(t, s.task.id);
  expect((await draftsFailed(t, s.task.id)).map((e: any) => e.payload)).toEqual([
    { kind: "memory_draft_failed", entry_id: s.entry.id, round: "initial", attribution_event_id: attributionEvent.id, reason: "claude CLI timed out" },
  ]);
  s.behaviorDraftClient.scriptDraft(s.entry.id, KEEP_FIXTURES);

  await t.clock.advance(HOUR);

  expect(await behaviors(t)).toEqual([
    expect.objectContaining({ source: { kind: "event", ref: attributionEvent.id }, author: { activity: "board", name: "tidepool" } }),
  ]);
  expect(s.behaviorDraftClient.calls).toHaveLength(2);
});

it("第2回の帰責の失敗は after_rca を書かず失敗 event を残し、1時間後の tick の撃ち直しで確定し、学習向きなら candidate まで載る", async () => {
  const s = await objectedForDraft("flaky-rca");
  t = s.t;
  const { self, auditor } = await commit(t, s.task.id, "flaky-rca");
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));

  await api(t.baseUrl, "POST", `/api/tasks/${self.id}/cancel`, {});
  await api(t.baseUrl, "POST", `/api/tasks/${auditor.id}/cancel`, {});
  await nextPoll(t);

  expect((await attributions(t, s.task.id)).map((e: any) => e.payload.round)).toEqual(["initial"]);
  expect((await attributionsFailed(t, s.task.id)).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    ["tidepool", "board", { kind: "objection_attribution_failed", entry_id: s.entry.id, objection_event_id: s.objection, round: "after_rca", reason: "Board call failed: claude CLI timed out" }],
  ]);
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the RCA decided it" });
  s.behaviorDraftClient.scriptDraft(s.entry.id, KEEP_FIXTURES);

  await t.clock.advance(HOUR);

  const second = (await attributions(t, s.task.id)).find((e: any) => e.payload.round === "after_rca");
  expect(second.payload).toMatchObject({ cause: "capability", round: "after_rca" });
  expect(s.attributionClient.calls.map((c) => c.input.rca_findings)).toEqual([undefined, [], []]);
  expect(await behaviors(t)).toEqual([
    expect.objectContaining({ addressee: t.worker.id, source: { kind: "event", ref: second.id }, author: { activity: "board", name: "tidepool" } }),
  ]);
});

it("起草の失敗から1時間未満の pickup 契機では撃たない", async () => {
  const s = await objectedForDraft("too soon", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "too soon");
  s.behaviorDraftClient.scriptDraft(s.entry.id, KEEP_FIXTURES);

  await t.clock.advance(HOUR / 2);
  await nextPoll(t);

  expect(s.behaviorDraftClient.calls).toHaveLength(1);
  expect(await behaviors(t)).toEqual([]);
});

it("起草が撃って3回失敗すると、以後の tick では撃たない", async () => {
  const s = await objectedForDraft("hopeless", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "hopeless");

  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect(await draftsFailed(t, s.task.id)).toHaveLength(3);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  expect(s.behaviorDraftClient.calls).toHaveLength(3);
  expect(await draftsFailed(t, s.task.id)).toHaveLength(3);
});

/** Board call の model(fable)の窓を閉じる / 開ける。 */
function reportFableWindow(t: Tidepool, throttled: boolean) {
  const resumesAt = new Date(t.clock.now().getTime() + HOUR);
  reportProviderUsage(t.db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: t.clock.now(),
    windows: [
      { window: "fable", model: "fable", usedPercent: throttled ? 100 : 10, durationMs: HOUR, resetsAt: resumesAt, throttled, resumesAt: throttled ? resumesAt : null },
    ],
  });
}

it("throttle の間は起草を撃たず、失敗 event も書かず回数にも数えない。窓が開けば撃つ", async () => {
  const s = await objectedForDraft("throttled draft", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "throttled draft");
  reportFableWindow(t, true);

  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  expect(s.behaviorDraftClient.calls).toHaveLength(1);
  expect(await draftsFailed(t, s.task.id)).toHaveLength(1);

  reportFableWindow(t, false);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  // throttle の3時間は数えていない: 開いてから2回撃って、失敗は計3回
  expect(s.behaviorDraftClient.calls).toHaveLength(3);
  expect(await draftsFailed(t, s.task.id)).toHaveLength(3);
});

it("解決しない起草を保留にしたまま poll を2回回しても、起草の呼び出しは1回", async () => {
  const s = await objectedForDraft("pending draft", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Promise(() => {}));
  await commit(t, s.task.id, "pending draft");

  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  expect(s.behaviorDraftClient.calls).toHaveLength(1);
  expect(await draftsFailed(t, s.task.id)).toEqual([]);
});

it("commit 直後の起草が error handling の外で投げても(失敗 event も残らない)、次の tick で拾われて candidate が載る", async () => {
  const s = await objectedForDraft("escaped", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  // 失敗の記録そのものが投げる: 1度目の message の読み取りだけが落ちる
  let read = false;
  const unrecordable = Object.defineProperty(new Error(), "message", {
    get: () => {
      if (read) return "unrecordable";
      read = true;
      throw new Error("the failure could not be recorded");
    },
  });
  s.behaviorDraftClient.scriptDraft(s.entry.id, unrecordable);
  const { res } = await commit(t, s.task.id, "escaped");
  expect(res.json.outcome).toBe("closed_now");
  expect(await draftsFailed(t, s.task.id)).toEqual([]);
  s.behaviorDraftClient.scriptDraft(s.entry.id, KEEP_FIXTURES);

  await t.clock.advance(HOUR);

  const [attributionEvent] = await attributions(t, s.task.id);
  expect(await behaviors(t)).toEqual([expect.objectContaining({ source: { kind: "event", ref: attributionEvent.id } })]);
});

it("前の異議群の起草が失敗した後に同じ entry が再異議されても、後の異議群が第2回を待つ間に次の tick で前の異議群の帰責から起草し直し、candidate の出所は前の帰責", async () => {
  const s = await objectedForDraft("superseded", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "superseded");
  const [first] = await attributions(t, s.task.id);
  // 同じ entry への2度目の異議を close-only で束ねる —— 後の異議群は未帰責のまま第2回を待つ
  await api(t.baseUrl, "POST", "/api/triage/start");
  await object(t, s.entry.id, "and name the fixtures in the report");
  await api(t.baseUrl, "POST", "/api/triage/close", { close_only: true });
  s.behaviorDraftClient.scriptDraft(s.entry.id, KEEP_FIXTURES);

  await t.clock.advance(HOUR);

  expect(s.behaviorDraftClient.calls).toHaveLength(2);
  expect(await behaviors(t)).toEqual([expect.objectContaining({ source: { kind: "event", ref: first.id } })]);
});

it("第2回の帰責が判断として uncertain を返したら、それが after_rca として残り撃ち直されない", async () => {
  const s = await objectedForDraft("undecidable");
  t = s.t;

  await settleSecondRound(t, s, "undecidable", "uncertain");
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  expect((await attributions(t, s.task.id)).map((e: any) => [e.payload.cause, e.payload.round])).toEqual([
    ["uncertain", "initial"],
    ["uncertain", "after_rca"],
  ]);
  expect(s.attributionClient.calls).toHaveLength(2);
  expect(await attributionsFailed(t, s.task.id)).toEqual([]);
});

it("throttle の間は第2回の帰責を撃たず、失敗 event も after_rca も書かない。窓が開けば撃って確定する", async () => {
  const s = await objectedForDraft("throttled rca");
  t = s.t;
  const { self, auditor } = await commit(t, s.task.id, "throttled rca");
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the RCA decided it" });
  reportFableWindow(t, true);

  await api(t.baseUrl, "POST", `/api/tasks/${self.id}/cancel`, {});
  const cancelled = await api(t.baseUrl, "POST", `/api/tasks/${auditor.id}/cancel`, {});
  await t.clock.advance(HOUR);

  expect(cancelled.status).toBe(200);
  expect(s.attributionClient.calls).toHaveLength(1);
  expect((await attributions(t, s.task.id)).map((e: any) => e.payload.round)).toEqual(["initial"]);
  expect(await attributionsFailed(t, s.task.id)).toEqual([]);

  reportFableWindow(t, false);
  await t.clock.advance(HOUR);

  expect((await attributions(t, s.task.id)).map((e: any) => [e.payload.cause, e.payload.round])).toEqual([
    ["uncertain", "initial"],
    ["capability", "after_rca"],
  ]);
});

it("容器の前提が成り立たない間は起草を撃ち直さず、失敗 event も増えない。前提が戻れば撃って candidate が載る", async () => {
  const s = await objectedForDraft("no containment", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  // 初回の帰責も前提を見る(ADR 0168 追記)ので、帰責は前提が成り立つ間に済ませ、起草は撃ち直しを待たせる
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "no containment");
  t.containers.scriptPreflight("cgroup v2 is not mounted at /sys/fs/cgroup");

  await t.clock.advance(HOUR);

  expect(s.behaviorDraftClient.calls).toHaveLength(1);
  expect(await draftsFailed(t, s.task.id)).toHaveLength(1);

  s.behaviorDraftClient.scriptDraft(s.entry.id, KEEP_FIXTURES);
  t.containers.scriptPreflight();
  await t.clock.advance(HOUR);

  const [attributionEvent] = await attributions(t, s.task.id);
  expect(await behaviors(t)).toEqual([expect.objectContaining({ source: { kind: "event", ref: attributionEvent.id } })]);
});

it("第2回の帰責が確定した entry は、同じタスクに新しい RCA 群が決着しても問い直されず、新しい entry だけが問われる", async () => {
  const s = await objectedAndCommitted("settled-rca");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the RCA decided it" });
  await api(t.baseUrl, "POST", `/api/tasks/${s.self.id}/cancel`, {});
  await api(t.baseUrl, "POST", `/api/tasks/${s.auditor.id}/cancel`, {});
  await nextPoll(t);
  expect(s.attributionClient.calls).toHaveLength(2);

  await completeIntegrationReviews(t, s.task.id);
  const second = (await api(t.baseUrl, "GET", `/api/tasks/${s.task.id}/events`)).json.find(
    (e: any) => e.kind === "task_completed",
  );
  await api(t.baseUrl, "POST", "/api/triage/start");
  await object(t, second.id, "the report should name the fixtures");
  await api(t.baseUrl, "POST", "/api/triage/close");
  const fresh = (await children(t, s.task.id)).filter(
    (x: any) => x.title.startsWith("rca (") && x.status === "todo",
  );
  for (const rca of fresh) await api(t.baseUrl, "POST", `/api/tasks/${rca.id}/cancel`, {});
  await t.clock.advance(HOUR);

  expect(s.attributionClient.calls.slice(2).map((c) => c.input.entry_id)).toEqual([second.id, second.id]);
});

// 初回の帰責の失敗は未帰責のまま RCA に倒れ、第2回が拾う(ADR 0168 / issue #1082)

it("初回の帰責が失敗した未帰責の entry は、RCA 子がすべて決着すると次の poll で第2回が撃たれ、その session の異議を出所に確定し、学習向きなら candidate まで載る", async () => {
  const s = await objectedForDraft("unattributed");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));
  const { self, auditor } = await commit(t, s.task.id, "unattributed");
  expect(await attributions(t, s.task.id)).toEqual([]);
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the RCA decided it" });
  s.behaviorDraftClient.scriptDraft(s.entry.id, KEEP_FIXTURES);
  const repair = (await children(t, s.task.id)).find((x: any) => x.title === "repair: unattributed");
  await api(t.baseUrl, "POST", `/api/tasks/${auditor.id}/cancel`, {});
  await completeViaMcp(t, repair.id);
  await completeIntegrationReviews(t, repair.id);

  await settleRca(t, self.id, "the criteria named the fixtures", "fixtures were required");
  await nextPoll(t);

  const [second] = await attributions(t, s.task.id);
  expect(second.payload).toEqual({
    kind: "objection_attributed",
    entry_id: s.entry.id,
    objection_event_ids: [s.objection],
    cause: "capability",
    evidence: "the RCA decided it",
    entries: null,
    round: "after_rca",
  });
  expect(s.attributionClient.calls[1]?.input).toEqual({
    entry_id: s.entry.id,
    entry: "skipped the fixtures",
    steering: ["always keep the fixtures"],
    decision_log: ["skipped the fixtures", "completion report: done as specified"],
    memory_read: [],
    rca_findings: ["the criteria named the fixtures", "completion report: fixtures were required"],
  });
  expect(await behaviors(t)).toEqual([
    expect.objectContaining({ addressee: t.worker.id, source: { kind: "event", ref: second.id }, author: { activity: "board", name: "tidepool" } }),
  ]);
});

it("open session の未帰責の異議は、同じタスクの RCA 子がすべて決着しても第2回の対象にならない", async () => {
  const s = await objectedForDraft("still open");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));
  const { self, auditor } = await commit(t, s.task.id, "still open");
  const completion = (await api(t.baseUrl, "GET", `/api/tasks/${s.task.id}/events`)).json.find((e: any) => e.kind === "task_completed");
  await api(t.baseUrl, "POST", "/api/triage/start");
  await object(t, completion.id, "the report should name the fixtures");
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the RCA decided it" });

  await api(t.baseUrl, "POST", `/api/tasks/${self.id}/cancel`, {});
  await api(t.baseUrl, "POST", `/api/tasks/${auditor.id}/cancel`, {});
  await nextPoll(t);

  expect(s.attributionClient.calls.map((c) => c.input.entry_id)).toEqual([s.entry.id, s.entry.id]);
  expect((await attributions(t, s.task.id)).map((e: any) => e.payload.entry_id)).toEqual([s.entry.id]);
});

it("前の RCA 群の第2回が次の session の開いている間に確定しても、その session が close-only で閉じた未帰責の異議は、新しい RCA 群の決着で第2回が撃たれる", async () => {
  const s = await objectedForDraft("reobjected");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));
  const first = await commit(t, s.task.id, "reobjected");
  await api(t.baseUrl, "POST", "/api/triage/start");
  const again = await object(t, s.entry.id, "the fixtures, again");
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the first RCA decided it" });
  await api(t.baseUrl, "POST", `/api/tasks/${first.self.id}/cancel`, {});
  await api(t.baseUrl, "POST", `/api/tasks/${first.auditor.id}/cancel`, {});
  await nextPoll(t);
  await api(t.baseUrl, "POST", "/api/triage/close", { close_only: true });
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "task_ambiguity", evidence: "the second RCA decided it" });

  const fresh = (await children(t, s.task.id)).filter((x: any) => x.title.startsWith("rca (") && x.status === "todo");
  for (const rca of fresh) await api(t.baseUrl, "POST", `/api/tasks/${rca.id}/cancel`, {});
  await nextPoll(t);

  expect(fresh).toHaveLength(2);
  expect((await attributions(t, s.task.id)).map((e: any) => [e.payload.cause, e.payload.round, e.payload.objection_event_ids])).toEqual([
    ["capability", "after_rca", [s.objection]],
    ["task_ambiguity", "after_rca", [again]],
  ]);
});

it("初回の帰責の失敗は poll で撃ち直されず、round initial の失敗が3つあっても第2回の回数と間隔には数えず、3つの異議群はそれぞれ第2回で確定する", async () => {
  const s = await objectedForDraft("failing first");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "failing first");
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect(s.attributionClient.calls).toHaveLength(1);
  const bundles = [s.objection];
  for (const comment of ["still no fixtures", "the fixtures, please"]) {
    await api(t.baseUrl, "POST", "/api/triage/start");
    bundles.push(await object(t, s.entry.id, comment));
    await commit(t, s.task.id, "failing first");
  }
  expect((await attributionsFailed(t, s.task.id)).map((e: any) => e.payload.round)).toEqual(["initial", "initial", "initial"]);
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the RCA decided it" });

  const rcas = (await children(t, s.task.id)).filter((x: any) => x.title.startsWith("rca ("));
  for (const rca of rcas) await api(t.baseUrl, "POST", `/api/tasks/${rca.id}/cancel`, {});
  await nextPoll(t);

  expect(rcas).toHaveLength(6);
  expect((await attributions(t, s.task.id)).map((e: any) => [e.payload.cause, e.payload.round, e.payload.objection_event_ids])).toEqual(
    bundles.map((id) => ["capability", "after_rca", [id]]),
  );
});

// 帰責の単位は異議群(ADR 0170 / issue #1129)

/** 同じ entry に後の triage session で異議を打って閉じ、後の異議群の名前(その異議 event の id)を返す。 */
async function reobject(t: Tidepool, entryId: number, comment: string, closeOnly = false) {
  await api(t.baseUrl, "POST", "/api/triage/start");
  const id = await object(t, entryId, comment);
  await api(t.baseUrl, "POST", "/api/triage/close", closeOnly ? { close_only: true } : undefined);
  return id;
}

/** まだ決着していない RCA 子をすべて決着させ(待っているものは取り消し、走っているものは完了させる)、決着後の tick を
 *  次の poll を1つ起こす(第2回を撃つのは sweep だけ、ADR 0169)。 */
async function settleRcasThenTick(t: Tidepool, taskId: string) {
  for (;;) {
    const rca = (await children(t, taskId)).find((x: any) => x.title.startsWith("rca (") && ["todo", "in_progress"].includes(x.status));
    if (!rca) break;
    if (rca.status === "todo") await api(t.baseUrl, "POST", `/api/tasks/${rca.id}/cancel`, {});
    else await completeViaMcp(t, rca.id, false);
  }
  await nextPoll(t);
}

it("初回と第2回の失敗 event は異議群の名前を持ち、第2回の回数は異議群ごとに数える —— 前の異議群が2回・後が1回失敗しても打ち切りは無く、次の tick で3回目に達した前の異議群だけが打ち切られる", async () => {
  const s = await objectedForDraft("per bundle");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "per bundle");
  await settleRcasThenTick(t, s.task.id);
  await t.clock.advance(HOUR);
  const again = await reobject(t, s.entry.id, "and name the fixtures in the report");

  await settleRcasThenTick(t, s.task.id);

  expect((await attributionsFailed(t, s.task.id)).map((e: any) => [e.payload.objection_event_id, e.payload.round])).toEqual([
    [s.objection, "initial"],
    [s.objection, "after_rca"],
    [s.objection, "after_rca"],
    [again, "initial"],
    [again, "after_rca"],
  ]);
  expect(await haltedRefires(t)).toEqual([]);

  await t.clock.advance(HOUR);

  expect((await haltedRefires(t)).map((r: any) => [r.refire, r.target])).toEqual([["second_round", s.objection]]);
});

const logCause = async (t: Tidepool, entryId: number) =>
  (await api(t.baseUrl, "GET", "/api/log")).json.entries.find((e: any) => e.id === entryId).cause;

it("前の異議群で capability と判定された entry を後の session が再異議して close-only で閉じると、一覧の cause は空になり起草 verb は uncertain と同じ文言で拒む。RCA 群の決着後の tick で後の異議だけを steering に第2回が撃たれ、着地後の cause は後の判定", async () => {
  const s = await objectedForDraft("reobjected capability", { initial: { cause: "capability", evidence: "skipped a named criterion" } });
  t = s.t;
  const { self: firstSelf } = await commit(t, s.task.id, "reobjected capability");
  expect(await logCause(t, s.entry.id)).toBe("capability");

  await reobject(t, s.entry.id, "and name the fixtures in the report", true);

  expect(await logCause(t, s.entry.id)).toBeNull();
  const self = (await children(t, s.task.id)).find((x: any) => x.title === "rca (self): reobjected capability" && x.id !== firstSelf.id);
  await runNow(t, self.id);
  expect(await propose(t, self.id, { entry_id: s.entry.id })).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("the entry's cause is uncertain: nothing to learn from it") }],
  });
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "task_ambiguity", evidence: "the second RCA decided it" });
  await settleRcasThenTick(t, s.task.id);
  await t.clock.advance(HOUR);

  expect(s.attributionClient.calls.map((c) => c.input.steering)).toEqual([["always keep the fixtures"], ["and name the fixtures in the report"]]);
  expect(await logCause(t, s.entry.id)).toBe("task_ambiguity");
});

it("前の異議群の第2回が打ち切られていても後の異議群の第2回は撃たれ、打ち切りの一覧には異議群ごとの行が異議の id を target に並ぶ。前の Dismiss の後、前への Retry は拒まれ、後への Retry は効いて確定する", async () => {
  const s = await objectedForDraft("halted bundles");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "halted bundles");
  await settleRcasThenTick(t, s.task.id);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect((await haltedRefires(t)).map((r: any) => r.target)).toEqual([s.objection]);
  const again = await reobject(t, s.entry.id, "and name the fixtures in the report", true);

  await settleRcasThenTick(t, s.task.id);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  expect(s.attributionClient.calls.map((c) => c.input.steering)).toEqual([
    ...Array(4).fill(["always keep the fixtures"]),
    ...Array(3).fill(["and name the fixtures in the report"]),
  ]);
  expect((await haltedRefires(t)).map((r: any) => [r.refire, r.target, r.entry.id, r.cause])).toEqual([
    ["second_round", s.objection, s.entry.id, null],
    ["second_round", again, s.entry.id, null],
  ]);
  const post = async (target: number, verb: "retry" | "dismiss") =>
    (await api(t.baseUrl, "POST", `/api/settings/execution/halted-refires/second_round/${target}/${verb}`)).status;
  expect(await post(s.objection, "dismiss")).toBe(200);
  expect(await post(s.objection, "retry")).toBe(400);
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the second RCA decided it" });
  expect(await post(again, "retry")).toBe(200);
  await nextPoll(t);

  expect((await attributions(t, s.task.id)).map((e: any) => [e.payload.cause, e.payload.objection_event_ids])).toEqual([["capability", [again]]]);
  expect(await haltedRefires(t)).toEqual([]);
  expect(await logCause(t, s.entry.id)).toBe("capability");
});

it("後の異議群の第2回が確定した後に前の異議群の第2回が遅れて着地しても、一覧の cause は後の判定のままで、追加の第2回は撃たれない", async () => {
  const s = await objectedForDraft("late landing");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "late landing");
  await settleRcasThenTick(t, s.task.id);
  const again = await reobject(t, s.entry.id, "and name the fixtures in the report", true);
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the second RCA decided it" });
  await settleRcasThenTick(t, s.task.id);
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "task_ambiguity", evidence: "the first RCA decided it, late" });

  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  expect((await attributions(t, s.task.id)).map((e: any) => [e.payload.cause, e.payload.objection_event_ids])).toEqual([
    ["capability", [again]],
    ["task_ambiguity", [s.objection]],
  ]);
  expect(await logCause(t, s.entry.id)).toBe("capability");
  expect(s.attributionClient.calls.map((c) => c.input.steering)).toEqual([
    ["always keep the fixtures"],
    ["always keep the fixtures"],
    ["and name the fixtures in the report"],
    ["always keep the fixtures"],
  ]);
});

// 読んだ記憶への帰責(ADR 0166 / issue #1045)—— ドメイン層

const at = new Date("2026-09-28T00:00:00.000Z");

/** worker session を event で開き、記憶を読ませ、decision に異議を打つまでを1つの盤面で組む(harness の worker は
 *  worker_spawned を書かないので、session の開始は setup として event を直接足す)。 */
function memoryBoard() {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at);
  const reader = { taskId: task.id, scope: null, agent: "deckhand" };
  const spawn = () =>
    appendEvent(db, {
      taskId: task.id,
      workerId: "deckhand",
      origin: "board",
      at,
      payload: WORKER_SPAWNED,
    });
  const knowledge = (title: string) =>
    recordKnowledge(db, { scope: null, path: "build", title, text: `${title}.`, source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at).entry_id;
  const read = (id: number) => readMemory(db, reader, { ids: [id] }, at);
  const decide = (line: string) => logDecision(db, task, line, "deckhand", at);
  const objectTo = (entryId: number) => {
    const session = startTriage(db, at);
    raiseObjection(db, entryId, "the note was wrong", at);
    return session.id;
  };
  return { db, task, reader, spawn, knowledge, read, decide, objectTo };
}

it("帰責の入力の読んだ記憶は、異議された decision と同じ worker session でそれより前に read_memory が返した entry だけ —— 前の session・他の verb・decision より後の pull は入らない", async () => {
  const b = memoryBoard();
  const previous = b.knowledge("Previous session note");
  const mine = b.knowledge("Squash before merge");
  const searched = b.knowledge("Searched note");
  const later = b.knowledge("Later note");
  b.spawn();
  b.read(previous);
  b.spawn();
  b.read(mine);
  expect(searchMemory(b.db, b.reader, { query: "Searched" }, at).results.map((r) => r.id)).toEqual([searched]);
  const decision = b.decide("squashed the branch");
  b.read(later);
  const client = new FakeAttributionClient();

  await attributeObjections(b.db, { ...noRetrospectiveCalls, attributionClient: client }, b.objectTo(decision), at);

  expect(client.calls.map((c) => c.input.memory_read)).toEqual([
    [{ id: mine, kind: "knowledge", title: "Squash before merge", text: "Squash before merge." }],
  ]);
});

/** 同じ session で `read` を読んでから decision を書き、異議を打つ(`unread` は読まずに店にあるだけの entry)。 */
function objectedAfterReading() {
  const b = memoryBoard();
  const read = b.knowledge("Squash before merge");
  const unread = b.knowledge("Rebase before merge");
  b.spawn();
  b.read(read);
  const decision = b.decide("squashed the branch");
  return { ...b, read, unread, decision, sessionId: b.objectTo(decision) };
}

const attributed = (db: ReturnType<typeof openDb>, taskId: string) =>
  listEvents(db, taskId).flatMap((e) => (e.payload.kind === "objection_attributed" ? [e.payload] : []));

it.each<[string, (ids: { read: number; unread: number }) => { cause: Cause; entries?: number[] }, string]>([
  ["読んでいない entry を名指す memory", ({ read, unread }) => ({ cause: "memory", entries: [read, unread] }), "was not read before the decision"],
  ["entries が空の memory", () => ({ cause: "memory", entries: [] }), "names no entry"],
  ["entries の無い memory", () => ({ cause: "memory" }), "names no entry"],
  ["entries つきの capability", ({ read }) => ({ cause: "capability", entries: [read] }), "only for cause memory"],
])("初回: %s は門で uncertain に倒れ、evidence が理由を言い、entries は null", async (_, judgment, reason) => {
  const b = objectedAfterReading();
  const client = new FakeAttributionClient();
  client.scriptJudgment(b.decision, { ...judgment(b), evidence: "followed the note" });

  commitTriage(b.db, at, [], await attributeObjections(b.db, { ...noRetrospectiveCalls, attributionClient: client }, b.sessionId, at));

  expect(attributed(b.db, b.task.id)).toEqual([
    expect.objectContaining({ cause: "uncertain", evidence: expect.stringContaining(reason), entries: null }),
  ]);
});

it("初回: 読んだ集合の中の entry を名指す memory は entries ごと帰責に載り、memory だけの commit は修理だけが立つ(RCA も candidate も立たない)", async () => {
  const b = objectedAfterReading();
  const client = new FakeAttributionClient();
  client.scriptJudgment(b.decision, { cause: "memory", evidence: "followed the squash note", entries: [b.read] });

  commitTriage(b.db, at, [], await attributeObjections(b.db, { ...noRetrospectiveCalls, attributionClient: client }, b.sessionId, at));

  expect(attributed(b.db, b.task.id)).toEqual([
    { kind: "objection_attributed", entry_id: b.decision, objection_event_ids: [expect.any(Number)], cause: "memory", evidence: "followed the squash note", entries: [b.read], round: "initial" },
  ]);
  expect(listChildren(b.db, b.task.id).map((c) => c.title)).toEqual(["repair: t"]);
});

it.each<[string, (ids: { read: number; unread: number }) => number[], Partial<GatedJudgment>]>([
  ["読んだ集合の中の entry を名指す memory は entries ごと載り、candidate は起草されない", ({ read }) => [read], { cause: "memory", evidence: "the RCA traced it to the note" }],
  ["読んでいない entry を名指す memory は uncertain に倒れる", ({ unread }) => [unread], { cause: "uncertain", evidence: expect.stringContaining("was not read before the decision"), entries: null }],
])("第2回: %s", async (_, entries, expected) => {
  const b = objectedAfterReading();
  const client = new FakeAttributionClient();
  commitTriage(b.db, at, [], await attributeObjections(b.db, { ...noRetrospectiveCalls, attributionClient: client }, b.sessionId, at));
  client.scriptJudgment(b.decision, { cause: "memory", evidence: "the RCA traced it to the note", entries: entries(b) });
  const drafter = new FakeBehaviorDraftClient();
  const rca = listChildren(b.db, b.task.id).filter((c) => c.title.startsWith("rca ("));
  for (const r of rca) cancelTaskDirectly(b.db, r, null, at, {});

  refireRetrospectiveCalls(b.db, { ...noRetrospectiveCalls, attributionClient: client, behaviorDraftClient: drafter, workspace: { name: "charts" } }, at);
  // sweep は fire-and-forget: fake の返答が着地するまで回す
  await new Promise((resolve) => setImmediate(resolve));

  expect(attributed(b.db, b.task.id).map((p) => p.round)).toEqual(["initial", "after_rca"]);
  expect(attributed(b.db, b.task.id)[1]).toMatchObject({ entries: entries(b), ...expected });
  expect(drafter.calls).toEqual([]);
});
