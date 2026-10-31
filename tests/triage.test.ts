import { afterEach, expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import type { Cause } from "../src/cause.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { completeMemoryReview, moveMemoryByMetaReview, recordKnowledge, repairReplace } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import { completeRca, type GatedJudgment } from "../src/retrospective.js";
import { cancelTaskDirectly, completeTask, finishTask, getTask, humanDecomposeTask, listBoard, listChildren, logDecision, nextSlotTask, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { closeStaleTriage, closeTriageSessionOnly, commitTriage, entryObjections, listLog, objectionsById, raiseObjection, recordDisplayedEntries, stageFrontInsert, startTriage, TRIAGE_TIMEOUT, TriageError } from "../src/triage.js";
import { resolveTaskBranchLineage } from "../src/workspace.js";
import {
  answerQuestionViaWebui,
  api,
  auditorRcaOn,
  bootTidepool,
  decomposeTaskViaWorker,
  examineeRootId,
  FIXTURE_SPAWNED_EVENT_ID,
  FIXTURE_TASK,
  FULL_HANDOFF,
  HOUR,
  HUMAN_WEBUI,
  injectMemoryMaterial,
  interviewExaminee,
  loggedEntry,
  makeWorkspace,
  markPickedUp,
  mcpClient,
  queueWork,
  rcaFindings,
  registerWork,
  seedFixtureBoard,
  type Tidepool,
  WORKER_SPAWNED,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("starting a triage session pauses task pickup", async () => {
  t = await bootTidepool();
  queueWork(t, "queued work");
  const res = await api(t.baseUrl, "POST", "/api/triage/start");
  expect(res.status).toBe(201);

  // a full hour passes with the human active on the pad: the hourly poll
  // fires but hands nothing to the worker while triage is on
  for (const step of [1, 2, 3]) {
    await t.clock.advance(HOUR / 3);
    await api(t.baseUrl, "POST", "/api/triage/scratchpad", { line: `still triaging ${step}` });
  }
  expect(t.worker.started).toEqual([]);
});

it("commit closes the session and fires an immediate poll", async () => {
  t = await bootTidepool();
  queueWork(t, "queued work");
  await api(t.baseUrl, "POST", "/api/triage/start");
  expect(t.worker.started).toEqual([]);

  const res = await api(t.baseUrl, "POST", "/api/triage/close");
  expect(res).toMatchObject({
    status: 200,
    json: { outcome: "closed_now", closed_at: expect.any(String) },
  });
  // no clock advance: the commit itself hands the queue head to the worker
  expect(t.worker.started.map((x) => x.title)).toEqual(["queued work"]);
});

it("セッションが開いていない commit は成功し、振り分けがタスクを作らなければ即時 poll を発火しない", async () => {
  t = await bootTidepool();
  queueWork(t, "queued work");

  const res = await api(t.baseUrl, "POST", "/api/triage/close");

  expect(res).toMatchObject({
    status: 200,
    json: { outcome: "no_open_session", closed_at: null, created_tasks: 0 },
  });
  expect(t.worker.started).toEqual([]);
});

/** Park `parent` behind an escalated question: parent into the slot, a human
 *  places `other work` on top, then the escalation frees the slot. The triage
 *  session is already open when it does, so the freed slot — itself a pickup
 *  trigger (ADR 0119 決定3) — stays empty until commit. */
async function escalatedBoard(t: Tidepool) {
  const parent = await registerWork(t, "parent work"); // parent into the slot
  const other = await registerWork(t, "other work");
  await api(t.baseUrl, "POST", `/api/tasks/${other.id}/move`, { after: null });
  await api(t.baseUrl, "POST", "/api/triage/start");
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  await client.callTool({
    name: "escalate",
    arguments: {
      context: "fork in the road",
      questions: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
    },
  });
  await client.close();
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question",
  );
  return { parent, other, question };
}

it("an answer during triage persists at once but reaches the queue only at commit", async () => {
  t = await bootTidepool();
  const { question } = await escalatedBoard(t);

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["left"],
    triage: true,
  });
  expect(res.status).toBe(200);
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).not.toBe(null);

  // the answer itself is durable at once — abandoning the session cannot lose it
  const answered = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(answered.status).toBe("done");
  expect(answered.question_answer).toEqual(["left"]);

  // but the unblocked parent has not jumped the queue yet
  const before = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(before.map((x: any) => x.title)).toEqual(["other work", "parent work", "which way?"]);

  await api(t.baseUrl, "POST", "/api/triage/close");
  const after = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(after.map((x: any) => x.title)).toEqual(["parent work", "other work", "which way?"]);
  // the immediate poll hands the parent straight back to the worker
  expect(t.worker.started.map((x) => x.title)).toEqual(["parent work", "parent work"]);
});

/** Complete the slot task via MCP with a full work handoff. */
async function completeVia(t: Tidepool, taskId: string) {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  await client.callTool({
    name: "complete_task",
    arguments: {
      handoff: {
        outcome: "criteria met",
        deliverables: "the code",
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
    },
  });
  await client.close();
}

it("Decision log は human のエントリを保持するが未読には数えない", async () => {
  t = await bootTidepool();
  const agentTask = await registerWork(t, "agent decision");
  await t.clock.advance(HOUR);
  const agentEntry = await loggedEntry(t, agentTask.id, "agent が選んだ方針");
  const humanTask = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "human work",
      purpose: "p",
      completion_criteria: "c",
      assignee: "human",
    })
  ).json;
  await api(t.baseUrl, "POST", `/api/tasks/${humanTask.id}/complete`, {});

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const humanEntry = log.entries.find(
    (entry: any) => entry.kind === "task_completed" && entry.task_id === humanTask.id,
  );

  expect(agentEntry).toBeDefined();
  expect(log.entries.find((entry: any) => entry.id === agentEntry.id)?.unread).toBe(true);
  expect(humanEntry).toMatchObject({ actor_id: "human", unread: false });
});

it("an objection needs a direction comment and lands durably on the log entry", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "logged work");
  await t.clock.advance(HOUR); // into the slot so it can log a decision
  const entry = await loggedEntry(t, task.id, "went with plan B");

  // silence is approval — the only explicit action carries a direction
  const bare = await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: entry.id });
  expect(bare.status).toBe(400);

  const res = await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "plan B breaks the fixtures — go back to plan A",
  });
  expect(res.status).toBe(201);
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).not.toBe(null);

  // durable at once, as an annotation on the entry's task
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  const objections = events.filter((e: any) => e.kind === "objection_raised");
  expect(objections).toHaveLength(1);
  expect(objections[0].actor_id).toBe("human");
  expect(objections[0].payload.entry_id).toBe(entry.id);
  expect(objections[0].payload.comment).toBe("plan B breaks the fixtures — go back to plan A");
});

it("ログ配信がエントリごとの異議注釈を運ぶ — 束ね済みも commit 待ちも全件、無い場合は空配列(issue #371)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "objected work");
  await t.clock.advance(HOUR);
  const objectedEntry = await loggedEntry(t, task.id, "went with plan B");
  const untouchedEntry = await loggedEntry(t, task.id, "an unrelated decision");

  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: objectedEntry.id,
    comment: "束ね済みになる1件目",
  });
  await api(t.baseUrl, "POST", "/api/triage/close"); // commits session 1, bundles the objection above
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: objectedEntry.id,
    comment: "commit 待ちの2件目",
  }); // opens a fresh session 2

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const entries = log.entries as any[];
  const objected = entries.find((e) => e.id === objectedEntry.id);
  const untouched = entries.find((e) => e.id === untouchedEntry.id);

  expect(untouched.objections).toEqual([]);
  expect(objected.objections).toHaveLength(2);
  expect(objected.objections.map((o: any) => o.comment)).toEqual([
    "束ね済みになる1件目",
    "commit 待ちの2件目",
  ]);
  // 異なるセッション由来であることが読み分けの唯一の事実(ADR 0085)
  expect(objected.objections[0].session_id).not.toBe(objected.objections[1].session_id);
});

it("the S3 preview stages the queue with this session's front-inserts highlighted", async () => {
  t = await bootTidepool();
  const { question } = await escalatedBoard(t);
  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["left"] });

  const res = await api(t.baseUrl, "GET", "/api/triage");
  expect(res.status).toBe(200);
  // the preview already shows the unblocked parent at the head, highlighted —
  // while the live queue stays untouched until commit
  expect(res.json.queue.map((x: any) => [x.title, x.front_inserted])).toEqual([
    ["parent work", true],
    ["other work", false],
  ]);
  const live = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(live.map((x: any) => x.title)).toEqual(["other work", "parent work", "which way?"]);
});

it("an abandoned session closes after the timeout", async () => {
  t = await bootTidepool();
  const { question } = await escalatedBoard(t);
  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["left"] });

  // walk away: the timeout commits what the session staged
  await t.clock.advance(TRIAGE_TIMEOUT);
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);
  const titles = (await api(t.baseUrl, "GET", "/api/tasks")).json.map((x: any) => x.title);
  expect(titles).toEqual(["parent work", "other work", "which way?"]);
  expect(t.worker.started.map((x) => x.title)).toEqual(["parent work", "parent work"]);
});

it("タイムアウトで閉じたセッションを次の commit が一度だけ時刻付きで伝える", async () => {
  t = await bootTidepool();
  const started = await api(t.baseUrl, "POST", "/api/triage/start");
  const expectedClosedAt = new Date(
    Date.parse(started.json.started_at) + TRIAGE_TIMEOUT,
  ).toISOString();
  await t.clock.advance(TRIAGE_TIMEOUT);
  queueWork(t, "natural poll を待つ work");

  const closeOnly = await api(t.baseUrl, "POST", "/api/triage/close", { close_only: true });
  const first = await api(t.baseUrl, "POST", "/api/triage/close");
  const second = await api(t.baseUrl, "POST", "/api/triage/close");

  expect(closeOnly).toMatchObject({
    status: 200,
    json: { outcome: "no_open_session", closed_at: null },
  });
  expect(first).toMatchObject({
    status: 200,
    json: { outcome: "already_closed_by_timeout", closed_at: expectedClosedAt },
  });
  expect(second).toMatchObject({
    status: 200,
    json: { outcome: "no_open_session", closed_at: null },
  });
  expect(t.worker.started).toEqual([]);
});

it("activity keeps an open session alive past the timeout window", async () => {
  t = await bootTidepool();
  queueWork(t, "queued work");
  await api(t.baseUrl, "POST", "/api/triage/start");

  // halfway to the timeout the human is still typing on the pad
  await t.clock.advance(TRIAGE_TIMEOUT / 2);
  await api(t.baseUrl, "POST", "/api/triage/scratchpad", { line: "still here" });
  await t.clock.advance(TRIAGE_TIMEOUT / 2);

  // the pause resets on activity: the session is still open, pickup still paused
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).not.toBe(null);
  expect(t.worker.started).toEqual([]);
});

it("scratchpad はセッションを開かず、持ち越し行とライブ queue を返す", async () => {
  t = await bootTidepool();
  queueWork(t, "live queued work");

  const added = await api(t.baseUrl, "POST", "/api/triage/scratchpad", {
    line: "持ち越す苛立ち",
  });
  const triage = await api(t.baseUrl, "GET", "/api/triage");

  expect(added.status).toBe(201);
  expect(triage.json).toMatchObject({
    session: null,
    scratchpad: [{ id: added.json.id, line: "持ち越す苛立ち" }],
  });
  expect(triage.json.queue.map((task: any) => [task.title, task.front_inserted])).toEqual([
    ["live queued work", false],
  ]);
});

it("セッション不在の commit でも scratchpad の振り分けを適用し、タスクを作ったなら tick を進めずに pickup される", async () => {
  t = await bootTidepool();
  const line = (
    await api(t.baseUrl, "POST", "/api/triage/scratchpad", { line: "独立した振り分け" })
  ).json;

  const committed = await api(t.baseUrl, "POST", "/api/triage/close", {
    scratchpad: [{ id: line.id, disposition: "task" }],
  });
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;

  expect(committed).toMatchObject({
    status: 200,
    json: { outcome: "no_open_session", closed_at: null, created_tasks: 1 },
  });
  expect(board.some((task: any) => task.title === "独立した振り分け")).toBe(true);
  // ADR 0119 決定2: 振り分けも登録である —— 候補が増えたので撃つ
  expect(t.worker.started.map((x) => x.title)).toEqual(["独立した振り分け"]);
});

it("scratchpad 行はセッションを開かず共有され、commit で振り分けられる", async () => {
  t = await bootTidepool();
  const lines = [
    "the agent keeps renaming things",
    "fix the flaky seed script",
    "just grumbling",
  ];
  const ids: number[] = [];
  for (const line of lines) {
    const res = await api(t.baseUrl, "POST", "/api/triage/scratchpad", { line });
    expect(res.status).toBe(201);
    ids.push(res.json.id);
  }
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);

  // the pad is shared across the triage screens: every screen reads it back
  const pad = (await api(t.baseUrl, "GET", "/api/triage")).json.scratchpad;
  expect(pad.map((x: any) => x.line)).toEqual(lines);

  // meta_review は振り分けから廃止済み(ADR 0123) —— closeSchema の enum 外で 400 になる
  const rejected = await api(t.baseUrl, "POST", "/api/triage/close", {
    scratchpad: [
      { id: ids[0], disposition: "meta_review" },
      { id: ids[1], disposition: "task" },
      { id: ids[2], disposition: "discard" },
    ],
  });
  expect(rejected.status).toBe(400);

  await api(t.baseUrl, "POST", "/api/triage/close", {
    scratchpad: [
      { id: ids[1], disposition: "task" },
      { id: ids[2], disposition: "discard" },
    ],
  });

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const task = board.find((x: any) => x.title === "fix the flaky seed script");
  expect(task.type).toBe("work");
  expect(board.some((x: any) => x.title === "just grumbling")).toBe(false);
});

it("a scratchpad line dispositioned register is consumed and lands as a pending dump, not a task (issue #61)", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/triage/start");
  const line = (
    await api(t.baseUrl, "POST", "/api/triage/scratchpad", {
      line: "the retry policy needs a real writeup",
    })
  ).json;

  await api(t.baseUrl, "POST", "/api/triage/close", {
    scratchpad: [{ id: line.id, disposition: "register" }],
  });

  // consumed off the board-wide scratchpad — it does not reappear
  await api(t.baseUrl, "POST", "/api/triage/start");
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.scratchpad).toEqual([]);

  // never became a task
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.some((x: any) => x.title === "the retry policy needs a real writeup")).toBe(false);

  // instead it is a pending dump, durable across restart
  const dumps = (await api(t.baseUrl, "GET", "/api/pending-dumps")).json;
  expect(dumps.map((d: any) => d.line)).toEqual(["the retry policy needs a real writeup"]);

  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });
  const afterRestart = (await api(t.baseUrl, "GET", "/api/pending-dumps")).json;
  expect(afterRestart.map((d: any) => d.line)).toEqual(["the retry policy needs a real writeup"]);
});

it("undisposed scratchpad lines survive a timeout close", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/triage/start");
  const line = (await api(t.baseUrl, "POST", "/api/triage/scratchpad", { line: "this again" }))
    .json;
  await t.clock.advance(TRIAGE_TIMEOUT); // walk away — timeout close carries no dispositions
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);

  // the jotted irritation is not lost; opening another session does not change it
  await api(t.baseUrl, "POST", "/api/triage/start");
  const pad = (await api(t.baseUrl, "GET", "/api/triage")).json.scratchpad;
  expect(pad.map((x: any) => x.line)).toEqual(["this again"]);

  // a dispositioned line is consumed for good — discard it and it stays gone
  await api(t.baseUrl, "POST", "/api/triage/close", {
    scratchpad: [{ id: line.id, disposition: "discard" }],
  });
  await api(t.baseUrl, "POST", "/api/triage/start");
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.scratchpad).toEqual([]);
});

it("showing a log entry to the human is itself a recorded event", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "logged work");
  await t.clock.advance(HOUR); // into the slot so it can log a decision
  const entry = await loggedEntry(t, task.id, "went with plan B");

  const res = await api(t.baseUrl, "POST", "/api/triage/displayed", {
    entry_ids: [entry.id],
  });
  expect(res.status).toBe(201);
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);

  // the denominator of the objection rate: an unread entry is neither
  // approved nor rejected — only a displayed one counts
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  const displayed = events.filter((e: any) => e.kind === "log_entry_displayed");
  expect(displayed).toHaveLength(1);
  expect(displayed[0].payload.entry_id).toBe(entry.id);
  expect(displayed[0].payload).not.toHaveProperty("session_id");
  expect(displayed[0].actor_id).toBe("human");
});

it("displaying a new log entry keeps an open triage session alive", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "long log skim");
  await t.clock.advance(HOUR);
  const entry = await loggedEntry(t, task.id, "a late decision");
  await api(t.baseUrl, "POST", "/api/triage/start");

  await t.clock.advance(TRIAGE_TIMEOUT / 2);
  await api(t.baseUrl, "POST", "/api/triage/displayed", { entry_ids: [entry.id] });
  await t.clock.advance(TRIAGE_TIMEOUT / 2);

  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).not.toBe(null);
});

it("commit bundles the objections into one repair task per objected task", async () => {
  t = await bootTidepool();
  const a = await registerWork(t, "work A");
  const b = await registerWork(t, "work B");
  await t.clock.advance(HOUR); // A into the slot
  const e1 = await loggedEntry(t, a.id, "picked the quick hack");
  const e2 = await loggedEntry(t, a.id, "skipped the fixtures");
  await completeVia(t, a.id);
  await t.clock.advance(HOUR); // B into the slot
  const e3 = await loggedEntry(t, b.id, "renamed the config key");

  await api(t.baseUrl, "POST", "/api/triage/start");
  const directions: Array<[any, string]> = [
    [e1, "the hack corrupts state — do it properly"],
    [e2, "bring the fixtures back"],
    [e3, "keep the old key name"],
  ];
  for (const [entry, comment] of directions) {
    await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: entry.id, comment });
  }
  await api(t.baseUrl, "POST", "/api/triage/close");

  // two objected tasks → exactly two repair tasks, each carrying its directions
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const repairs = board.filter((x: any) => x.title.startsWith("repair:"));
  expect(repairs).toHaveLength(2);
  expect(repairs.every((x: any) => x.type === "work" && x.status === "todo")).toBe(true);
  const repairA = repairs.find((x: any) => x.title.includes("work A"));
  expect(repairA.purpose).toContain("the hack corrupts state — do it properly");
  expect(repairA.purpose).toContain("bring the fixtures back");
  const repairB = repairs.find((x: any) => x.title.includes("work B"));
  expect(repairB.purpose).toContain("keep the old key name");
});

it("異議されたエントリを event id 順の対として修理タスクへ束ね、workspace と親を継承する", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "対の修理", "非既定 workspace");
  await t.clock.advance(HOUR);
  const decision = await loggedEntry(t, task.id, "先に古い判断");
  const laterDecision = await loggedEntry(t, task.id, "後の判断");

  await api(t.baseUrl, "POST", "/api/triage/start");
  // 異議の順はエントリ順と逆だが、出力はエントリ自身の id 順になる。
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: laterDecision.id,
    comment: "後の判断を見直す",
  });
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: decision.id,
    comment: "古い判断を見直す",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const repair = board.find((entry: any) => entry.title === "repair: 対の修理");
  expect(repair.parent_id).toBe(task.id);
  expect(repair.workspace).toBe("非既定 workspace");
  expect(repair.purpose).toBe(
    'objections raised against decisions of "対の修理":\n\n' +
      "> 先に古い判断\n" +
      "- 古い判断を見直す\n" +
      "\n" +
      "> 後の判断\n" +
      "- 後の判断を見直す",
  );

  const selfReview = board.find(
    (entry: any) => entry.title === "rca (self): 対の修理",
  );
  const auditorReview = board.find(
    (entry: any) => entry.title === "rca (auditor): 対の修理",
  );
  // RCA の引用はエントリを名指す —— complete_rca の所見が被覆する id(ADR 0278 決定3)
  const rcaPairs =
    `> entry ${decision.id}: 先に古い判断\n` +
    "- 古い判断を見直す\n" +
    "\n" +
    `> entry ${laterDecision.id}: 後の判断\n` +
    "- 後の判断を見直す";
  expect(selfReview.purpose).toBe(`objections raised against decisions fake-worker made on "対の修理":\n\n${rcaPairs}`);
  expect(auditorReview.purpose).toBe(`objections raised against decisions of "対の修理":\n\n${rcaPairs}`);
});

it("同一ログエントリへの2件目の異議は1件目を上書きせず、修理タスクと self/auditor RCA の purpose に両方とも並ぶ(issue #251)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "二重の異議");
  await t.clock.advance(HOUR);
  const decision = await loggedEntry(t, task.id, "一度きりの判断");

  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: decision.id,
    comment: "1件目の方向コメント",
  });
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: decision.id,
    comment: "2件目の方向コメント",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const expectedPair = "> 一度きりの判断\n- 1件目の方向コメント\n- 2件目の方向コメント";
  const repair = board.find((entry: any) => entry.title === "repair: 二重の異議");
  expect(repair.purpose).toBe(
    'objections raised against decisions of "二重の異議":\n\n' + expectedPair,
  );
  const selfReview = board.find((entry: any) => entry.title === "rca (self): 二重の異議");
  const rcaPair = `> entry ${decision.id}: 一度きりの判断\n- 1件目の方向コメント\n- 2件目の方向コメント`;
  expect(selfReview.purpose).toBe(
    'objections raised against decisions fake-worker made on "二重の異議":\n\n' + rcaPair,
  );
  const auditorReview = board.find((entry: any) => entry.title === "rca (auditor): 二重の異議");
  expect(auditorReview.purpose).toBe(
    'objections raised against decisions of "二重の異議":\n\n' + rcaPair,
  );
});

it("result が null の完了エントリへの異議には no outcome recorded を差し込む", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "完了報告なし", undefined, "human");
  await api(t.baseUrl, "POST", `/api/tasks/${task.id}/complete`, {});
  const completed = (await api(t.baseUrl, "GET", "/api/log")).json.entries.find(
    (entry: any) => entry.kind === "task_completed" && entry.task_id === task.id,
  );

  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: completed.id,
    comment: "完了報告を補う",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  const repair = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (entry: any) => entry.title === "repair: 完了報告なし",
  );
  expect(repair.purpose).toContain("> completion report: (no outcome recorded)");
});

it("元タスクの workspace が null なら修理タスクも null のままにする", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "workspace なし");
  await t.clock.advance(HOUR);
  const entry = await loggedEntry(t, task.id, "判断");
  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "修理する",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  const repair = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.title === "repair: workspace なし",
  );
  expect(repair.workspace).toBeNull();
});

it("commit also generates a self RCA review as a child of the objected task, assigned to the worker who wrote the objected decision (issue #15, layer 2)", async () => {
  t = await bootTidepool();
  const a = await registerWork(t, "work A");
  await t.clock.advance(HOUR); // A into the slot
  const e1 = await loggedEntry(t, a.id, "picked the quick hack");

  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: e1.id,
    comment: "the hack corrupts state — do it properly",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const selfReview = board.find(
    (x: any) => x.type === "review" && x.parent_id === a.id && x.assignee === "fake-worker",
  );
  expect(selfReview).toBeDefined();
  expect(selfReview.purpose).toContain("the hack corrupts state — do it properly");
});

it("an in-progress task can complete after an objection attaches repair and RCA children(issue #181)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "work under objection");
  await t.clock.advance(HOUR);
  const entry = await loggedEntry(t, task.id, "picked the quick hack");

  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "replace the hack with the durable implementation",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  const attached = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (child: any) => child.parent_id === task.id,
  );
  expect(attached.some((child: any) => child.title.startsWith("repair:"))).toBe(true);
  expect(attached.filter((child: any) => child.type === "review")).toHaveLength(2);

  await completeVia(t, task.id);

  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

it("two objected entries written by the same worker fold into one self RCA review, not two (issue #15, layer 2)", async () => {
  t = await bootTidepool();
  const a = await registerWork(t, "work A");
  await t.clock.advance(HOUR); // A into the slot, worked by fake-worker throughout
  const e1 = await loggedEntry(t, a.id, "picked the quick hack");
  const e2 = await loggedEntry(t, a.id, "skipped the fixtures");

  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: e1.id,
    comment: "the hack corrupts state — do it properly",
  });
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: e2.id,
    comment: "bring the fixtures back",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const selfReviews = board.filter(
    (x: any) => x.type === "review" && x.parent_id === a.id && x.assignee === "fake-worker",
  );
  expect(selfReviews).toHaveLength(1);
  expect(selfReviews[0].purpose).toContain("the hack corrupts state — do it properly");
  expect(selfReviews[0].purpose).toContain("bring the fixtures back");
});

it("an objection against a human-completed task's log entry generates no self RCA review (GLOSSARY.md's Review: 最終監査者に自分を監査させる輪は作らない)", async () => {
  t = await bootTidepool();
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
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const humanEntry = log.entries.find(
    (e: any) => e.kind === "task_completed" && e.task_id === humanTask.id,
  );
  expect(humanEntry.actor_id).toBe("human");

  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: humanEntry.id,
    comment: "this shouldn't have been approved without a second signature",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const selfReview = board.find(
    (x: any) =>
      x.type === "review" && x.parent_id === humanTask.id && x.title.startsWith("rca (self):"),
  );
  expect(selfReview).toBeUndefined();
  // the independent auditor RCA still fires — it never depends on who wrote
  // the objected entry (GLOSSARY.md's Review: 独立レビュー)
  const auditorReview = board.find(
    (x: any) =>
      x.type === "review" && x.parent_id === humanTask.id && x.title.startsWith("rca (auditor):"),
  );
  expect(auditorReview).toBeDefined();
  // the repair task still lands — objections still act, only self RCA is skipped
  expect(board.some((x: any) => x.title === "repair: approve the vendor invoice")).toBe(true);
});

it("commit also generates an independent auditor RCA review as a child of the objected task, alongside the self RCA (issue #15, layer 2)", async () => {
  t = await bootTidepool();
  const a = await registerWork(t, "work A");
  await t.clock.advance(HOUR); // A into the slot
  const e1 = await loggedEntry(t, a.id, "picked the quick hack");

  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: e1.id,
    comment: "the hack corrupts state — do it properly",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const reviews = board.filter((x: any) => x.type === "review" && x.parent_id === a.id);
  expect(reviews).toHaveLength(2);
  const auditorReview = reviews.find((x: any) => x.title.startsWith("rca (auditor):"));
  expect(auditorReview).toBeDefined();
  expect(auditorReview.purpose).toContain("the hack corrupts state — do it properly");
});

it("the independent auditor RCA registers with assignee unset — a live Auditor reference, not baked at commit time (issue #42)", async () => {
  t = await bootTidepool({ auditorName: "keeper-of-the-code" });
  const a = await registerWork(t, "work A");
  await t.clock.advance(HOUR); // A into the slot
  const e1 = await loggedEntry(t, a.id, "picked the quick hack");

  await api(t.baseUrl, "POST", "/api/triage/start");
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: e1.id,
    comment: "the hack corrupts state — do it properly",
  });
  await api(t.baseUrl, "POST", "/api/triage/close");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const auditorReview = board.find(
    (x: any) => x.type === "review" && x.parent_id === a.id && x.title.startsWith("rca (auditor):"),
  );
  expect(auditorReview).toBeDefined();
  // Board presents the current Auditor, while raw_assignee proves it remains
  // an unset, live reference rather than a name baked at commit time.
  expect(auditorReview).toMatchObject({ assignee: "keeper-of-the-code", raw_assignee: null });
});

/** フィクスチャ盤面(decision 6・7・8)に、2つの session から異議を積む。 */
function objectedFixture() {
  const db = seedFixtureBoard();
  const at = new Date("2026-09-14T00:00:00.000Z");
  const object = (entry_id: number, comment: string, session_id: number) =>
    appendEvent(db, { taskId: FIXTURE_TASK, actorId: "human", origin: "webui", payload: { kind: "objection_raised", entry_id, comment, session_id }, at });
  const a = object(6, "first session", 1);
  const b = object(8, "other entry", 1);
  const c = object(6, "second session", 2);
  return { db, a, b, c };
}

it("entry の異議の読みは、session をまたいで event 順に返す(entry を渡さなければ全 entry)", () => {
  const { db, a, b, c } = objectedFixture();
  expect(entryObjections(db, [6])).toEqual([
    { id: a, entry_id: 6, comment: "first session", session_id: 1 },
    { id: c, entry_id: 6, comment: "second session", session_id: 2 },
  ]);
  expect(entryObjections(db).map((o) => o.id)).toEqual([a, b, c]);
});

it("異議 event id 列の読みは、その id の異議だけを返す", () => {
  const { db, c } = objectedFixture();
  expect(objectionsById(db, 6, [c])).toEqual([{ id: c, entry_id: 6, comment: "second session", session_id: 2 }]);
});

it("異議 event id 列に objection_raised でない id・存在しない id・別 entry を指す id が来たら投げる", () => {
  const { db, a, b } = objectedFixture();
  expect(() => objectionsById(db, 6, [a, 7])).toThrow("event 7 is not an objection");
  expect(() => objectionsById(db, 6, [a, 9999])).toThrow("event 9999 is not an objection");
  expect(() => objectionsById(db, 6, [a, b])).toThrow(`objection ${b} is against entry 8, not 6`);
});

/** decision-log entry でない2種の id: 存在しない id と、human-facing でない
 *  kind(worker_spawned)の id。 */
const NOT_A_LOG_ENTRY: Array<[string, number]> = [
  ["存在しない id", 9999],
  ["human-facing でない kind の id", FIXTURE_SPAWNED_EVENT_ID],
];

const notALogEntry = (entryId: number) => new TriageError(`event ${entryId} is not a decision-log entry`);

it.each(NOT_A_LOG_ENTRY)("raiseObjection は%sを decision-log entry でないとして拒否し、event を書かない", (_, entryId) => {
  const db = seedFixtureBoard();
  const before = listEvents(db, FIXTURE_TASK);
  expect(() => raiseObjection(db, entryId, "comment", new Date())).toThrow(notALogEntry(entryId));
  expect(listEvents(db, FIXTURE_TASK)).toEqual(before);
});

it.each(NOT_A_LOG_ENTRY)(
  "recordDisplayedEntries は%sを decision-log entry でないとして拒否し、正しい id と混ざっても transaction ごと何も書かない",
  (_, entryId) => {
    const db = seedFixtureBoard();
    const before = listEvents(db, FIXTURE_TASK);
    expect(() => recordDisplayedEntries(db, [entryId], new Date())).toThrow(notALogEntry(entryId));
    expect(() => recordDisplayedEntries(db, [6, entryId], new Date())).toThrow(notALogEntry(entryId));
    expect(listEvents(db, FIXTURE_TASK)).toEqual(before);
  },
);

it("commit が立てる子の登録は材料の異議 id 列を持つ —— 修理は束ねた対すべて、auditor RCA は RCA 向きの対、self RCA はその worker の対(ADR 0171 決定1)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-09-30T00:00:00.000Z");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const deckhand = logDecision(db, task, "deckhand's call", "deckhand", at, "worker");
  const helmsman = logDecision(db, task, "helmsman's call", "helmsman", at, "worker");
  const preferred = logDecision(db, task, "deckhand's naming", "deckhand", at, "worker");
  startTriage(db, at);
  const [d, h, p] = [deckhand, helmsman, preferred].map((entry) => raiseObjection(db, entry, "redo it", at));
  const judged = (cause: Cause): GatedJudgment => ({ cause, evidence: "e", wrong_memory_entries: null });

  commitTriage(db, at, [], new Map([[deckhand, judged("capability")], [preferred, judged("preference")]]));

  const registered = listChildren(db, task.id).map((c) => {
    const payload = listEvents(db, c.id).find((e) => e.kind === "task_registered")!.payload;
    return [c.title, c.assignee, "opened_on_event_ids" in payload ? payload.opened_on_event_ids : undefined];
  });
  expect(registered).toEqual([
    ["repair: t", null, [d, h, p]],
    ["rca (self): t", "deckhand", [d]],
    ["rca (self): t", "helmsman", [h]],
    ["rca (auditor): t", null, [d, h]],
  ]);
});

it.each([
  ["registry あり", { agentRegistered: (name: string) => name === "deckhand", resolvesToBuiltIn: () => false }],
  ["registry なし", undefined],
] as const)("%sでも修理子は work の assignee を写す —— エントリの書き手とは別(ADR 0237)", (_, assigneeDeps) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-10T00:00:00.000Z");
  const task = registerTask(db, { type: "work", assignee: "deckhand", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const entry = logDecision(db, task, "human's call", HUMAN_ACTOR_ID, at, "webui");
  raiseObjection(db, entry, "redo it", at);

  commitTriage(db, at, [], new Map(), assigneeDeps);

  const repair = listChildren(db, task.id).find((child) => child.type === "work")!;
  expect(repair.assignee).toBe("deckhand");
  expect(listEvents(db, repair.id).find((event) => event.kind === "task_registered")!.payload).not.toHaveProperty("assignee_not_copied");
});

it.each([
  ["removed-agent", false, false, "unknown agent: removed-agent"],
  ["fugu", true, true, "agent fugu is the built-in agent, which runs only reviews, Interviews, memory repairs and routing repairs"],
] as const)("修理子に写せない %s は空に落ち、名前と門の拒否文が登録 event に残る(ADR 0237)", (name, registered, builtIn, reason) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-10T00:00:00.000Z");
  const task = registerTask(db, { type: "work", assignee: name, title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const entry = logDecision(db, task, "human's call", HUMAN_ACTOR_ID, at, "webui");
  raiseObjection(db, entry, "redo it", at);

  const result = commitTriage(db, at, [], new Map(), { agentRegistered: () => registered, resolvesToBuiltIn: () => builtIn });

  expect(result.outcome).toBe("closed_now");
  const repair = listChildren(db, task.id).find((child) => child.type === "work")!;
  expect(repair.assignee).toBeNull();
  expect(listEvents(db, repair.id).find((event) => event.kind === "task_registered")!.payload).toMatchObject({
    assignee_not_copied: { name, reason },
  });
});

it.each([
  ["work", "human", "human"],
  ["review", undefined, null],
  ["review", "reviewer", "reviewer"],
] as const)("%s の assignee %s から修理子への宛先は %s(ADR 0237 / ADR 0275 決定2)", (type, assignee, expected) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-10T00:00:00.000Z");
  const task = registerTask(db, { type, assignee, title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const entry = logDecision(db, task, "human's call", HUMAN_ACTOR_ID, at, "webui");
  raiseObjection(db, entry, "redo it", at);

  commitTriage(db, at, [], new Map(), { agentRegistered: () => true, resolvesToBuiltIn: () => false });

  const repair = listChildren(db, task.id).find((child) => child.type === "work")!;
  expect(repair.assignee).toBe(expected);
  expect(listEvents(db, repair.id).find((event) => event.kind === "task_registered")!.payload).not.toHaveProperty("assignee_not_copied");
});

it("pickup 前の work の人間 decompose への異議は修理子の宛先を空に保つ(ADR 0237)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-10T00:00:00.000Z");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  humanDecomposeTask(db, task, { reason: "split the work", children: [{ title: "child", purpose: "p", completion_criteria: "c" }] }, at, undefined, "webui");
  const entry = listEvents(db, task.id).find((event) => event.kind === "decision_logged")!;
  raiseObjection(db, entry.id, "redo it", at);

  commitTriage(db, at, [], new Map(), { agentRegistered: () => false, resolvesToBuiltIn: () => true });

  const repair = listChildren(db, task.id).find((child) => child.title === "repair: t")!;
  expect(repair.assignee).toBeNull();
  expect(listEvents(db, repair.id).find((event) => event.kind === "task_registered")!.payload).not.toHaveProperty("assignee_not_copied");
});

it.each([
  ["commit", (db: Db, at: Date) => commitTriage(db, at, [], new Map(), { agentRegistered: () => true, resolvesToBuiltIn: () => false })],
  ["timeout", (db: Db, at: Date) => closeStaleTriage(db, new Date(at.getTime() + TRIAGE_TIMEOUT), { agentRegistered: () => true, resolvesToBuiltIn: () => false })],
] as const)("%s で閉じても question の人間の判断への異議から立つ修理子の宛先は human で、slot に出ない(ADR 0237 / #2377)", (_, close) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-10T00:00:00.000Z");
  const question = registerTask(
    db,
    {
      type: "question",
      title: "retry?",
      purpose: "p",
      completion_criteria: "c",
      workspace: "sandbox",
      question: [{ title: "retry?", options: ["retry", "abandon promotion"], recommendation: "retry" }],
    },
    at,
    BOARD_ACTOR_ID,
    "board",
  );
  answerQuestionViaWebui(db, question, ["abandon promotion"], at);
  const entry = logDecision(db, getTask(db, question.id)!, "abandon promotion", HUMAN_ACTOR_ID, at, "webui");
  startTriage(db, at);
  raiseObjection(db, entry, "retry it", at);

  close(db, at);

  const children = listChildren(db, question.id);
  const repair = children.find((child) => child.type === "work")!;
  expect(repair.assignee).toBe(HUMAN_ACTOR_ID);
  expect(listEvents(db, repair.id).find((event) => event.kind === "task_registered")!.payload).not.toHaveProperty("assignee_not_copied");
  const rca = children.find((child) => child.type === "review")!;
  expect(rca.title).toBe("rca (auditor): retry?");
  // RCA は正当に slot の先頭に来るので候補から外し、残りに修理子が無いことを見る
  expect(nextSlotTask(db, "sandbox", "deckhand", "fugu", undefined, [rca.id])).toBeUndefined();
});

it("ルートの question の人間の判断の行は帰り先がある —— 異議は human 宛ての work の修理子を立て、流し読みの no_work_repair は false(ADR 0237 決定3 / #2377 / ADR 0301 決定1)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-23T00:00:00.000Z");
  const question = registerTask(
    db,
    { type: "question", title: "merge?", purpose: "p", completion_criteria: "c", question: [{ title: "merge?", options: ["merge", "hold"], recommendation: "merge" }] },
    at,
    BOARD_ACTOR_ID,
    "board",
  );
  answerQuestionViaWebui(db, question, ["hold"], at);
  const entry = logDecision(db, getTask(db, question.id)!, "hold", HUMAN_ACTOR_ID, at, "webui");

  expect(listLog(db).find((e) => e.id === entry)!.no_work_repair).toBe(false);
  startTriage(db, at);
  raiseObjection(db, entry, "merge it", at);
  commitTriage(db, at);

  expect(listChildren(db, question.id).filter((child) => child.type === "work").map((repair) => [repair.title, repair.assignee])).toEqual([["repair: merge?", HUMAN_ACTOR_ID]]);
});

it("timeout も修理子の assignee を門に通す(ADR 0237)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-10T00:00:00.000Z");
  const task = registerTask(db, { type: "work", assignee: "fugu", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const entry = logDecision(db, task, "human's call", HUMAN_ACTOR_ID, at, "webui");
  raiseObjection(db, entry, "redo it", at);

  expect(closeStaleTriage(db, new Date(at.getTime() + TRIAGE_TIMEOUT), { agentRegistered: () => true, resolvesToBuiltIn: () => true })).toBe(true);

  const repair = listChildren(db, task.id).find((child) => child.type === "work")!;
  expect(repair.assignee).toBeNull();
  expect(listEvents(db, repair.id).find((event) => event.kind === "task_registered")!.payload).toMatchObject({
    assignee_not_copied: { name: "fugu", reason: "agent fugu is the built-in agent, which runs only reviews, Interviews, memory repairs and routing repairs" },
  });
});

it.each(["commit", "close-only", "watchdog"] as const)("%s の入口は registry の assignee 依存を束ねへ渡す(ADR 0237)", async (path) => {
  const agentRegistered = vi.fn(() => true);
  const resolvesToBuiltIn = vi.fn(() => false);
  t = await bootTidepool({ agentRegistered, resolvesToBuiltIn });
  const at = t.clock.now();
  const task = registerTask(t.db, { type: "work", assignee: "repair-worker", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const entry = logDecision(t.db, task, "human's call", HUMAN_ACTOR_ID, at, "webui");
  await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: entry, comment: "redo it" });
  agentRegistered.mockClear();
  resolvesToBuiltIn.mockClear();

  if (path === "watchdog") {
    await t.clock.advance(TRIAGE_TIMEOUT);
  } else {
    expect((await api(t.baseUrl, "POST", "/api/triage/close", { close_only: path === "close-only" })).status).toBe(200);
  }

  expect(agentRegistered).toHaveBeenCalledWith("repair-worker");
  expect(resolvesToBuiltIn).toHaveBeenCalledWith("repair-worker");
});

it("修理の purpose は判定のある対の steering の後に board judged 行を運び、未帰責と uncertain の対には出さず、RCA の purpose には乗せない(ADR 0213 決定3)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-08T00:00:00.000Z");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const outage = logDecision(db, task, "retried the fetch", "deckhand", at, "worker");
  const guessed = logDecision(db, task, "guessed the schema", "deckhand", at, "worker");
  const unsure = logDecision(db, task, "picked a name", "deckhand", at, "worker");
  const unjudged = logDecision(db, task, "skipped the lint", "deckhand", at, "worker");
  startTriage(db, at);
  for (const entry of [outage, guessed, unsure, unjudged]) raiseObjection(db, entry, "redo it", at);

  commitTriage(
    db,
    at,
    [],
    new Map<number, GatedJudgment>([
      [outage, { cause: "environment", evidence: "the registry was down", wrong_memory_entries: null }],
      [guessed, { cause: "capability", evidence: "guessed past the missing schema", wrong_memory_entries: null }],
      [unsure, { cause: "uncertain", evidence: "the log does not say", wrong_memory_entries: null }],
    ]),
  );

  const purposes = Object.fromEntries(listChildren(db, task.id).map((c) => [`${c.title} ${c.assignee}`, c.purpose]));
  expect(purposes["repair: t null"]).toBe(
    'objections raised against decisions of "t":\n\n' +
      "> retried the fetch\n- redo it\nboard judged: environment — the registry was down\n\n" +
      "> guessed the schema\n- redo it\nboard judged: capability — guessed past the missing schema\n\n" +
      "> picked a name\n- redo it\n\n" +
      "> skipped the lint\n- redo it",
  );
  // RCA の findings は第2回の帰責の証拠 —— 初回の判定を見せない(循環)
  const rcaPairs =
    `> entry ${guessed}: guessed the schema\n- redo it\n\n` +
    `> entry ${unsure}: picked a name\n- redo it\n\n` +
    `> entry ${unjudged}: skipped the lint\n- redo it`;
  expect(purposes["rca (self): t deckhand"]).toBe(`objections raised against decisions deckhand made on "t":\n\n${rcaPairs}`);
  expect(purposes["rca (auditor): t null"]).toBe(`objections raised against decisions of "t":\n\n${rcaPairs}`);
});

it.each([
  ["コミット", (db: Db, at: Date): unknown => commitTriage(db, at), "webui"],
  ["close-only", (db: Db, at: Date): unknown => closeTriageSessionOnly(db, at, "commit"), "webui"],
  ["タイムアウト", (db: Db, at: Date): unknown => closeStaleTriage(db, new Date(at.getTime() + TRIAGE_TIMEOUT)), "board"],
] as const)("%sで閉じた triage の RCA review は盤面名義、修理タスクと前挿しは human 名義で、登録と前挿しの経路は %s(ADR 0194 決定3・4)", (_, close, origin) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-02T00:00:00.000Z");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const staged = registerTask(db, { type: "work", title: "staged", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const entry = logDecision(db, task, "deckhand's call", "deckhand", at, "worker");
  const session = startTriage(db, at);
  raiseObjection(db, entry, "redo it", at);
  stageFrontInsert(db, session.id, staged.id);

  close(db, at);

  const registered = listChildren(db, task.id).map((c) => {
    const event = listEvents(db, c.id).find((e) => e.kind === "task_registered")!;
    return [c.title, event.actor_id, event.origin];
  });
  expect(registered).toEqual([
    ["repair: t", HUMAN_ACTOR_ID, origin],
    ["rca (self): t", BOARD_ACTOR_ID, "board"],
    ["rca (auditor): t", BOARD_ACTOR_ID, "board"],
  ]);
  expect(listEvents(db, staged.id).find((e) => e.kind === "task_moved")).toMatchObject({ actor_id: HUMAN_ACTOR_ID, origin });
});

/** 記憶の書き込みの行(Knowledge の note)を `writerTaskId` の task の書き込みとして残す。 */
const recordNote = (db: Db, at: Date, writerTaskId: string) =>
  recordKnowledge(db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at, writerTaskId);
const registration = (db: Db, child: Task) => listEvents(db, child.id).find((event) => event.kind === "task_registered")!;

it.each([
  ["判断", "cancelled", "", ["rca (self): t", "rca (auditor): t"]],
  ["判断", "done", "", ["repair: t", "rca (self): t", "rca (auditor): t"]],
  ["判断", "in_progress", "", ["repair: t", "rca (self): t", "rca (auditor): t"]],
  ["判断", "done", "・cancelled の祖先あり", ["rca (self): t", "rca (auditor): t"]],
  ["判断", "Interview の root", "", ["rca (self): interview", "rca (auditor): interview"]],
  ["記憶", "cancelled", "", ["memory repair: t", "rca (self): t", "rca (auditor): t"]],
  ["記憶", "done", "", ["memory repair: t", "rca (self): t", "rca (auditor): t"]],
  ["記憶", "in_progress", "", ["memory repair: t", "rca (self): t", "rca (auditor): t"]],
  ["記憶", "done", "・cancelled の祖先あり", ["memory repair: t", "rca (self): t", "rca (auditor): t"]],
  ["記憶", "Interview の root", "", ["memory repair: interview", "rca (self): interview", "rca (auditor): interview"]],
  ["混在", "cancelled", "", ["memory repair: t", "rca (self): t", "rca (auditor): t"]],
  ["混在", "done", "", ["repair: t", "memory repair: t", "rca (self): t", "rca (auditor): t"]],
  ["混在", "in_progress", "", ["repair: t", "memory repair: t", "rca (self): t", "rca (auditor): t"]],
  ["混在", "done", "・cancelled の祖先あり", ["memory repair: t", "rca (self): t", "rca (auditor): t"]],
  ["混在", "Interview の root", "", ["memory repair: interview", "rca (self): interview", "rca (auditor): interview"]],
] as const)("%sの行への、%s%s の task の異議の commit が立てる子は %j —— 記憶の行は親を問わず memory_repair、判断の行は捨てた成果には work の修理子を立てず、どちらの修理子も自分の群の異議だけを運び、帰責 event と RCA は群を分けず状態に依らない(ADR 0268 決定3 / ADR 0271 決定1・2 / ADR 0272 決定1・2)", (rows, status, ancestor, titles) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-16T00:00:00.000Z");
  const spec = { assignee: "deckhand", title: "t", purpose: "p", completion_criteria: "c", workspace: "charts" };
  const root = ancestor ? registerTask(db, { type: "work", title: "root", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI) : undefined;
  const registered =
    status === "Interview の root"
      ? getTask(db, examineeRootId(db, interviewExaminee(db, at).id))!
      : root
        ? decomposeTaskViaWorker(db, root, { reason: "split", children: [spec] }, "deckhand", at)[0]!
        : registerTask(db, { type: "work", ...spec }, at, ...HUMAN_WEBUI);
  const decision = logDecision(db, registered, "deckhand's call", "deckhand", at, "worker");
  const memory = recordNote(db, at, registered.id).event_id;
  if (status === "cancelled") cancelTaskDirectly(db, registered, null, at, {}, "webui");
  else if (status !== "Interview の root") {
    const running = pickupTask(db, registered, "deckhand", at)!;
    if (status === "done") completeTask(db, running, FULL_HANDOFF, "deckhand", at, "worker");
  }
  if (root) cancelTaskDirectly(db, getTask(db, root.id)!, null, at, {}, "webui");
  if (status !== "Interview の root") expect(getTask(db, registered.id)!.status).toBe(status);
  startTriage(db, at);
  const objections = {
    decision: rows === "記憶" ? [] : [raiseObjection(db, decision, "redo it", at)],
    memory: rows === "判断" ? [] : [raiseObjection(db, memory, "drop the note", at)],
  };
  const entries = [...(rows === "記憶" ? [] : [decision]), ...(rows === "判断" ? [] : [memory])];

  commitTriage(db, at, [], new Map(entries.map((entry) => [entry, { cause: "capability", evidence: "e", wrong_memory_entries: null }])));

  // done の work には完了時レビューも付くので、異議の束ねが立てた子だけを見る
  const bundled = listChildren(db, registered.id).filter((child) => child.type !== "review" || child.title.startsWith("rca"));
  expect(bundled.map((child) => child.title)).toEqual(titles);
  const groups = {
    work: { ids: objections.decision, intro: `objections raised against decisions of "${registered.title}"`, own: "redo it", other: "drop the note" },
    memory_repair: { ids: objections.memory, intro: `objections raised against memory writes of "${registered.title}"`, own: "drop the note", other: "redo it" },
  };
  for (const child of bundled) {
    if (child.type === "review") {
      expect(registration(db, child).payload).toMatchObject({ opened_on_event_ids: [...objections.decision, ...objections.memory] });
      continue;
    }
    const group = groups[child.type as keyof typeof groups];
    expect(registration(db, child).payload).toMatchObject({ opened_on_event_ids: group.ids });
    expect(child.purpose).toContain(group.intro);
    expect(child.purpose).toContain(group.own);
    expect(child.purpose).not.toContain(group.other);
  }
  const memoryRepair = bundled.find((child) => child.type === "memory_repair");
  if (memoryRepair) {
    expect(memoryRepair).toMatchObject({ workspace: getTask(db, registered.id)!.workspace, assignee: registered.assignee });
    expect(registration(db, memoryRepair)).toMatchObject({ actor_id: HUMAN_ACTOR_ID, origin: "webui" });
  }
  expect(listEvents(db, registered.id).filter((event) => event.kind === "objection_attributed").map((event) => event.payload)).toEqual(
    entries.map((entry) => expect.objectContaining({ entry_id: entry, cause: "capability", round: "initial" })),
  );
});

it.each([
  ["memory", "判断の行"],
  ["memory", "型つきの判断の行"],
  ["memory", "完了の行"],
  ["routing", "判断の行"],
  ["routing", "完了の行"],
] as const)("%s の meta-review の%sへの異議の commit は work の修理子を立てず(対象を名指す memory の型つきの行は memory_repair)、帰責 event と RCA は立つ(ADR 0279 決定1・3・4)", (subject, rowKind) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-20T00:00:00.000Z");
  let review: Task;
  let row: number;
  if (rowKind === "型つきの判断の行") {
    // completeMemoryReview が書く、対象を名指す型つきの行(#2283)。routing の型つきの行は #2284 待ち
    registerMetaReview(db, "memory", at);
    db.prepare("UPDATE tasks SET status = 'done' WHERE meta_review_subject = 'memory'").run();
    recordKnowledge(db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at);
    registerMetaReview(db, "memory", at);
    review = listBoard(db).find((task) => task.meta_review_subject === "memory" && task.status === "todo")! as Task;
    const items = injectMemoryMaterial(db, review.id, "fugu", at);
    completeMemoryReview(db, review, { judgments: items }, "fugu", at, "worker");
    row = listEvents(db, review.id).find(({ payload }) => payload.kind === "decision_logged" && payload.judgment)!.id;
  } else {
    review = registerTask(db, { type: "review", title: "t", purpose: "p", completion_criteria: "c", meta_review_subject: subject }, at, ...HUMAN_WEBUI);
    spawnedAs(db, review, "fugu", at);
    if (rowKind === "判断の行") row = logDecision(db, review, "fugu's call", "fugu", at, "worker");
    else {
      finishTask(db, pickupTask(db, review, "fugu", at)!, { outcome: "done" }, "fugu", at, "worker");
      row = listEvents(db, review.id).find((event) => event.kind === "task_completed")!.id;
    }
  }
  raiseObjection(db, row, "redo it", at);

  commitTriage(db, at, [], new Map([[row, { cause: "capability", evidence: "e", wrong_memory_entries: null }]]));

  const repair = rowKind === "型つきの判断の行" ? [`memory repair: ${review.title}`] : [];
  expect(listChildren(db, review.id).map((child) => child.title)).toEqual([...repair, `rca (self): ${review.title}`, `rca (auditor): ${review.title}`]);
  expect(listEvents(db, review.id).filter((event) => event.kind === "objection_attributed")).toHaveLength(1);
});

it("memory の meta-review の記憶の書き込みの行への異議は今どおり memory_repair 1本に束ねられる(ADR 0272 決定1)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-20T00:00:00.000Z");
  const review = registerTask(db, { type: "review", title: "t", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" }, at, ...HUMAN_WEBUI);
  spawnedAs(db, review, "fugu", at);
  raiseObjection(db, recordNote(db, at, review.id).event_id, "drop the note", at);

  commitTriage(db, at);

  expect(listChildren(db, review.id).map((child) => child.type).filter((type) => type !== "review")).toEqual(["memory_repair"]);
});

/** meta-review(`subject` が null なら work)の下の系譜の task: 主題の修理子(worker の下では memory_repair)か、root の行への異議で立った auditor RCA。 */
function lineageTask(db: Db, at: Date, subject: "memory" | "routing" | null, kind: "修理子" | "RCA"): Task {
  const root =
    subject === null
      ? registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c", workspace: "charts" }, at, ...HUMAN_WEBUI)
      : registerTask(db, { type: "review", title: "t", purpose: "p", completion_criteria: "c", meta_review_subject: subject }, at, ...HUMAN_WEBUI);
  spawnedAs(db, root, "fugu", at);
  if (kind === "修理子") {
    const type = subject === "routing" ? "routing_repair" : "memory_repair";
    return registerTask(db, { type, title: `${type}: t`, purpose: "p", completion_criteria: "c", parent_id: root.id }, at, ...HUMAN_WEBUI);
  }
  return auditorRcaOn(db, root, at, "fugu");
}

it.each([
  ["memory", "修理子", "自由文の行"],
  ["memory", "修理子", "完了の行"],
  ["routing", "修理子", "自由文の行"],
  ["routing", "修理子", "完了の行"],
  ["memory", "RCA", "自由文の行"],
  ["memory", "RCA", "完了の行"],
  ["memory", "RCA", "型つきの所見の行(RCA は done)"],
  ["routing", "RCA", "自由文の行"],
  ["routing", "RCA", "型つきの所見の行(RCA は done)"],
] as const)("%s の meta-review の下の%sの%sへの異議の commit は work の修理子を立てず、帰責 event と RCA は立つ(ADR 0283 決定2)", (subject, kind, rowKind) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-20T00:00:00.000Z");
  const objected = lineageTask(db, at, subject, kind);
  spawnedAs(db, objected, "auditor", at);
  let row: number;
  if (rowKind === "自由文の行") row = logDecision(db, objected, "auditor's call", "auditor", at, "worker");
  else if (rowKind === "完了の行") {
    finishTask(db, pickupTask(db, objected, "auditor", at)!, { outcome: "done" }, "auditor", at, "worker");
    row = listEvents(db, objected.id).find((event) => event.kind === "task_completed")!.id;
  } else {
    completeRca(db, objected, rcaFindings(db, objected.id), "auditor", at, "worker");
    expect(getTask(db, objected.id)!.status).toBe("done");
    row = listEvents(db, objected.id).find(({ payload }) => payload.kind === "decision_logged" && payload.judgment?.kind === "rca")!.id;
  }
  startTriage(db, at);
  raiseObjection(db, row, "redo it", at);

  commitTriage(db, at, [], new Map([[row, { cause: "capability", evidence: "e", wrong_memory_entries: null }]]));

  expect(listChildren(db, objected.id).map((child) => child.title)).toEqual([`rca (self): ${objected.title}`, `rca (auditor): ${objected.title}`]);
  expect(listEvents(db, objected.id).filter((event) => event.kind === "objection_attributed")).toHaveLength(1);
});

it("meta-review の下の memory_repair の記憶の書き込みの行への異議は今どおり memory_repair 1本、worker の task の下の memory_repair / RCA の自由文の行への異議は今どおり work の修理子(ADR 0272 決定1・2 / ADR 0283 決定2)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-20T00:00:00.000Z");
  const subjectRepair = lineageTask(db, at, "memory", "修理子");
  const workerRepair = lineageTask(db, at, null, "修理子");
  const workerRca = lineageTask(db, at, null, "RCA");
  startTriage(db, at);
  raiseObjection(db, recordNote(db, at, subjectRepair.id).event_id, "drop the note", at);
  const rows = [workerRepair, workerRca].map((task) => logDecision(db, task, "auditor's call", "auditor", at, "worker"));
  for (const row of rows) raiseObjection(db, row, "redo it", at);

  commitTriage(db, at, [], new Map(rows.map((row) => [row, { cause: "capability", evidence: "e", wrong_memory_entries: null }])));

  expect(listChildren(db, subjectRepair.id).map((child) => child.type).filter((type) => type !== "review")).toEqual(["memory_repair"]);
  for (const task of [workerRepair, workerRca]) expect(listChildren(db, task.id).map((child) => child.type).filter((type) => type !== "review")).toEqual(["work"]);
});

it("人間が登録した root の review(独立監査)の判断の行と、その RCA の判断の行への異議は、work の修理子を保護ブランチ基点で立てる —— work の祖先が無いことは帰り先が無い理由にならない(#2505 測定 E / ADR 0301 決定1)", async () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-22T00:00:00.000Z");
  const workspace = await makeWorkspace("independent-audit");
  const audit = registerTask(db, { type: "review", title: "review main", purpose: "p", completion_criteria: "c", workspace: workspace.name }, at, ...HUMAN_WEBUI);
  spawnedAs(db, audit, "fugu", at);
  const rca = auditorRcaOn(db, audit, at, "fugu");
  auditorRcaOn(db, rca, at, "auditor");

  for (const objected of [audit, rca]) {
    const repairs = listChildren(db, objected.id).filter((child) => child.type === "work");
    expect(repairs.map((repair) => repair.title)).toEqual([`repair: ${objected.title}`]);
    expect(resolveTaskBranchLineage(db, workspace, repairs[0]!).branch).toBeUndefined();
  }
});

it("人間が直接 cancel した review 子と、cancelled の work の祖先を挟む RCA の判断の行への異議は、帰責と RCA だけを立て work の修理子を立てない(ADR 0268 決定3 / ADR 0271 決定1 / ADR 0301 決定3)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-22T00:00:00.000Z");
  const root = registerTask(db, { type: "work", title: "root", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const [child] = humanDecomposeTask(db, root, { reason: "split", children: [{ title: "child", purpose: "p", completion_criteria: "c" }] }, at, undefined, "webui");
  markPickedUp(db, child!.id, at);
  const reviewChild = registerTask(db, { type: "review", title: "second look", purpose: "p", completion_criteria: "c", parent_id: child!.id }, at, ...HUMAN_WEBUI);
  const rca = auditorRcaOn(db, child!, at, "deckhand");
  const objectRow = (objected: Task, worker: string) => {
    const row = logDecision(db, objected, `${worker}'s call`, worker, at, "worker");
    startTriage(db, at);
    raiseObjection(db, row, "redo it", at);
    commitTriage(db, at, [], new Map([[row, { cause: "capability", evidence: "e", wrong_memory_entries: null }]]));
  };
  // review 子だけを cancel する —— 祖先の work は生きている(今の捨てた成果の判定には当たらない)
  cancelTaskDirectly(db, reviewChild, null, at, {}, "webui");
  expect(getTask(db, child!.id)!.status).toBe("todo");
  objectRow(reviewChild, "fugu");
  cancelTaskDirectly(db, getTask(db, root.id)!, null, at, {}, "webui");
  expect([child!, rca].map((task) => getTask(db, task.id)!.status)).toEqual(["cancelled", "todo"]);
  objectRow(rca, "auditor");

  for (const objected of [reviewChild, rca]) {
    expect(listChildren(db, objected.id).map((c) => c.title)).toEqual([expect.stringMatching(/^rca \(self\)/), `rca (auditor): ${objected.title}`]);
    expect(listEvents(db, objected.id).filter((event) => event.kind === "objection_attributed")).toHaveLength(1);
  }
});

it("流し読みのエントリの no_work_repair は、帰り先の無い task の判断の行(Interview の root・その下の RCA・meta-review の自由文の行・cancelled の task)で true、独立監査とその RCA・普通の work の判断の行・記憶の書き込みの行・meta-review の型つきの判断の行では false(ADR 0301 決定6)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-22T00:00:00.000Z");
  const root = interviewRoot(db, at);
  spawnedAs(db, root, "suzumedai", at);
  const rootRow = logDecision(db, root, "the rubric is fair", "suzumedai", at, "worker");
  const rootMemoryRow = recordNote(db, at, root.id).event_id;
  const rootRca = auditorRcaOn(db, root, at, "suzumedai");
  const rootRcaRow = logDecision(db, rootRca, "the cause is X", "auditor", at, "worker");
  const metaReview = registerTask(db, { type: "review", title: "memory meta-review", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" }, at, ...HUMAN_WEBUI);
  const metaRow = logDecision(db, metaReview, "keep entry 3", "fugu", at, "worker");
  const typedRow = appendEvent(db, { taskId: metaReview.id, actorId: "fugu", origin: "worker", at, payload: { kind: "decision_logged", line: "left_as_is", judgment: { kind: "memory", memory_entry: 1, value: "left_as_is" } } });
  const cancelled = registerTask(db, { type: "work", title: "dropped", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const cancelledRow = logDecision(db, cancelled, "split it", "deckhand", at, "worker");
  cancelTaskDirectly(db, cancelled, null, at, {}, "webui");
  const audit = registerTask(db, { type: "review", title: "review main", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const auditRow = logDecision(db, audit, "main is fine", "fugu", at, "worker");
  const auditRca = auditorRcaOn(db, audit, at, "fugu");
  const auditRcaRow = logDecision(db, auditRca, "the cause is Y", "auditor", at, "worker");
  const work = registerTask(db, { type: "work", title: "plain", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const workRow = logDecision(db, work, "use a lexer", "deckhand", at, "worker");

  const noWorkRepair = new Map(listLog(db).map((entry) => [entry.id, entry.no_work_repair]));

  for (const row of [rootRow, rootRcaRow, metaRow, cancelledRow]) expect(noWorkRepair.get(row)).toBe(true);
  for (const row of [rootMemoryRow, typedRow, auditRow, auditRcaRow, workRow]) expect(noWorkRepair.get(row)).toBe(false);
});

const interviewRoot = (db: Db, at: Date, assignee?: string) =>
  registerTask(
    db,
    { type: "interview", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }], assignee },
    at,
    ...HUMAN_WEBUI,
  );
const spawnedAs = (db: Db, task: Task, name: string, at: Date) => appendEvent(db, { taskId: task.id, actorId: name, origin: "board", payload: WORKER_SPAWNED, at });

it.each([
  ["Interview の root(列は空の参照)", (db: Db, at: Date) => {
    const root = interviewRoot(db, at);
    spawnedAs(db, root, "suzumedai", at);
    return { objected: root, row: recordNote(db, at, root.id).event_id };
  }, "suzumedai"],
  ["meta-review の root(列は Auditor 参照)", (db: Db, at: Date) => {
    const reviewed = registerTask(db, { type: "review", title: "memory meta-review", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" }, at, ...HUMAN_WEBUI);
    spawnedAs(db, reviewed, "fugu", at);
    const moved = moveMemoryByMetaReview(db, { entry_id: recordNote(db, at, reviewed.id).entry_id, scope: "charts", path: "build/squash", mover: { activity: "meta_review", name: "fugu" } }, "worker", at, reviewed.id);
    return { objected: reviewed, row: moved.event_id };
  }, "fugu"],
  ["人間が registry の agent を名指した Interview の root(最後の worker_spawned が別の名前でも列が勝つ)", (db: Db, at: Date) => {
    const root = interviewRoot(db, at, "examiner");
    spawnedAs(db, root, "suzumedai", at);
    return { objected: root, row: recordNote(db, at, root.id).event_id };
  }, "examiner"],
  ["memory_repair(列は pickup が焼いた名前)", (db: Db, at: Date) => {
    const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
    const wrote = recordNote(db, at, task.id);
    raiseObjection(db, wrote.event_id, "drop the note", at);
    commitTriage(db, at);
    const first = listChildren(db, task.id).find((child) => child.type === "memory_repair")!;
    expect(first.assignee).toBeNull();
    pickupTask(db, first, "deckhand", at, { assignee: "deckhand" });
    const replaced = repairReplace(db, { taskId: first.id, agent: "deckhand" }, { entry_id: wrote.entry_id, title: "Rebase", text: "Always rebase.", source: { commit: "1b57b57" } }, at);
    return { objected: getTask(db, first.id)!, row: replaced.event_id };
  }, "deckhand"],
] as const)("%sの記憶の行への異議の memory_repair は異議された task を走らせた名前を焼く —— 列が名前なら列、参照なら最後の worker_spawned の名前(ADR 0275 決定2)", (_, setup, expected) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-18T00:00:00.000Z");
  const { objected, row } = setup(db, at);
  raiseObjection(db, row, "drop the note", at);

  commitTriage(db, at, [], new Map(), { agentRegistered: () => true, resolvesToBuiltIn: (name) => name === "suzumedai" || name === "fugu" });

  const repair = listChildren(db, objected.id).find((child) => child.type === "memory_repair")!;
  expect(repair.assignee).toBe(expected);
  expect(registration(db, repair).payload).not.toHaveProperty("assignee_not_copied");
});

it.each([
  ["reviewer", "reviewer", undefined],
  ["fugu", null, { name: "fugu", reason: "agent fugu is the built-in agent, which runs only reviews, Interviews, memory repairs and routing repairs" }],
] as const)("列が空の review の判断の行への異議の work の修理子は最後の worker_spawned の名前 %s を門に通し、宛先は %s(ADR 0275 決定2 / ADR 0237 決定2)", (spawned, expected, notCopied) => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-18T00:00:00.000Z");
  const review = registerTask(db, { type: "review", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  spawnedAs(db, review, spawned, at);
  raiseObjection(db, logDecision(db, review, "reviewer's call", spawned, at, "worker"), "redo it", at);

  commitTriage(db, at, [], new Map(), { agentRegistered: () => true, resolvesToBuiltIn: (name) => name === "fugu" });

  const repair = listChildren(db, review.id).find((child) => child.type === "work")!;
  expect(repair.assignee).toBe(expected);
  if (notCopied) expect(registration(db, repair).payload).toMatchObject({ assignee_not_copied: notCopied });
  else expect(registration(db, repair).payload).not.toHaveProperty("assignee_not_copied");
});

it("registry から消えた agent を名指した root の記憶の行への異議の memory_repair は空に落ち、名前と門の拒否文が登録 event に残る(ADR 0275 決定2 / ADR 0237 決定2)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-18T00:00:00.000Z");
  const root = interviewRoot(db, at, "examiner");
  raiseObjection(db, recordNote(db, at, root.id).event_id, "drop the note", at);

  commitTriage(db, at, [], new Map(), { agentRegistered: () => false, resolvesToBuiltIn: () => false });

  const repair = listChildren(db, root.id).find((child) => child.type === "memory_repair")!;
  expect(repair.assignee).toBeNull();
  expect(registration(db, repair).payload).toMatchObject({
    assignee_not_copied: { name: "examiner", reason: "unknown agent: examiner" },
  });
});

it("cancelled の task の記憶の行への異議の memory_repair は、その後の祖先の cancel の cascade で倒れず todo のまま残る(ADR 0272 決定1・6)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-18T00:00:00.000Z");
  const ancestor = registerTask(db, { type: "work", title: "root", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const [child] = humanDecomposeTask(db, ancestor, { reason: "split", children: [{ title: "t", purpose: "p", completion_criteria: "c" }] }, at, undefined, "webui");
  const row = recordNote(db, at, child!.id).event_id;
  cancelTaskDirectly(db, child!, null, at, {}, "webui");
  raiseObjection(db, row, "drop the note", at);
  commitTriage(db, at);
  const repair = listChildren(db, child!.id).find((c) => c.type === "memory_repair")!;

  cancelTaskDirectly(db, getTask(db, ancestor.id)!, null, at, {}, "webui");

  expect(getTask(db, ancestor.id)!.status).toBe("cancelled");
  expect(getTask(db, repair.id)!.status).toBe("todo");
});
