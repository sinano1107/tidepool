import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { answerQuestion, BOARD_WORKER_ID, DomainError, registerTask } from "../src/tasks.js";

function quarantineAgentRow(db: ReturnType<typeof openDb>, name: string): void {
  db.prepare(
    `INSERT INTO agent_state (name, needs_human) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET needs_human = 1`,
  ).run(name);
}

function agentNeedsHumanRow(db: ReturnType<typeof openDb>, name: string): boolean {
  const row = db.prepare("SELECT needs_human FROM agent_state WHERE name = ?").get(name) as
    | { needs_human: number }
    | undefined;
  return row?.needs_human === 1;
}

describe("quarantine_agent(ADR 0012 / issue #36: workspace 版の agent 名一般化)", () => {
  it("quarantine_agent 付きの question は1択(workspace 版と同じ緩和)で登録できる", () => {
    const db = openDb(":memory:");
    const question = registerTask(
      db,
      {
        type: "question",
        title: "agent navigator needs human attention",
        purpose: "unknown agent name at pickup",
        completion_criteria: "the agent is repaired by hand",
        question: { options: ["repaired by hand"], recommendation: "repaired by hand" },
        quarantine_agent: "navigator",
      },
      new Date(0),
      BOARD_WORKER_ID,
    );
    expect(question.question_quarantine_agent).toBe("navigator");
  });

  it("quarantine_agent も quarantine_workspace も付かない question は通常どおり2択以上を要求する", () => {
    const db = openDb(":memory:");
    expect(() =>
      registerTask(
        db,
        {
          type: "question",
          title: "plain question",
          purpose: "p",
          completion_criteria: "c",
          question: { options: ["only"], recommendation: "only" },
        },
        new Date(0),
      ),
    ).toThrow(DomainError);
  });

  it("quarantine_agent の question に回答すると agent_state.needs_human が解除され、pickupResumed が立つ", () => {
    const db = openDb(":memory:");
    quarantineAgentRow(db, "navigator");
    const question = registerTask(
      db,
      {
        type: "question",
        title: "agent navigator needs human attention",
        purpose: "unknown agent name at pickup",
        completion_criteria: "the agent is repaired by hand",
        question: { options: ["repaired by hand"], recommendation: "repaired by hand" },
        quarantine_agent: "navigator",
      },
      new Date(0),
      BOARD_WORKER_ID,
    );

    const { pickupResumed, question: answered } = answerQuestion(
      db,
      question,
      "repaired by hand",
      new Date(1),
    );

    expect(pickupResumed).toBe(true);
    expect(answered.status).toBe("done");
    expect(agentNeedsHumanRow(db, "navigator")).toBe(false);
  });
});
