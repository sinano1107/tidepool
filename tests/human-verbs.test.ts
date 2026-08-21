import { afterEach, expect, it, vi } from "vitest";
import { quarantineAgent } from "../src/agent.js";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { quarantineContainment } from "../src/containment.js";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { registerThroughHumanDoor, submitAnswer } from "../src/human-verbs.js";
import {
  BOARD_WORKER_ID,
  getTask,
  listBoard,
  registerMergeQuestion,
  registerPrPromotionFailureQuestion,
  registerTask,
  type Task,
} from "../src/tasks.js";
import { commitTriage, startTriage } from "../src/triage.js";
import { quarantineWorkspace, UnknownWorkspaceError } from "../src/workspace.js";
import { FakeDraftClient, FakeGitHubClient } from "./fakes.js";

const NOW = new Date("2026-08-06T00:00:00.000Z");

let db: Db;
afterEach(() => {
  db?.close();
  vi.restoreAllMocks();
});

function onlyQuestion(db: Db): Task {
  const questions = listBoard(db).filter((task) => task.type === "question");
  if (questions.length !== 1) {
    throw new Error(`expected one question, found ${questions.length}`);
  }
  const question = getTask(db, questions[0]!.id);
  if (!question) throw new Error("question disappeared from the board");
  return question;
}

it("人間の登録 door は通常タスクを登録して返す", async () => {
  db = openDb(":memory:");

  const result = await registerThroughHumanDoor(
    { db },
    {
      type: "work",
      title: "ship the feature",
      purpose: "deliver the requested change",
      completion_criteria: "the change is available",
    },
    () => NOW,
  );

  expect(result).toMatchObject({
    ok: true,
    task: {
      type: "work",
      title: "ship the feature",
      status: "todo",
    },
  });
});

it("人間の登録 door は未知の assignee を GateFailure として返す", async () => {
  db = openDb(":memory:");

  const result = await registerThroughHumanDoor(
    { db, agentRegistered: (name) => name === "deckhand" },
    {
      type: "work",
      title: "delegate the work",
      purpose: "use the right specialist",
      completion_criteria: "the specialist finishes",
      assignee: "not-a-real-agent",
    },
    () => NOW,
  );

  expect(result).toEqual({
    ok: false,
    failure: { kind: "invalid", error: "unknown agent: not-a-real-agent" },
  });
  expect(listBoard(db)).toEqual([]);
});

it("人間の登録 door は未知の workspace を GateFailure として返す", async () => {
  db = openDb(":memory:");

  const result = await registerThroughHumanDoor(
    {
      db,
      resolveWorkspace: (name) => {
        if (name !== "product") throw new UnknownWorkspaceError(name ?? "product");
        return { name, path: "/workspaces/product" };
      },
    },
    {
      type: "work",
      title: "ship the feature",
      purpose: "deliver the requested change",
      completion_criteria: "the change is available",
      workspace: "not-a-real-workspace",
    },
    () => NOW,
  );

  expect(result).toEqual({
    ok: false,
    failure: { kind: "invalid", error: "unknown workspace: not-a-real-workspace" },
  });
  expect(listBoard(db)).toEqual([]);
});

it("人間の登録 door は workspace を assignee より先に検査する", async () => {
  db = openDb(":memory:");

  const result = await registerThroughHumanDoor(
    {
      db,
      agentRegistered: () => false,
      resolveWorkspace: (name) => {
        throw new UnknownWorkspaceError(name ?? "default");
      },
    },
    {
      type: "work",
      title: "invalid registration",
      purpose: "preserve gate ordering",
      completion_criteria: "the first failure is unchanged",
      workspace: "unknown-workspace",
      assignee: "unknown-agent",
    },
    () => NOW,
  );

  expect(result).toEqual({
    ok: false,
    failure: { kind: "invalid", error: "unknown workspace: unknown-workspace" },
  });
});

it("人間の登録 door は issue-backed task の生存を確認してから登録する", async () => {
  db = openDb(":memory:");
  const github = new FakeGitHubClient();
  github.scriptIssue(189, {
    title: "extract the registration gate",
    body: "keep behavior unchanged",
    comments: [],
  });

  const result = await registerThroughHumanDoor(
    {
      db,
      github,
      workspace: { name: "tidepool", path: "/workspaces/tidepool" },
    },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => NOW,
  );

  expect({ result, issueFetches: github.issueFetches }).toMatchObject({
    result: { ok: true, task: { github_issue_number: 189, workspace: "tidepool" } },
    issueFetches: [{ path: "/workspaces/tidepool", number: 189 }],
  });
});

it("人間の登録 door は外部検査後の時刻で task を登録する", async () => {
  db = openDb(":memory:");
  const github = new FakeGitHubClient();
  github.scriptIssue(189, { title: "issue", body: "body", comments: [] });
  const afterInspection = new Date(NOW.getTime() + 60_000);
  let currentNow = NOW;
  const getIssue = github.getIssue.bind(github);
  github.getIssue = async (ref) => {
    currentNow = afterInspection;
    return getIssue(ref);
  };

  const result = await registerThroughHumanDoor(
    {
      db,
      github,
      workspace: { name: "tidepool", path: "/workspaces/tidepool" },
    },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => currentNow,
  );

  expect(result).toMatchObject({
    ok: true,
    task: { created_at: afterInspection.toISOString() },
  });
});

it("人間の登録 door は一時的な issue 取得失敗を retryable な GateFailure として返す", async () => {
  db = openDb(":memory:");
  const github = new FakeGitHubClient();
  github.scriptIssueFailure(new Error("network is down"));

  const result = await registerThroughHumanDoor(
    {
      db,
      github,
      workspace: { name: "tidepool", path: "/workspaces/tidepool" },
    },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => NOW,
  );

  expect(result).toEqual({
    ok: false,
    failure: { kind: "issue_unavailable", error: "could not fetch the referenced issue" },
  });
  expect(listBoard(db)).toEqual([]);
});

it("人間の登録 door は LLM 検査の不合格をサジェスト付き GateFailure として返す", async () => {
  db = openDb(":memory:");
  const github = new FakeGitHubClient();
  github.scriptIssue(189, {
    title: "ambiguous note",
    body: "do something",
    comments: [],
  });
  const draftClient = new FakeDraftClient();
  draftClient.scriptInspection({
    ok: false,
    missing: "completion criteria cannot be derived",
    suggested_comment: "## Completion criteria\n- the registration gate is shared",
  });

  const result = await registerThroughHumanDoor(
    {
      db,
      github,
      draftClient,
      workspace: { name: "tidepool", path: "/workspaces/tidepool" },
    },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => NOW,
  );

  expect(result).toEqual({
    ok: false,
    failure: {
      kind: "issue_rejected",
      error: "the referenced issue fails the registration gate",
      missing: "completion criteria cannot be derived",
      suggested_comment: "## Completion criteria\n- the registration gate is shared",
    },
  });
  expect(listBoard(db)).toEqual([]);
});

it("人間の登録 door は envelope の完全な LLM 診断をログに残し、切り詰めて返す(issue #306)", async () => {
  db = openDb(":memory:");
  const github = new FakeGitHubClient();
  github.scriptIssue(189, { title: "issue", body: "body", comments: [] });
  const fullError = `Failed to authenticate: ${"x".repeat(220)}`;
  const draftClient = new ClaudeDraftClient({
    exec: async () => JSON.stringify({ is_error: true, result: fullError }),
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const result = await registerThroughHumanDoor(
    {
      db,
      github,
      draftClient,
      workspace: { name: "tidepool", path: "/workspaces/tidepool" },
    },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => NOW,
  );

  expect(result).toEqual({
    ok: false,
    failure: {
      kind: "inspection_unavailable",
      error: `${fullError.slice(0, 200)}… See server logs for full details.`,
    },
  });
  expect(warn).toHaveBeenCalledWith("[issue inspection] LLM inspection failed", fullError);
  expect(listBoard(db)).toEqual([]);
});

it("人間の登録 door は exec が投げた完全な LLM 診断もログに残し、切り詰めて返す(issue #306)", async () => {
  db = openDb(":memory:");
  const github = new FakeGitHubClient();
  github.scriptIssue(189, { title: "issue", body: "body", comments: [] });
  const fullError = "Failed to authenticate: OAuth session expired and could not be refreshed";
  const draftClient = new ClaudeDraftClient({ exec: async () => { throw new Error(fullError); } });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const result = await registerThroughHumanDoor(
    { db, github, draftClient, workspace: { name: "tidepool", path: "/workspaces/tidepool" } },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => NOW,
  );

  expect(result).toEqual({
    ok: false,
    failure: { kind: "inspection_unavailable", error: `${fullError} See server logs for full details.` },
  });
  expect(warn).toHaveBeenCalledWith("[issue inspection] LLM inspection failed", fullError);
});

it("人間の登録 door は work child を人間 decompose として登録する", async () => {
  db = openDb(":memory:");
  const parent = registerTask(
    db,
    {
      type: "work",
      title: "parent work",
      purpose: "deliver the whole change",
      completion_criteria: "all slices are integrated",
    },
    NOW,
  );

  const result = await registerThroughHumanDoor(
    { db },
    {
      type: "work",
      title: "child work",
      purpose: "extract the registration gate",
      completion_criteria: "the shared door is covered",
      parent_id: parent.id,
      decompose_reason: "split out the shared application seam",
    },
    () => NOW,
  );

  expect(result).toMatchObject({
    ok: true,
    task: {
      title: "child work",
      parent_id: parent.id,
      based_on_decision: expect.any(Number),
    },
  });
  expect(listBoard(db).find((task) => task.id === parent.id)?.status).toBe("blocked");
});

it("人間の登録 door は存在しない decompose 親を not_found として返す", async () => {
  db = openDb(":memory:");

  const result = await registerThroughHumanDoor(
    { db },
    {
      type: "work",
      title: "orphan child",
      purpose: "split the work",
      completion_criteria: "the slice is complete",
      parent_id: "no-such-task",
      decompose_reason: "split the missing parent",
    },
    () => NOW,
  );

  expect(result).toEqual({
    ok: false,
    failure: { kind: "not_found", error: "parent task not found" },
  });
});

it("人間の登録 door は decompose reason を parent の存在より先に検査する", async () => {
  db = openDb(":memory:");

  const result = await registerThroughHumanDoor(
    { db },
    {
      type: "work",
      title: "orphan child",
      purpose: "split the work",
      completion_criteria: "the slice is complete",
      parent_id: "no-such-task",
    },
    () => NOW,
  );

  expect(result).toEqual({
    ok: false,
    failure: { kind: "invalid", error: "a decomposition requires a reason" },
  });
});

it("人間の登録 door は issue-backed decompose child を登録しない", async () => {
  db = openDb(":memory:");
  const parent = registerTask(
    db,
    {
      type: "work",
      title: "parent work",
      purpose: "deliver the whole change",
      completion_criteria: "all slices are integrated",
    },
    NOW,
  );

  const result = await registerThroughHumanDoor(
    { db },
    {
      type: "work",
      parent_id: parent.id,
      decompose_reason: "split the issue-backed child",
      github_issue_number: 189,
      workspace: "tidepool",
    },
    () => NOW,
  );

  expect(result).toEqual({
    ok: false,
    failure: { kind: "invalid", error: "a child task cannot be issue-backed" },
  });
  expect(listBoard(db).filter((task) => task.parent_id === parent.id)).toEqual([]);
});

it("PR promotion の retry が失敗したら question を未決着のまま残す", async () => {
  db = openDb(":memory:");
  const completedTask = registerTask(
    db,
    {
      type: "work",
      title: "ship the feature",
      purpose: "deliver the requested change",
      completion_criteria: "the change is available as a PR",
    },
    NOW,
  );
  registerPrPromotionFailureQuestion(db, completedTask, "token expired", NOW);
  const question = onlyQuestion(db);
  let error: unknown;

  try {
    await submitAnswer(
      {
        db,
        onQueueHeadChanged: () => {},
        retryPrPromotion: async () => {
          throw new Error("retry failed");
        },
      },
      question,
      ["retry"],
      undefined,
      () => NOW,
    );
  } catch (caught) {
    error = caught;
  }

  const unchanged = onlyQuestion(db);
  expect({ error: String(error), status: unchanged.status, answer: unchanged.question_answer }).toEqual({
    error: "Error: retry failed",
    status: "todo",
    answer: null,
  });
});

it("PR promotion の abandon を decision log に残す", async () => {
  db = openDb(":memory:");
  const completedTask = registerTask(
    db,
    {
      type: "work",
      title: "ship the feature",
      purpose: "deliver the requested change",
      completion_criteria: "the change is available as a PR",
    },
    NOW,
  );
  registerPrPromotionFailureQuestion(db, completedTask, "token expired", NOW);
  const question = onlyQuestion(db);

  const answered = await submitAnswer(
    { db, onQueueHeadChanged: () => {} },
    question,
    ["abandon promotion"],
    undefined,
    () => NOW,
  );
  const decision = listEvents(db, question.id).find((event) => event.kind === "decision_logged");

  expect({ status: answered.status, decision: decision?.payload }).toEqual({
    status: "done",
    decision: {
      kind: "decision_logged",
      line: `PR promotion abandoned for task ${completedTask.id} — the work stays on its task branch, no PR`,
    },
  });
});

it("merge 回答は question の workspace で live CI を確認してから実 merge する", async () => {
  db = openDb(":memory:");
  const work = registerTask(
    db,
    {
      type: "work",
      title: "ship the feature",
      purpose: "deliver the requested change",
      completion_criteria: "the change is merged",
      workspace: "product",
    },
    NOW,
  );
  // 本番では recordPrOpened が pr_number を書いてから question を立てる(#403 の回答時検証はこの行で着地タスクを引く)
  db.prepare("UPDATE tasks SET pr_number = 42 WHERE id = ?").run(work.id);
  registerMergeQuestion(db, work, 42, "decide whether to merge", "merge", BOARD_WORKER_ID, NOW);
  const question = onlyQuestion(db);
  const github = new FakeGitHubClient();
  const afterCi = new Date(NOW.getTime() + 60_000);
  let currentNow = NOW;
  const callOrder: string[] = [];
  const getCiStatus = github.getCiStatus.bind(github);
  const mergePullRequest = github.mergePullRequest.bind(github);
  github.getCiStatus = async (ref) => {
    callOrder.push("live CI");
    currentNow = afterCi;
    return getCiStatus(ref);
  };
  github.mergePullRequest = async (ref) => {
    callOrder.push("merge");
    return mergePullRequest(ref);
  };

  const answered = await submitAnswer(
    {
      db,
      onQueueHeadChanged: () => {},
      github,
      resolveWorkspace: (name) => ({ name: name!, path: `/workspaces/${name}` }),
    },
    question,
    ["merge"],
    undefined,
    () => currentNow,
  );

  expect({
    ciChecks: github.ciChecks,
    merged: github.merged,
    callOrder,
    status: answered.status,
    answerCreatedAt: listEvents(db, question.id).find((event) => event.kind === "question_answered")
      ?.created_at,
    mergedEvent: listEvents(db, question.id).find((event) => event.kind === "pr_merged")?.payload,
  }).toEqual({
    ciChecks: [{ path: "/workspaces/product", number: 42 }],
    merged: [{ path: "/workspaces/product", number: 42 }],
    callOrder: ["live CI", "merge"],
    status: "done",
    answerCreatedAt: afterCi.toISOString(),
    mergedEvent: { kind: "pr_merged", pr_number: 42 },
  });
});

it("workspace quarantine の回答は tree が clean と確認できるまで拒否する", async () => {
  db = openDb(":memory:");
  quarantineWorkspace(db, "product", new Error("tree rule failed"), NOW);
  const question = onlyQuestion(db);
  let error: unknown;

  try {
    await submitAnswer(
      {
        db,
        onQueueHeadChanged: () => {},
        resolveWorkspace: (name) => ({ name: name!, path: "/workspace/does-not-exist" }),
      },
      question,
      ["repaired by hand"],
      undefined,
      () => NOW,
    );
  } catch (caught) {
    error = caught;
  }

  expect({ error: String(error), status: onlyQuestion(db).status }).toEqual({
    error: expect.stringContaining("workspace product is not a usable git repository"),
    status: "todo",
  });
});

it("agent quarantine の回答は registry 復帰か依存 task の解消まで拒否する", async () => {
  db = openDb(":memory:");
  registerTask(
    db,
    {
      type: "work",
      title: "pending specialist work",
      purpose: "use the specialist",
      completion_criteria: "the specialist finishes",
      assignee: "specialist",
    },
    NOW,
  );
  quarantineAgent(db, "specialist", new Error("agent disappeared"), NOW);
  const question = onlyQuestion(db);
  let error: unknown;

  try {
    await submitAnswer(
      {
        db,
        onQueueHeadChanged: () => {},
        agentRegistered: () => false,
      },
      question,
      ["repaired by hand"],
      undefined,
      () => NOW,
    );
  } catch (caught) {
    error = caught;
  }

  expect({ error: String(error), status: onlyQuestion(db).status }).toEqual({
    error: "Error: agent specialist is not back in the registry and still has pending tasks assigned",
    status: "todo",
  });
});

it("containment quarantine の回答は host 能力の再検査が通るまで拒否する", async () => {
  db = openDb(":memory:");
  quarantineContainment(db, "sandbox unavailable", NOW);
  const question = onlyQuestion(db);
  let error: unknown;

  try {
    await submitAnswer(
      {
        db,
        onQueueHeadChanged: () => {},
        containment: async () => ({ available: false, reason: "sandbox remains unavailable" }),
      },
      question,
      ["repaired by hand"],
      undefined,
      () => NOW,
    );
  } catch (caught) {
    error = caught;
  }

  expect({ error: String(error), status: onlyQuestion(db).status }).toEqual({
    error: "Error: worker containment is still not established: sandbox remains unavailable",
    status: "todo",
  });
});

it("triage 中の回答は親の先頭復帰を staging し immediate poll を保留する", async () => {
  db = openDb(":memory:");
  registerTask(
    db,
    {
      type: "work",
      title: "other work",
      purpose: "keep the current queue head",
      completion_criteria: "the other work is done",
    },
    NOW,
  );
  const parent = registerTask(
    db,
    {
      type: "work",
      title: "parent work",
      purpose: "choose a direction",
      completion_criteria: "the chosen direction is implemented",
    },
    NOW,
  );
  const question = registerTask(
    db,
    {
      type: "question",
      title: "which way?",
      purpose: "two viable directions remain",
      completion_criteria: "a human answer is recorded",
      parent_id: parent.id,
      question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
    },
    NOW,
    "worker",
  );
  startTriage(db, new Date(NOW.getTime() - 60_000));
  let polls = 0;

  const answered = await submitAnswer(
    { db, onQueueHeadChanged: () => polls++ },
    question,
    ["left"],
    undefined,
    () => NOW,
  );
  const beforeCommit = listBoard(db).map((task) => task.title);
  commitTriage(db, NOW);
  const afterCommit = listBoard(db).map((task) => task.title);

  expect({ status: answered.status, beforeCommit, afterCommit, polls }).toEqual({
    status: "done",
    beforeCommit: ["other work", "parent work", "which way?"],
    afterCommit: ["parent work", "other work", "which way?"],
    polls: 0,
  });
});

it("回答で親が unblock したら queue head の再評価を即時通知する", async () => {
  db = openDb(":memory:");
  const parent = registerTask(
    db,
    {
      type: "work",
      title: "parent work",
      purpose: "choose a direction",
      completion_criteria: "the chosen direction is implemented",
    },
    NOW,
  );
  const question = registerTask(
    db,
    {
      type: "question",
      title: "which way?",
      purpose: "two viable directions remain",
      completion_criteria: "a human answer is recorded",
      parent_id: parent.id,
      question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
    },
    NOW,
    "worker",
  );
  let polls = 0;

  const answered = await submitAnswer(
    { db, onQueueHeadChanged: () => polls++ },
    question,
    ["left"],
    undefined,
    () => NOW,
  );

  expect({ status: answered.status, polls }).toEqual({ status: "done", polls: 1 });
});
