import { afterEach, expect, it } from "vitest";
import { quarantineAgent } from "../src/agent.js";
import { quarantineContainment } from "../src/containment.js";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { submitAnswer } from "../src/human-verbs.js";
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
import { quarantineWorkspace } from "../src/workspace.js";
import { FakeGitHubClient } from "./fakes.js";

const NOW = new Date("2026-08-06T00:00:00.000Z");

let db: Db;
afterEach(() => db?.close());

function onlyQuestion(db: Db): Task {
  const questions = listBoard(db).filter((task) => task.type === "question");
  if (questions.length !== 1) {
    throw new Error(`expected one question, found ${questions.length}`);
  }
  const question = getTask(db, questions[0]!.id);
  if (!question) throw new Error("question disappeared from the board");
  return question;
}

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
