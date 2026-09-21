import { describe, expect, it } from "vitest";
import { agentNeedsHuman } from "../src/agent.js";
import { openDb } from "../src/db.js";
import { answerQuestion, BOARD_WORKER_ID, DomainError, registerTask } from "../src/tasks.js";

describe("agent の quarantine(ADR 0012 / issue #36: workspace 版の agent 名一般化)", () => {
  it("agent の quarantine 付きの question は1択(workspace 版と同じ緩和)で登録できる", () => {
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
    );
    expect(question).toMatchObject({ question_quarantine_kind: "agent", question_quarantine_value: "navigator" });
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
      ),
    ).toThrow(DomainError);
  });

  it("agent の quarantine の question に回答すると agent 名の quarantine が解け、pickupResumed が立つ", () => {
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
    );

    const { pickupResumed, question: answered } = answerQuestion(
      db,
      question,
      ["repaired by hand"],
      new Date(1),
    );

    expect(pickupResumed).toBe(true);
    expect(answered.status).toBe("done");
    expect(agentNeedsHuman(db, "navigator")).toBe(false);
  });
});
