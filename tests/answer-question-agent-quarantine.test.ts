import { describe, expect, it, vi } from "vitest";
import { agentNeedsHuman } from "../src/agent.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { submitAnswer } from "../src/human-verbs.js";
import { createLanding } from "../src/landing.js";
import { type AuthorityProfile, UnknownAgentError } from "../src/registry.js";
import { completeTask, getTask, listBoard, registerTask } from "../src/tasks.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import { quarantineWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, FakeGitHubClient } from "./fakes.js";
import {
  answerQuestionViaWebui,
  commitWork,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  makeRemoteBackedWorkspace,
  quarantineQuestion,
  settleReviews,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

describe("agent の quarantine(ADR 0012 / issue #36: workspace 版の agent 名一般化)", () => {
  it("agent の quarantine 付きの question は1択(workspace 版と同じ緩和)で登録できる", () => {
    const db = openDb(":memory:");
    registerTask(
      db,
      {
        type: "question",
        title: "agent navigator needs human attention",
        purpose: "unknown agent name at pickup",
        completion_criteria: "the agent is repaired by hand",
        question: [
          {
            title: "agent navigator needs human attention",
            options: ["repaired by hand"],
            recommendation: "repaired by hand",
          },
        ],
        quarantine: { kind: "agent", value: "navigator" },
      },
      new Date(0),
      BOARD_WORKER_ID,
      "webui",
    );
    expect(quarantineQuestion(db, "agent", "navigator")).toBeDefined();
  });

  it("quarantine の付かない question は通常どおり2択以上を要求する", () => {
    const db = openDb(":memory:");
    expect(() =>
      registerTask(
        db,
        {
          type: "question",
          title: "plain question",
          purpose: "p",
          completion_criteria: "c",
          question: [{ title: "plain question", options: ["only"], recommendation: "only" }],
        },
        new Date(0),
        ...HUMAN_WEBUI,
      ),
    ).toThrow(DomainError);
  });

  it("agent の quarantine の question に回答すると agent 名の quarantine が解ける", () => {
    const db = openDb(":memory:");
    const question = registerTask(
      db,
      {
        type: "question",
        title: "agent navigator needs human attention",
        purpose: "unknown agent name at pickup",
        completion_criteria: "the agent is repaired by hand",
        question: [
          {
            title: "agent navigator needs human attention",
            options: ["repaired by hand"],
            recommendation: "repaired by hand",
          },
        ],
        quarantine: { kind: "agent", value: "navigator" },
      },
      new Date(0),
      BOARD_WORKER_ID,
      "webui",
    );

    const answered = answerQuestionViaWebui(db, question, ["repaired by hand"], new Date(1));

    expect(answered.status).toBe("done");
    expect(agentNeedsHuman(db, "navigator")).toBe(false);
  });
});

// ADR 0241 決定6: quarantine が抱えている根への retry は、その quarantine を名指して拒まれる
let authority: () => AuthorityProfile | undefined;
describe("quarantine が抱えている根への PR 昇格失敗 question の retry", () => {
  it.each([
    [
      "workspace",
      (board: Db, workspace: WorkspaceConfig, now: Date) =>
        quarantineWorkspace(board, workspace.name, new Error("repair the checkout"), now),
      (workspace: WorkspaceConfig) =>
        `workspace "${workspace.name}" is quarantined and needs human attention before landing; answer its quarantine question`,
    ],
    [
      "agent",
      () => {
        authority = () => {
          throw new UnknownAgentError("tako");
        };
      },
      () =>
        'agent "tako" is quarantined: its authority profile cannot be resolved for landing; repair the registry and answer its quarantine question',
    ],
  ] as const)("%s の quarantine が抱えていれば、retry はその quarantine を名指して拒まれ、question は開いたまま残る", async (_, hold, message) => {
    const { workspace } = await makeRemoteBackedWorkspace("retry-held-by-quarantine");
    const db = openDb(":memory:");
    const clock = new FakeClock();
    const github = new FakeGitHubClient();
    authority = () => undefined;
    const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveAuthority: () => authority() });
    const work = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);
    git(workspace.path, "checkout", "-b", `task/${work.id}`);
    commitWork(workspace.path, "feature.txt", "ready\n");
    github.scriptFailure(new Error("first promotion failed"));
    completeTask(db, work, FULL_HANDOFF, "worker", clock.now(), "worker");
    settleReviews(db, clock.now());
    await landing.converge();
    const failure = getTask(db, listBoard(db).find((q) => q.question_pending_pr_promotion_task_id === work.id)!.id)!;
    github.scriptFailure(null);
    hold(db, workspace, clock.now());

    await expect(
      submitAnswer({ db, pollNow: () => {}, landing, workspace, github }, failure, ["retry"], undefined, () => clock.now(), "webui"),
    ).rejects.toThrow(new DomainError(message(workspace)));
    expect(getTask(db, failure.id)).toMatchObject({ status: "todo" });
    expect(github.requests).toHaveLength(1);
  });
});
