import { afterEach, expect, it, vi } from "vitest";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { quarantineContainment } from "../src/containment.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import {
  cancelThroughHumanDoor,
  completeThroughHumanDoor,
  editThroughHumanDoor,
  quarantineChecks,
  registerThroughHumanDoor,
  submitAnswer,
} from "../src/human-verbs.js";
import { countTasksAwaitingLanding, createLanding, registerPrPromotionFailureQuestion } from "../src/landing.js";
import { quarantineAgent } from "../src/quarantine.js";
import {
  cancelTaskDirectly,
  getTask,
  listBoard,
  presentTask,
  recordPrOpened,
  registerTask,
  type Task,
} from "../src/tasks.js";
import { commitTriage, startTriage } from "../src/triage.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID } from "../src/worker-id.js";
import { quarantineWorkspace, UnknownWorkspaceError } from "../src/workspace.js";
import { afterCiRead, FakeClock, FakeDraftClient, FakeGitHubClient, fakeHead, unusedLanding } from "./fakes.js";
import {
  decomposeTaskViaWorker,
  defaultingTo,
  HUMAN_WEBUI,
  humanDecomposeTaskViaWebui,
  queuedForAutoMerge,
} from "./harness.js";

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
    { db, pollNow: () => {} },
    {
      type: "work",
      title: "ship the feature",
      purpose: "deliver the requested change",
      completion_criteria: "the change is available",
    },
    () => NOW,
    "webui",
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
    { db, pollNow: () => {}, agentRegistered: (name) => name === "deckhand" },
    {
      type: "work",
      title: "delegate the work",
      purpose: "use the right specialist",
      completion_criteria: "the specialist finishes",
      assignee: "not-a-real-agent",
    },
    () => NOW,
    "webui",
  );

  expect(result).toEqual({
    ok: false,
    failure: { kind: "invalid", error: "unknown agent: not-a-real-agent" },
  });
  expect(listBoard(db)).toEqual([]);
});

// ADR 0228 決定1: 組み込みは review 専用。判定は名前ではなく解決の結果を見る —— shadow している間、
// その名前は registry の普通の agent で work も受ける。人間の登録・子の登録・Edit は同じ1つの門を通る。
const BUILT_IN_FUGU = { agentRegistered: () => true, resolvesToBuiltIn: (name: string): boolean => name === "fugu" };
const SHADOWED_FUGU = { agentRegistered: () => true, resolvesToBuiltIn: () => false };
const BUILT_IN_REFUSAL = "agent fugu is the built-in agent, which runs reviews only";

function registerFor(lookup: typeof BUILT_IN_FUGU, type: "work" | "review", parentId?: string) {
  return registerThroughHumanDoor(
    { db, pollNow: () => {}, ...lookup },
    { type, title: "t", purpose: "p", completion_criteria: "c", assignee: "fugu", parent_id: parentId, decompose_reason: "split" },
    () => NOW,
    "webui",
  );
}

it("人間の登録 door は組み込みに解決される assignee の work を拒み、review は通す", async () => {
  db = openDb(":memory:");

  expect(await registerFor(BUILT_IN_FUGU, "work")).toEqual({ ok: false, failure: { kind: "invalid", error: BUILT_IN_REFUSAL } });
  expect(listBoard(db)).toEqual([]);
  expect(await registerFor(BUILT_IN_FUGU, "review")).toMatchObject({ ok: true });
});

it("人間の子の登録は組み込みに解決される assignee を拒む", async () => {
  db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);

  expect(await registerFor(BUILT_IN_FUGU, "work", parent.id)).toEqual({ ok: false, failure: { kind: "invalid", error: BUILT_IN_REFUSAL } });
});

it("人間の Edit は work の assignee を組み込みに解決される名前へ付け替えるのを拒み、review の付け替えは通す", () => {
  db = openDb(":memory:");
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const review = registerTask(db, { type: "review", title: "r", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const edit = (task: Task) => editThroughHumanDoor({ db, ...BUILT_IN_FUGU }, task.id, { assignee: "fugu" }, () => NOW, "webui");

  expect(edit(work)).toEqual({ ok: false, failure: { kind: "domain_error", error: BUILT_IN_REFUSAL } });
  expect(edit(review)).toMatchObject({ ok: true, value: { assignee: "fugu" } });
});

it("shadow している間は、その名前の work の登録・子の登録・Edit が通る", async () => {
  db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);

  expect(await registerFor(SHADOWED_FUGU, "work")).toMatchObject({ ok: true, task: { assignee: "fugu" } });
  expect(await registerFor(SHADOWED_FUGU, "work", parent.id)).toMatchObject({ ok: true, task: { assignee: "fugu" } });
  expect(
    editThroughHumanDoor({ db, ...SHADOWED_FUGU }, parent.id, { assignee: "fugu" }, () => NOW, "webui"),
  ).toMatchObject({ ok: true, value: { assignee: "fugu" } });
});

it("人間の登録 door は未知の workspace を GateFailure として返す", async () => {
  db = openDb(":memory:");

  const result = await registerThroughHumanDoor(
    {
      db,
      pollNow: () => {},
      resolveWorkspace: defaultingTo({ name: "product", path: "/workspaces/product" }),
    },
    {
      type: "work",
      title: "ship the feature",
      purpose: "deliver the requested change",
      completion_criteria: "the change is available",
      workspace: "not-a-real-workspace",
    },
    () => NOW,
    "webui",
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
      pollNow: () => {},
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
    "webui",
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
      pollNow: () => {},
      github,
      workspace: { name: "tidepool", path: "/workspaces/tidepool" },
    },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => NOW,
    "webui",
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
      pollNow: () => {},
      github,
      workspace: { name: "tidepool", path: "/workspaces/tidepool" },
    },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => currentNow,
    "webui",
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
      pollNow: () => {},
      github,
      workspace: { name: "tidepool", path: "/workspaces/tidepool" },
    },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => NOW,
    "webui",
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
      pollNow: () => {},
      github,
      draftClient,
      workspace: { name: "tidepool", path: "/workspaces/tidepool" },
    },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => NOW,
    "webui",
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
    db,
    exec: async () => JSON.stringify({ is_error: true, result: fullError }),
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const result = await registerThroughHumanDoor(
    {
      db,
      pollNow: () => {},
      github,
      draftClient,
      workspace: { name: "tidepool", path: "/workspaces/tidepool" },
    },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => NOW,
    "webui",
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
  const draftClient = new ClaudeDraftClient({ db, exec: async () => { throw new Error(fullError); } });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const result = await registerThroughHumanDoor(
    { db, pollNow: () => {}, github, draftClient, workspace: { name: "tidepool", path: "/workspaces/tidepool" } },
    { type: "work", github_issue_number: 189, workspace: "tidepool" },
    () => NOW,
    "webui",
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
    ...HUMAN_WEBUI,
  );

  const result = await registerThroughHumanDoor(
    { db, pollNow: () => {} },
    {
      type: "work",
      title: "child work",
      purpose: "extract the registration gate",
      completion_criteria: "the shared door is covered",
      parent_id: parent.id,
      decompose_reason: "split out the shared application seam",
    },
    () => NOW,
    "webui",
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
    { db, pollNow: () => {} },
    {
      type: "work",
      title: "orphan child",
      purpose: "split the work",
      completion_criteria: "the slice is complete",
      parent_id: "no-such-task",
      decompose_reason: "split the missing parent",
    },
    () => NOW,
    "webui",
  );

  expect(result).toEqual({
    ok: false,
    failure: { kind: "not_found", error: "parent task not found" },
  });
});

it("人間の登録 door は decompose reason を parent の存在より先に検査する", async () => {
  db = openDb(":memory:");

  const result = await registerThroughHumanDoor(
    { db, pollNow: () => {} },
    {
      type: "work",
      title: "orphan child",
      purpose: "split the work",
      completion_criteria: "the slice is complete",
      parent_id: "no-such-task",
    },
    () => NOW,
    "webui",
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
    ...HUMAN_WEBUI,
  );

  const result = await registerThroughHumanDoor(
    { db, pollNow: () => {} },
    {
      type: "work",
      parent_id: parent.id,
      decompose_reason: "split the issue-backed child",
      github_issue_number: 189,
      workspace: "tidepool",
    },
    () => NOW,
    "webui",
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
    ...HUMAN_WEBUI,
  );
  registerPrPromotionFailureQuestion(db, completedTask, "token expired", NOW);
  const question = onlyQuestion(db);
  let error: unknown;

  try {
    await submitAnswer(
      {
        db,
        pollNow: () => {},
        landing: {
          ...unusedLanding,
          async land() {
            return { kind: "failed", reason: "promotion_failed", error: "retry failed" };
          },
        },
      },
      question,
      ["retry"],
      undefined,
      () => NOW,
      "webui",
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
    ...HUMAN_WEBUI,
  );
  registerPrPromotionFailureQuestion(db, completedTask, "token expired", NOW);
  const question = onlyQuestion(db);

  const answered = await submitAnswer(
    { db, pollNow: () => {}, landing: unusedLanding },
    question,
    ["abandon promotion"],
    undefined,
    () => NOW,
    "webui",
  );
  const decision = listEvents(db, question.id).find((event) => event.kind === "decision_logged");

  expect({ status: answered.status, decision: decision?.payload }).toEqual({
    status: "done",
    decision: {
      kind: "decision_logged",
      line: `PR promotion abandoned for task ${completedTask.id} — this content stays on its task branch; a later change to the branch asks again`,
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
    ...HUMAN_WEBUI,
  );
  recordPrOpened(db, work, 42, fakeHead(42), "worker", NOW, { merge: "escalate" }, undefined, "worker");
  const question = onlyQuestion(db);
  const github = new FakeGitHubClient();
  const afterCi = new Date(NOW.getTime() + 60_000);
  let currentNow = NOW;
  const callOrder: string[] = [];
  const readPullRequest = github.readPullRequest.bind(github);
  const mergePullRequest = github.mergePullRequest.bind(github);
  github.readPullRequest = async (ref) => {
    callOrder.push("live CI");
    currentNow = afterCi;
    return readPullRequest(ref);
  };
  github.mergePullRequest = async (ref, head) => {
    callOrder.push("merge");
    return mergePullRequest(ref, head);
  };

  const answered = await submitAnswer(
    {
      db,
      pollNow: () => {},
      github,
      resolveWorkspace: (name) => ({ name: name!, path: `/workspaces/${name}` }),
      landing: unusedLanding,
    },
    question,
    ["merge"],
    undefined,
    () => currentNow,
    "webui",
  );

  expect({
    ciChecks: github.ciChecks,
    merged: github.merged,
    callOrder,
    status: answered.status,
    answerCreatedAt: listEvents(db, question.id).find((event) => event.kind === "question_answered")
      ?.created_at,
    mergedEvent: listEvents(db, question.id).find((event) => event.kind === "pr_merged")?.payload,
    mergedBy: listEvents(db, question.id).find((event) => event.kind === "pr_merged")?.worker_id,
  }).toEqual({
    ciChecks: [{ path: "/workspaces/product", number: 42 }],
    merged: [{ path: "/workspaces/product", number: 42 }],
    callOrder: ["live CI", "merge"],
    status: "done",
    answerCreatedAt: afterCi.toISOString(),
    mergedEvent: { kind: "pr_merged", pr_number: 42 },
    mergedBy: "human",
  });
});

// PR #42 を開いた escalate の work の merge question に、PR を開いてから minutesSincePrOpened 分後に「merge」と答える
function answerMerge(github: FakeGitHubClient, minutesSincePrOpened: number) {
  return openMergeQuestion(github).answerAt(minutesSincePrOpened);
}

/** PR #42 を開いた escalate の work と、その merge question に PR を開いてから何分後かに「merge」と答える手。 */
function openMergeQuestion(github: FakeGitHubClient) {
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
    ...HUMAN_WEBUI,
  );
  recordPrOpened(db, work, 42, fakeHead(42), "worker", NOW, { merge: "escalate" }, undefined, "worker");
  const answerAt = (minutesSincePrOpened: number) =>
    submitAnswer(
      {
        db,
        pollNow: () => {},
        github,
        resolveWorkspace: (name) => ({ name: name!, path: `/workspaces/${name}` }),
        landing: unusedLanding,
      },
      onlyQuestion(db),
      ["merge"],
      undefined,
      () => new Date(NOW.getTime() + minutesSincePrOpened * 60_000),
      "webui",
    );
  return { work, answerAt };
}

// ADR 0227 決定2・3: check 未報告の PR への「merge」回答は、盤面がその head を知ってから5分の猶予の間だけ拒まれる
function answerMergeOnUnreportedCi(minutesSincePrOpened: number) {
  const github = new FakeGitHubClient();
  github.scriptCiStatus("unreported");
  return { github, answer: answerMerge(github, minutesSincePrOpened) };
}

it("check 未報告の PR への merge 回答は、PR を開いてから5分の猶予の内なら拒否され question は開いたまま", async () => {
  const { github, answer } = answerMergeOnUnreportedCi(4);

  await expect(answer).rejects.toThrow(
    new DomainError(
      "CI checks on PR #42 have not reported yet — answer again once they report, or 5 minutes after the board first saw its current head",
    ),
  );
  expect(github.merged).toEqual([]);
  expect(onlyQuestion(db).status).toBe("todo");
});

it("猶予の5分を過ぎても check 未報告の PR への merge 回答は、merge まで進む", async () => {
  const { github, answer } = answerMergeOnUnreportedCi(5);

  await expect(answer).resolves.toMatchObject({ status: "done" });
  expect(github.merged).toEqual([{ path: "/workspaces/product", number: 42 }]);
});

// ADR 0231 決定4: escalate の PR はキューの行を持たない —— 盤面の外の head を回答が先に読めば、起点は回答が刻む
it("盤面の外の head が check 未報告なら、merge 回答は拒否の前に観測を1件だけ刻み、初めて読んでから5分後の回答は通る", async () => {
  const github = new FakeGitHubClient();
  github.scriptCiStatus("unreported");
  github.scriptHead(42, "outside-head");
  const { work, answerAt } = openMergeQuestion(github);
  const observed = () =>
    listEvents(db, work.id)
      .filter((e) => e.kind === "pr_head_observed")
      .map(({ worker_id, origin, payload }) => ({ worker_id, origin, payload }));

  // PR を開いてから6分 —— PR を開いた head の猶予は過ぎているが、この head は初めて読まれる
  await expect(answerAt(6)).rejects.toThrow("have not reported yet");
  await expect(answerAt(10)).rejects.toThrow("have not reported yet");
  expect(observed()).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_head_observed", pr_number: 42, sha: "outside-head" } },
  ]);
  expect(github.merged).toEqual([]);

  await expect(answerAt(11)).resolves.toMatchObject({ status: "done" });
  expect(github.mergedHeads).toEqual(["outside-head"]);
  expect(observed()).toHaveLength(1);
});

it("merge 回答は CI を読んだ head に固定して merge する", async () => {
  const github = new FakeGitHubClient();
  github.scriptHead(42, "ci-read-head");

  await expect(answerMerge(github, 0)).resolves.toMatchObject({ status: "done" });
  expect(github.mergedHeads).toEqual(["ci-read-head"]);
});

// ADR 0231 決定1: 回答を受理してから merge するまでに着いた push は、検査なしに入らない
it("CI を読んだ後に head が動いた PR への merge 回答は失敗し、merge されず question は開いたまま残る", async () => {
  const github = new FakeGitHubClient();
  github.scriptHead(42, "ci-read-head");
  afterCiRead(github, () => github.scriptHead(42, "pushed-after-ci-read"));

  const error = await answerMerge(github, 0).catch((err: unknown) => err);
  expect(error).toBeInstanceOf(DomainError);
  expect((error as Error).message).toContain("Head branch was modified");
  expect(github.merged).toEqual([]);
  expect(onlyQuestion(db).status).toBe("todo");
  expect(listEvents(db, onlyQuestion(db).id).some((event) => event.kind === "pr_merged")).toBe(false);
});

// ADR 0103 決定4 / ADR 0231 決定1: 失敗の文面で分けず、どの merge の失敗も DomainError に包んで question を開いたまま返す
it("PR への merge 回答で merge が別の理由で失敗しても DomainError になり、question は todo のまま残る", async () => {
  const github = new FakeGitHubClient();
  github.scriptMergeFailure(42, new Error("Pull request is not mergeable: merge conflict"));

  const error = await answerMerge(github, 0).catch((err: unknown) => err);
  expect(error).toBeInstanceOf(DomainError);
  expect((error as Error).message).toContain("Pull request is not mergeable: merge conflict");
  expect(github.merged).toEqual([]);
  expect(onlyQuestion(db).status).toBe("todo");
  expect(listEvents(db, onlyQuestion(db).id).some((event) => event.kind === "pr_merged")).toBe(false);
});

it("workspace quarantine の回答は tree が clean と確認できなければ DomainError になり、question は todo のまま残る", async () => {
  db = openDb(":memory:");
  quarantineWorkspace(db, "product", new Error("tree rule failed"), NOW);
  const question = onlyQuestion(db);
  let error: unknown;

  try {
    await submitAnswer(
      {
        db,
        pollNow: () => {},
        quarantineChecks: quarantineChecks({
          db,
          resolveWorkspace: (name) => ({ name: name!, path: "/workspace/does-not-exist" }),
        }),
        landing: unusedLanding,
      },
      question,
      ["repaired by hand"],
      undefined,
      () => NOW,
      "webui",
    );
  } catch (caught) {
    error = caught;
  }

  expect({ error, status: onlyQuestion(db).status }).toEqual({
    error: expect.any(DomainError),
    status: "todo",
  });
});

it("agent quarantine の回答は解除検査が拒むと DomainError になり、question は todo のまま残る", async () => {
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
    ...HUMAN_WEBUI,
  );
  quarantineAgent(db, "specialist", new Error("agent disappeared"), NOW);
  const question = onlyQuestion(db);
  let error: unknown;

  try {
    await submitAnswer(
      {
        db,
        pollNow: () => {},
        quarantineChecks: quarantineChecks({ db, agentRegistered: () => false }),
        landing: unusedLanding,
      },
      question,
      ["repaired by hand"],
      undefined,
      () => NOW,
      "webui",
    );
  } catch (caught) {
    error = caught;
  }

  expect({ error, status: onlyQuestion(db).status }).toEqual({
    error: expect.any(DomainError),
    status: "todo",
  });
});

it("組み込みに解決される名前は agent quarantine の解除で registry に「戻った」に数えず、work が残る限り解除しない(ADR 0228 決定4)", async () => {
  db = openDb(":memory:");
  registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c", assignee: "fugu" }, NOW, ...HUMAN_WEBUI);

  await expect(quarantineChecks({ db, ...BUILT_IN_FUGU }).agent!("fugu")).rejects.toThrow(
    "agent fugu is not back in the registry and still has unsettled tasks assigned",
  );
  await expect(quarantineChecks({ db, ...SHADOWED_FUGU }).agent!("fugu")).resolves.toBeUndefined();
});

// issue #1745: 組み込みを work として解決すると定義の不成立になるので、組み込みの判定を先に置く
it("組み込みに解決される名前は、定義の解決が通らないと答えられても、組み込み宛ての review だけが残るなら agent quarantine を解除する(ADR 0228 決定4)", async () => {
  db = openDb(":memory:");
  registerTask(db, { type: "review", title: "r", purpose: "p", completion_criteria: "c", assignee: "fugu" }, NOW, ...HUMAN_WEBUI);

  await expect(
    quarantineChecks({ db, ...BUILT_IN_FUGU, agentDefinitionFailure: () => "the built-in agent runs reviews only" }).agent!("fugu"),
  ).resolves.toBeUndefined();
});

// issue #1745 / ADR 0217・0224・0228 決定4: エントリがあっても pickup の解決に通らない定義は「戻った」に数えない
it("エントリはあるが定義が成立しない名前の agent quarantine の回答は、依存が残る限り定義の不成立と理由を名指して拒み、依存を付け替えれば受理する", async () => {
  db = openDb(":memory:");
  const work = registerTask(
    db,
    { type: "work", title: "w", purpose: "p", completion_criteria: "c", assignee: "specialist" },
    NOW,
    ...HUMAN_WEBUI,
  );
  quarantineAgent(db, "specialist", new Error('unknown tier "x"'), NOW);
  const answer = () =>
    submitAnswer(
      {
        db,
        pollNow: () => {},
        quarantineChecks: quarantineChecks({
          db,
          agentRegistered: () => true,
          agentDefinitionFailure: () => 'unknown tier "x"',
        }),
        landing: unusedLanding,
      },
      onlyQuestion(db),
      ["repaired by hand"],
      undefined,
      () => NOW,
      "webui",
    );

  await expect(answer()).rejects.toThrow(
    new DomainError(`agent specialist's definition still does not hold (unknown tier "x") and still has unsettled tasks assigned`),
  );
  expect(onlyQuestion(db).status).toBe("todo");
  editThroughHumanDoor({ db }, work.id, { assignee: "tako" }, () => NOW, "webui");
  await expect(answer()).resolves.toMatchObject({ status: "done" });
});

const PRODUCT = { name: "product", path: "/workspaces/product" };

// ADR 0229 決定4: 回答受理直前のバックストップは閉じた PR も観測する —— 回答の値に依らず、決定としては記録しない
it.each(["merge", "hold"])("盤面の外で閉じられた PR の merge question に「%s」と答えると、merge せず閉じた観測として決着する", async (answer) => {
  db = openDb(":memory:");
  const work = registerTask(
    db,
    { type: "work", title: "ship", purpose: "deliver the change", completion_criteria: "merged" },
    NOW,
    ...HUMAN_WEBUI,
  );
  recordPrOpened(db, work, 42, fakeHead(42), "worker", NOW, { merge: "escalate" }, undefined, "worker");
  const question = onlyQuestion(db);
  const github = new FakeGitHubClient();
  github.scriptClosedOutside(42);

  const answered = await submitAnswer(
    {
      db,
      pollNow: () => {},
      github,
      workspace: PRODUCT,
      landing: createLanding({ defaultAgentName: "tako", db, clock: new FakeClock(), workspace: PRODUCT, github }),
    },
    question,
    [answer],
    undefined,
    () => NOW,
    "webui",
  );

  expect({
    status: answered.status,
    merged: github.merged,
    kinds: listEvents(db, question.id).map((event) => event.kind),
    observed: listEvents(db, question.id).find((event) => event.kind === "pr_close_observed")?.payload,
  }).toEqual({
    status: "done",
    merged: [],
    kinds: expect.not.arrayContaining(["question_answered"]),
    observed: { kind: "pr_close_observed", pr_number: 42 },
  });
});

it("GitHub の無い盤面の agent quarantine の解除検査は、無人 merge キューの PR を観測せずに拒む", async () => {
  db = openDb(":memory:");
  const queued = queuedForAutoMerge(db, NOW, "specialist");

  await expect(
    quarantineChecks({
      db,
      agentRegistered: () => false,
      landing: createLanding({ defaultAgentName: "tako", db, clock: new FakeClock(), workspace: PRODUCT, github: null }),
    }).agent!("specialist"),
  ).rejects.toThrow(DomainError);
  expect(listEvents(db, queued.id).filter((event) => event.kind === "pr_merge_observed")).toEqual([]);
});

it("agent quarantine の解除検査は、盤面の外で merge 済みのキューの PR を盤面の名義で観測してキューから外し、そのうえで通す", async () => {
  db = openDb(":memory:");
  const queued = queuedForAutoMerge(db, NOW, "specialist");
  const github = new FakeGitHubClient();
  github.scriptMergedOutside(7);

  await quarantineChecks({
    db,
    agentRegistered: () => false,
    landing: createLanding({ defaultAgentName: "tako", db, clock: new FakeClock(), workspace: PRODUCT, github }),
  }).agent!("specialist");

  expect({
    awaiting: countTasksAwaitingLanding(db, "specialist"),
    observed: listEvents(db, queued.id).filter((event) => event.kind === "pr_merge_observed"),
  }).toEqual({
    awaiting: 0,
    observed: [
      expect.objectContaining({
        worker_id: BOARD_WORKER_ID,
        origin: "board",
        payload: { kind: "pr_merge_observed", pr_number: 7 },
      }),
    ],
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
        pollNow: () => {},
        quarantineChecks: quarantineChecks({
          db,
          containment: async () => ({ available: false, reason: "sandbox remains unavailable" }),
        }),
        landing: unusedLanding,
      },
      question,
      ["repaired by hand"],
      undefined,
      () => NOW,
      "webui",
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
    ...HUMAN_WEBUI,
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
    ...HUMAN_WEBUI,
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
    "webui",
  );
  startTriage(db, new Date(NOW.getTime() - 60_000));
  let polls = 0;

  const answered = await submitAnswer(
    { db, pollNow: () => polls++, landing: unusedLanding },
    question,
    ["left"],
    undefined,
    () => NOW,
    "webui",
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
    ...HUMAN_WEBUI,
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
    "webui",
  );
  let polls = 0;

  const answered = await submitAnswer(
    { db, pollNow: () => polls++, landing: unusedLanding },
    question,
    ["left"],
    undefined,
    () => NOW,
    "webui",
  );

  expect({ status: answered.status, polls }).toEqual({ status: "done", polls: 1 });
});

it.each([
  { answer: "approve", comment: undefined },
  { answer: "reject", comment: "not this child" },
])("承認 question への回答($answer)で held が外れた兄弟は todo に戻り、親が blocked のままでも即時 poll が撃たれる", async ({ answer, comment }) => {
  db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
  const [sibling] = decomposeTaskViaWorker(
    db,
    parent,
    {
      reason: "split",
      children: [
        { title: "plain child", purpose: "p", completion_criteria: "c" },
        { title: "risky child", purpose: "p", completion_criteria: "c", risk_flag: true },
      ],
    },
    "tako",
    NOW,
  );
  const before = presentTask(db, sibling!).status;
  let polls = 0;

  await submitAnswer({ db, pollNow: () => polls++, landing: unusedLanding }, onlyQuestion(db), [answer], comment, () => NOW, "webui");

  expect({ before, after: presentTask(db, sibling!).status, polls }).toEqual({ before: "held", after: "todo", polls: 1 });
});

function registerHumanTask(db: Db): Task {
  return registerTask(
    db,
    {
      type: "work",
      title: "sign the contract",
      purpose: "only a human can sign",
      completion_criteria: "the contract is signed",
      assignee: HUMAN_WORKER_ID,
    },
    NOW,
    ...HUMAN_WEBUI,
  );
}

function completeHumanTask(db: Db, taskId: string, outcome: string, pollNow: () => void = () => {}) {
  return completeThroughHumanDoor(
    { db, pollNow, landing: unusedLanding },
    taskId,
    { outcome },
    () => NOW,
    "webui",
  );
}

function completedEvents(db: Db, taskId: string) {
  return listEvents(db, taskId).filter((event) => event.kind === "task_completed");
}

it("人間の完了の扉は cancelled の task を拒否し、status も event も変えない", async () => {
  db = openDb(":memory:");
  const task = registerHumanTask(db);
  cancelTaskDirectly(db, task, null, NOW, {}, "webui");

  const result = await completeHumanTask(db, task.id, "signed");

  expect({
    kind: result.ok ? "ok" : result.failure.kind,
    status: getTask(db, task.id)?.status,
    completed: completedEvents(db, task.id).length,
  }).toEqual({ kind: "domain_error", status: "cancelled", completed: 0 });
});

it("人間の完了の扉は done の task の再完了を拒否し、handoff_doc を上書きしない", async () => {
  db = openDb(":memory:");
  const task = registerHumanTask(db);
  await completeHumanTask(db, task.id, "signed");
  const firstHandoff = getTask(db, task.id)?.handoff_doc;

  const result = await completeHumanTask(db, task.id, "signed again");

  expect({
    kind: result.ok ? "ok" : result.failure.kind,
    handoff: getTask(db, task.id)?.handoff_doc,
    completed: completedEvents(db, task.id).length,
  }).toEqual({ kind: "domain_error", handoff: firstHandoff, completed: 1 });
});

it("人間の完了の扉は todo の人間担当 task を完了できる", async () => {
  db = openDb(":memory:");
  const task = registerHumanTask(db);

  const result = await completeHumanTask(db, task.id, "signed");

  expect({ ok: result.ok, status: getTask(db, task.id)?.status }).toEqual({ ok: true, status: "done" });
});

function cancelHumanTask(db: Db, taskId: string, pollNow: () => void) {
  return cancelThroughHumanDoor({ db, pollNow, landing: unusedLanding }, taskId, undefined, () => NOW, "webui");
}

it("人間の完了の扉は親の無い人間担当 task の完了でも即時 poll を1回撃つ", async () => {
  db = openDb(":memory:");
  const task = registerHumanTask(db);
  let polls = 0;

  await completeHumanTask(db, task.id, "signed", () => polls++);

  expect(polls).toBe(1);
});

it.each<[string, (db: Db) => Task]>([
  ["親の無い task", registerHumanTask],
  [
    "未完の兄弟が残る子",
    (db) => {
      const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
      const [child] = humanDecomposeTaskViaWebui(db, parent, {
        reason: "split",
        children: [
          { title: "a", purpose: "p", completion_criteria: "c" },
          { title: "b", purpose: "p", completion_criteria: "c" },
        ],
      }, NOW);
      return child!;
    },
  ],
])("人間の cancel の扉は親が unblock しない cancel(%s)でも即時 poll を1回撃つ", async (_kind, setup) => {
  db = openDb(":memory:");
  const target = setup(db);
  let polls = 0;

  await cancelHumanTask(db, target.id, () => polls++);

  expect(polls).toBe(1);
});

it("人間の完了の扉と cancel の扉は拒否された呼び出しで poll を撃たない", async () => {
  db = openDb(":memory:");
  const task = registerHumanTask(db);
  cancelTaskDirectly(db, task, null, NOW, {}, "webui");
  let polls = 0;

  const results = [
    await completeHumanTask(db, task.id, "x", () => polls++),
    await cancelHumanTask(db, task.id, () => polls++),
    await cancelHumanTask(db, "no-such-task", () => polls++),
  ];

  expect({ ok: results.map((r) => r.ok), polls }).toEqual({ ok: [false, false, false], polls: 0 });
});
