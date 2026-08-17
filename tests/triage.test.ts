import { afterEach, expect, it } from "vitest";
import { TRIAGE_TIMEOUT } from "../src/triage.js";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("starting a triage session pauses task pickup", async () => {
  t = await bootTidepool();
  await registerWork(t, "queued work");
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
  await registerWork(t, "queued work");
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

it("セッションが開いていない commit は成功し、即時 poll を発火しない", async () => {
  t = await bootTidepool();
  await registerWork(t, "queued work");

  const res = await api(t.baseUrl, "POST", "/api/triage/close");

  expect(res).toMatchObject({
    status: 200,
    json: { outcome: "no_open_session", closed_at: null },
  });
  expect(t.worker.started).toEqual([]);
});

/** Park `parent` behind an escalated question: parent into the slot, a human
 *  places `other work` on top, then the escalation frees the slot. */
async function escalatedBoard(t: Tidepool) {
  const parent = await registerWork(t, "parent work");
  await t.clock.advance(HOUR); // parent into the slot
  const other = await registerWork(t, "other work");
  await api(t.baseUrl, "POST", `/api/tasks/${other.id}/move`, { after: null });
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

/** Put one decision line in the log for `title` and return its entry. */
async function loggedEntry(t: Tidepool, taskId: string, line: string) {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  await client.callTool({ name: "log_decision", arguments: { line } });
  await client.close();
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  return log.entries.find((e: any) => e.payload.line === line);
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
  expect(humanEntry).toMatchObject({ worker_id: "human", unread: false });
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
  expect(objections[0].worker_id).toBe("human");
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
  await registerWork(t, "natural poll を待つ work");

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
  await registerWork(t, "queued work");
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
  await registerWork(t, "live queued work");

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

it("セッション不在の commit でも scratchpad の振り分けを適用する", async () => {
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
    json: { outcome: "no_open_session", closed_at: null },
  });
  expect(board.some((task: any) => task.title === "独立した振り分け")).toBe(true);
  expect(t.worker.started).toEqual([]);
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

  await api(t.baseUrl, "POST", "/api/triage/close", {
    scratchpad: [
      { id: ids[0], disposition: "meta_review" },
      { id: ids[1], disposition: "task" },
      { id: ids[2], disposition: "discard" },
    ],
  });

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const metaReview = board.find((x: any) => x.title === "the agent keeps renaming things");
  expect(metaReview.type).toBe("review");
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
  expect(displayed[0].worker_id).toBe("human");
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
  expect(selfReview.purpose).toBe(
    'objections raised against decisions fake-worker made on "対の修理":\n\n' +
      "> 先に古い判断\n" +
      "- 古い判断を見直す\n" +
      "\n" +
      "> 後の判断\n" +
      "- 後の判断を見直す",
  );
  expect(auditorReview.purpose).toBe(
    'objections raised against decisions of "対の修理":\n\n' +
      "> 先に古い判断\n" +
      "- 古い判断を見直す\n" +
      "\n" +
      "> 後の判断\n" +
      "- 後の判断を見直す",
  );
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
  expect(selfReview.purpose).toBe(
    'objections raised against decisions fake-worker made on "二重の異議":\n\n' + expectedPair,
  );
  const auditorReview = board.find((entry: any) => entry.title === "rca (auditor): 二重の異議");
  expect(auditorReview.purpose).toBe(
    'objections raised against decisions of "二重の異議":\n\n' + expectedPair,
  );
});

it("result が null の完了エントリへの異議には no outcome recorded を差し込む", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "完了報告なし", undefined, false, "human");
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

it("an objection against a human-completed task's log entry generates no self RCA review (CONTEXT.md's Review: 最終監査者に自分を監査させる輪は作らない)", async () => {
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
  expect(humanEntry.worker_id).toBe("human");

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
  // the objected entry (CONTEXT.md's Review: 独立レビュー)
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
