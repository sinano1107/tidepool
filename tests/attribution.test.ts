import { afterEach, expect, it } from "vitest";
import type { Cause } from "../src/cause.js";
import { registerTask } from "../src/tasks.js";
import { reportProviderUsage } from "../src/throttle.js";
import { TRIAGE_TIMEOUT } from "../src/triage.js";
import { FakeAttributionClient, FakeBehaviorDraftClient } from "./fakes.js";
import {
  api,
  bootTidepool,
  completeIntegrationReviews,
  completeViaMcp,
  FULL_HANDOFF,
  HOUR,
  loggedEntry,
  managementMcpClient,
  mcpClient,
  registerWork,
  type Tidepool,
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

it.each([
  ["close-only", () => api(t.baseUrl, "POST", "/api/triage/close", { close_only: true })],
  ["the timeout watchdog", () => t.clock.advance(TRIAGE_TIMEOUT)],
])("%s で閉じる session は Board call を呼ばず、異議は uncertain のまま従来どおり RCA が立つ", async (path, close) => {
  const attributionClient = new FakeAttributionClient();
  t = await bootTidepool({ attributionClient });
  const { task, entries } = await objectedWork(t, "skimmed", ["picked the quick hack"]);
  attributionClient.scriptJudgment(entries[0].id, { cause: "preference", evidence: "would be ignored" });
  await object(t, entries[0].id, "do it properly");

  await close();

  expect(attributionClient.calls).toEqual([]);
  expect((await attributions(t, task.id)).map((e: any) => e.payload)).toMatchObject([
    {
      cause: "uncertain",
      evidence: `not attributed: the session was closed by ${path} without a Board call`,
    },
  ]);
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

  const cancelled = await api(t.baseUrl, "POST", `/api/tasks/${s.auditor.id}/cancel`, {});

  expect(cancelled.status).toBe(200);
  expect((await attributions(t, s.task.id)).map((e: any) => e.payload)).toEqual([
    expect.objectContaining({ entry_id: s.entry.id, cause: "uncertain", round: "initial" }),
    {
      kind: "objection_attributed",
      entry_id: s.entry.id,
      objection_event_ids: [expect.any(Number)],
      cause: "capability",
      evidence: "the self RCA found the criteria named the fixtures",
      round: "after_rca",
    },
  ]);
  expect(s.attributionClient.calls[1]?.input).toEqual({
    entry_id: s.entry.id,
    entry: "skipped the fixtures",
    steering: ["bring the fixtures back"],
    decision_log: ["skipped the fixtures", "completion report: done as specified"],
    rca_findings: ["the criteria named the fixtures explicitly", "completion report: fixtures were required"],
  });
});

it("初回で uncertain が無いタスクでは RCA 子がすべて決着しても第2回は走らない", async () => {
  const s = await objectedAndCommitted("decided", { cause: "capability", evidence: "clear" });
  t = s.t;

  const self = await api(t.baseUrl, "POST", `/api/tasks/${s.self.id}/cancel`, {});
  const auditor = await api(t.baseUrl, "POST", `/api/tasks/${s.auditor.id}/cancel`, {});

  expect([self.json.status, auditor.json.status]).toEqual(["cancelled", "cancelled"]);
  expect(s.attributionClient.calls).toHaveLength(1);
  expect((await attributions(t, s.task.id)).map((e: any) => e.payload.round)).toEqual(["initial"]);
});

it("第2回の Board call が失敗しても RCA の決着は倒れず cause は uncertain のまま残り、同じタスクに新しい RCA 群が決着しても第3回は走らない", async () => {
  const s = await objectedAndCommitted("flaky-rca");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));

  await api(t.baseUrl, "POST", `/api/tasks/${s.self.id}/cancel`, {});
  const auditor = await api(t.baseUrl, "POST", `/api/tasks/${s.auditor.id}/cancel`, {});

  expect(auditor.status).toBe(200);
  expect(auditor.json.status).toBe("cancelled");
  expect(s.attributionClient.calls.map((c) => c.input.rca_findings)).toEqual([undefined, []]);
  expect((await attributions(t, s.task.id)).map((e: any) => e.payload)).toMatchObject([
    { cause: "uncertain", round: "initial" },
    { cause: "uncertain", round: "after_rca", evidence: "Board call failed: claude CLI timed out" },
  ]);

  // a fresh objection on the same task stands a new RCA set; its settling asks only the new entry
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

  expect(s.attributionClient.calls.slice(2).map((c) => c.input.entry_id)).toEqual([second.id, second.id]);
});

it("最後の RCA 子を人間が human の扉で完了しても第2回が走る", async () => {
  const s = await objectedAndCommitted("human-rca");
  t = s.t;
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "task_ambiguity", evidence: "criteria were silent" });
  await api(t.baseUrl, "POST", `/api/tasks/${s.self.id}/cancel`, {});
  await api(t.baseUrl, "PATCH", `/api/tasks/${s.auditor.id}`, { assignee: "human" });

  const done = await api(t.baseUrl, "POST", `/api/tasks/${s.auditor.id}/complete`, {
    handoff: { outcome: "the criteria never mentioned fixtures" },
  });

  expect(done.status).toBe(200);
  expect((await attributions(t, s.task.id)).map((e: any) => [e.payload.cause, e.payload.round])).toEqual([
    ["uncertain", "initial"],
    ["task_ambiguity", "after_rca"],
  ]);
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

const memoryEntries = async (t: Tidepool) => (await api(t.baseUrl, "GET", "/api/settings/memory/entries")).json.entries;

const draftsFailed = async (t: Tidepool, taskId: string) =>
  (await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.filter((e: any) => e.kind === "memory_draft_failed");

/** 起草 client つきの盤面で、work(既定 workspace charts)に1行 log → 完了 → 異議まで進める(commit は呼び手)。
 *  `registrant` を渡すと agent が登録した task(decompose と同じ登録者の形)、`human` は人間が担当して人間の扉で完了。 */
async function objectedForDraft(
  title: string,
  opts: { initial?: { cause: Cause; evidence: string }; registrant?: string; workspace?: string | null; human?: true } = {},
) {
  const attributionClient = new FakeAttributionClient();
  const behaviorDraftClient = new FakeBehaviorDraftClient();
  const t = await bootTidepool({ attributionClient, behaviorDraftClient });
  const workspace = opts.workspace === null ? undefined : (opts.workspace ?? "charts");
  const task = opts.registrant
    ? registerTask(t.db, { type: "work", title, purpose: "p", completion_criteria: "c", workspace }, t.clock.now(), opts.registrant, "worker")
    : await registerWork(t, title, workspace, undefined, opts.human && "human");
  let entry: any;
  if (opts.human) {
    await api(t.baseUrl, "POST", `/api/tasks/${task.id}/complete`, { handoff: FULL_HANDOFF });
    entry = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json.find((e: any) => e.kind === "task_completed");
  } else {
    await t.clock.advance(HOUR);
    entry = await loggedEntry(t, task.id, "skipped the fixtures");
    await completeViaMcp(t, task.id);
  }
  await completeIntegrationReviews(t, task.id);
  if (opts.initial) attributionClient.scriptJudgment(entry.id, opts.initial);
  await api(t.baseUrl, "POST", "/api/triage/start");
  await object(t, entry.id, "always keep the fixtures");
  return { t, attributionClient, behaviorDraftClient, task, entry };
}

/** commit して RCA 子を返す。 */
async function commit(t: Tidepool, taskId: string, title: string) {
  const res = await api(t.baseUrl, "POST", "/api/triage/close");
  const kids = await children(t, taskId);
  return {
    res,
    self: kids.find((x: any) => x.title === `rca (self): ${title}`),
    auditor: kids.find((x: any) => x.title === `rca (auditor): ${title}`),
  };
}

it.each([
  ["worker", (t: Tidepool) => t.worker.id],
  ["all", () => null],
] as const)(
  "初回の帰責が preference のエントリは commit 後に Board call が起草し、author board・出所 = 帰責 event・scope = task の workspace・宛先 = Board call の %s の candidate が載る",
  async (addressee, expected) => {
    const s = await objectedForDraft("naming", { initial: { cause: "preference", evidence: "taste" } });
    t = s.t;
    await api(t.baseUrl, "POST", "/api/settings/memory/definitions", { workspace: "charts", path: "testing", text: "how tests are run" });
    s.behaviorDraftClient.scriptDraft(s.entry.id, { path: "testing/fixtures", title: "Keep fixtures", text: "Always keep the fixtures.", addressee });

    await commit(t, s.task.id, "naming");

    const [attribution] = await attributions(t, s.task.id);
    expect((await memoryEntries(t)).filter((e: any) => e.kind === "behavior")).toEqual([
      expect.objectContaining({
        state: "candidate",
        scope: "charts",
        path: "testing/fixtures",
        title: "Keep fixtures",
        text: "Always keep the fixtures.",
        addressee: expected(t),
        source: { kind: "event", ref: attribution.id },
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
          index: expect.stringContaining("testing/ — how tests are run"),
        },
        setting: expect.objectContaining({ model: "fable", effort: "high" }),
      },
    ]);
  },
);

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

it("起草の Board call の失敗は memory_draft_failed を残し、帰責の event と commit の応答は従来どおり", async () => {
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
        round: "initial",
      },
    ],
  ]);
  expect((await draftsFailed(t, s.task.id)).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    ["tidepool", "board", { kind: "memory_draft_failed", entry_id: s.entry.id, round: "initial", reason: "claude CLI timed out" }],
  ]);
  expect(await memoryEntries(t)).toEqual([]);
});

it.each([
  ["workspace を持たない task", { workspace: null, cause: "preference" }, /workspace/],
  ["人間が登録した task の task_ambiguity", { workspace: undefined, cause: "task_ambiguity" }, /not registered by an agent/],
] as const)("%s は Board call を呼ばずに memory_draft_failed を残す", async (_, { workspace, cause }, reason) => {
  const s = await objectedForDraft("undraftable", { workspace });
  t = s.t;
  const { self, auditor } = await commit(t, s.task.id, "undraftable");
  s.attributionClient.scriptJudgment(s.entry.id, { cause, evidence: "decided after the RCA" });

  await api(t.baseUrl, "POST", `/api/tasks/${self.id}/cancel`, {});
  await api(t.baseUrl, "POST", `/api/tasks/${auditor.id}/cancel`, {});

  expect(s.behaviorDraftClient.calls).toEqual([]);
  expect((await draftsFailed(t, s.task.id)).map((e: any) => e.payload)).toEqual([
    { kind: "memory_draft_failed", entry_id: s.entry.id, round: "after_rca", reason: expect.stringMatching(reason) },
  ]);
});
