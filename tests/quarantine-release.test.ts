import { describe, expect, it, vi } from "vitest";
import { agentNeedsHuman, quarantineAgent } from "../src/agent.js";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { submitAnswer } from "../src/human-verbs.js";
import {
  openQuarantineQuestion,
  QUARANTINES,
  type QuarantineChecks,
  registerQuarantine,
} from "../src/quarantine.js";
import { DomainError, getTask, nextSlotTask, registerTask } from "../src/tasks.js";
import { quarantineWorkspace, workspaceNeedsHuman } from "../src/workspace.js";
import { unusedLanding } from "./fakes.js";

/** 解除の門と受理後は表から引く(ADR 0137 決定4・5)。表を総なめするので、1行足せば
 *  このテストもその行について述べる。 */

const now = () => new Date(0);

function quarantined(kind: (typeof QUARANTINES)[number]["kind"]) {
  const db = openDb(":memory:");
  registerQuarantine(db, kind, "x", "it broke", now());
  const question = getTask(db, openQuarantineQuestion(db, kind, "x")!.id)!;
  const pollNow = vi.fn();
  const answer = (quarantineChecks: QuarantineChecks) =>
    submitAnswer(
      { db, pollNow, landing: unusedLanding, quarantineChecks },
      question,
      [question.question_items![0]!.options[0]!],
      undefined,
      now,
    );
  return { db, question, pollNow, answer };
}

describe.each(QUARANTINES.map((row) => row.kind))("%s の確認型 question への回答", (kind) => {
  it("検査が不成立なら回答は拒否され、question は開いたまま残る", async () => {
    const q = quarantined(kind);

    await expect(
      q.answer({ [kind]: async () => { throw new DomainError("still broken"); } }),
    ).rejects.toThrow("still broken");

    expect(openQuarantineQuestion(q.db, kind, "x")).toBeDefined();
  });

  it("検査の map にその種類が無ければ回答は拒否され、question は開いたまま残る", async () => {
    const q = quarantined(kind);

    await expect(q.answer({})).rejects.toThrow(DomainError);

    expect(openQuarantineQuestion(q.db, kind, "x")).toBeDefined();
  });

  it("受理されたら quarantine_released が種類と値を運び、pickup の再開が立つ", async () => {
    const q = quarantined(kind);
    const checked: Array<string | null> = [];

    await q.answer({ [kind]: async (value: string | null) => { checked.push(value); } });

    expect(checked).toEqual(["x"]);
    expect(listEvents(q.db, q.question.id).at(-1)?.payload).toEqual({
      kind: "quarantine_released",
      quarantine: kind,
      value: "x",
    });
    expect(q.pollNow).toHaveBeenCalledOnce();
  });
});

describe("question が回答済みなら、その資源のタスクは pickup される", () => {
  const work = { type: "work" as const, title: "t", purpose: "p", completion_criteria: "c" };
  const accept = (kind: "workspace" | "agent", value: string, db: ReturnType<typeof openDb>) =>
    submitAnswer(
      { db, pollNow() {}, landing: unusedLanding, quarantineChecks: { [kind]: async () => {} } },
      getTask(db, openQuarantineQuestion(db, kind, value)!.id)!,
      ["repaired by hand"],
      undefined,
      now,
    );

  it("workspace", async () => {
    const db = openDb(":memory:");
    const task = registerTask(db, { ...work, workspace: "prod" }, now());
    quarantineWorkspace(db, "prod", "tree rule failed", now());
    expect(workspaceNeedsHuman(db, "prod")).toBe(true);
    expect(nextSlotTask(db, "sandbox")).toBeUndefined();

    await accept("workspace", "prod", db);

    expect(workspaceNeedsHuman(db, "prod")).toBe(false);
    expect(nextSlotTask(db, "sandbox")?.id).toBe(task.id);
  });

  it("agent 名", async () => {
    const db = openDb(":memory:");
    const task = registerTask(db, { ...work, assignee: "navigator" }, now());
    quarantineAgent(db, "navigator", "unknown agent", now());
    expect(agentNeedsHuman(db, "navigator")).toBe(true);
    expect(nextSlotTask(db, undefined, "deckhand")).toBeUndefined();

    await accept("agent", "navigator", db);

    expect(agentNeedsHuman(db, "navigator")).toBe(false);
    expect(nextSlotTask(db, undefined, "deckhand")?.id).toBe(task.id);
  });
});
