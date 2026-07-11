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

  const res = await api(t.baseUrl, "POST", "/api/triage/commit");
  expect(res.status).toBe(200);
  // no clock advance: the commit itself hands the queue head to the worker
  expect(t.worker.started.map((x) => x.title)).toEqual(["queued work"]);
});

/** Park `parent` behind an escalated question: parent into the slot, a human
 *  places `other work` on top, then the escalation frees the slot. */
async function escalatedBoard(t: Tidepool) {
  const parent = await registerWork(t, "parent work");
  await t.clock.advance(HOUR); // parent into the slot
  const other = await registerWork(t, "other work");
  await api(t.baseUrl, "POST", `/api/tasks/${other.id}/move`, { after: null });
  const client = await mcpClient(t.baseUrl, parent.id);
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
  await api(t.baseUrl, "POST", "/api/triage/start");

  const res = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["left"],
  });
  expect(res.status).toBe(200);

  // the answer itself is durable at once — abandoning the session cannot lose it
  const answered = (await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json;
  expect(answered.status).toBe("done");
  expect(answered.question_answer).toEqual(["left"]);

  // but the unblocked parent has not jumped the queue yet
  const before = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(before.map((x: any) => x.title)).toEqual(["other work", "parent work", "which way?"]);

  await api(t.baseUrl, "POST", "/api/triage/commit");
  const after = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(after.map((x: any) => x.title)).toEqual(["parent work", "other work", "which way?"]);
  // the immediate poll hands the parent straight back to the worker
  expect(t.worker.started.map((x) => x.title)).toEqual(["parent work", "parent work"]);
});

/** Complete the slot task via MCP with a full work handoff. */
async function completeVia(t: Tidepool, taskId: string) {
  const client = await mcpClient(t.baseUrl, taskId);
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
  const client = await mcpClient(t.baseUrl, taskId);
  await client.callTool({ name: "log_decision", arguments: { line } });
  await client.close();
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  return log.entries.find((e: any) => e.payload.line === line);
}

it("an objection needs a direction comment and lands durably on the log entry", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "logged work");
  await t.clock.advance(HOUR); // into the slot so it can log a decision
  const entry = await loggedEntry(t, task.id, "went with plan B");
  await api(t.baseUrl, "POST", "/api/triage/start");

  // silence is approval — the only explicit action carries a direction
  const bare = await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: entry.id });
  expect(bare.status).toBe(400);

  const res = await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "plan B breaks the fixtures — go back to plan A",
  });
  expect(res.status).toBe(201);

  // durable at once, as an annotation on the entry's task
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  const objections = events.filter((e: any) => e.kind === "objection_raised");
  expect(objections).toHaveLength(1);
  expect(objections[0].worker_id).toBe("human");
  expect(objections[0].payload.entry_id).toBe(entry.id);
  expect(objections[0].payload.comment).toBe("plan B breaks the fixtures — go back to plan A");
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

it("an abandoned session auto-commits after the timeout", async () => {
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

it("scratchpad lines are shared during triage and triaged at commit", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/triage/start");
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

  // the pad is shared across the triage screens: every screen reads it back
  const pad = (await api(t.baseUrl, "GET", "/api/triage")).json.scratchpad;
  expect(pad.map((x: any) => x.line)).toEqual(lines);

  await api(t.baseUrl, "POST", "/api/triage/commit", {
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

it("undisposed scratchpad lines survive an auto-commit into the next session", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/triage/start");
  const line = (await api(t.baseUrl, "POST", "/api/triage/scratchpad", { line: "this again" }))
    .json;
  await t.clock.advance(TRIAGE_TIMEOUT); // walk away — auto-commit carries no dispositions
  expect((await api(t.baseUrl, "GET", "/api/triage")).json.session).toBe(null);

  // the jotted irritation is not lost: the next session adopts it
  await api(t.baseUrl, "POST", "/api/triage/start");
  const pad = (await api(t.baseUrl, "GET", "/api/triage")).json.scratchpad;
  expect(pad.map((x: any) => x.line)).toEqual(["this again"]);

  // a dispositioned line is consumed for good — discard it and it stays gone
  await api(t.baseUrl, "POST", "/api/triage/commit", {
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
  await api(t.baseUrl, "POST", "/api/triage/start");

  const res = await api(t.baseUrl, "POST", "/api/triage/displayed", {
    entry_ids: [entry.id],
  });
  expect(res.status).toBe(201);

  // the denominator of the objection rate: an unread entry is neither
  // approved nor rejected — only a displayed one counts
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  const displayed = events.filter((e: any) => e.kind === "log_entry_displayed");
  expect(displayed).toHaveLength(1);
  expect(displayed[0].payload.entry_id).toBe(entry.id);
  expect(displayed[0].worker_id).toBe("human");
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
  await api(t.baseUrl, "POST", "/api/triage/commit");

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
  await api(t.baseUrl, "POST", "/api/triage/commit");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const selfReview = board.find(
    (x: any) => x.type === "review" && x.parent_id === a.id && x.assignee === "fake-worker",
  );
  expect(selfReview).toBeDefined();
  expect(selfReview.purpose).toContain("the hack corrupts state — do it properly");
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
  await api(t.baseUrl, "POST", "/api/triage/commit");

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
  await api(t.baseUrl, "POST", "/api/triage/commit");

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
  await api(t.baseUrl, "POST", "/api/triage/commit");

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
  await api(t.baseUrl, "POST", "/api/triage/commit");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const auditorReview = board.find(
    (x: any) => x.type === "review" && x.parent_id === a.id && x.title.startsWith("rca (auditor):"),
  );
  expect(auditorReview).toBeDefined();
  // unset, not baked — resolved fresh at pickup/attribution the way an unset
  // assignee always is (ADR 0011), not pinned to whichever name was live at
  // commit time
  expect(auditorReview.assignee).toBeNull();
});
