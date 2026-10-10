import { describe, expect, it, vi } from "vitest";
import { agentNeedsHuman } from "../src/agent.js";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { openQuarantineQuestion, QUARANTINES, type QuarantineChecks, quarantineAgent, quarantineStops, registerQuarantine } from "../src/quarantine.js";
import { getTask, nextSlotTask, registerTask } from "../src/tasks.js";
import { quarantineWorkspace, workspaceNeedsHuman } from "../src/workspace.js";
import { FakeClock, unusedLanding } from "./fakes.js";
import { HUMAN_WEBUI } from "./harness.js";

/** 解除の門と受理後は表から引く(ADR 0137 決定4・5)。表を総なめするので、1行足せば
 *  このテストもその行について述べる。 */

const now = () => new Date(0);

function quarantined(kind: (typeof QUARANTINES)[number]["kind"], value: string | null) {
  const db = openDb(":memory:");
  registerQuarantine(db, kind, value, "it broke", now());
  const question = getTask(db, openQuarantineQuestion(db, kind, value)!.id)!;
  const pollNow = vi.fn();
  const answer = (quarantineChecks: QuarantineChecks) =>
    submitAnswer(
      { db, pollNow, landing: unusedLanding, quarantineChecks },
      question,
      [question.question_items![0]!.options[0]!],
      undefined,
      now,
      "webui",
    );
  return { db, question, pollNow, answer };
}

// 盤面全体の種類は値を持たない(NULL の鍵)。effort の行は回答を受ける契機(openai の行)の値
describe.each(QUARANTINES.map((row) => [row.kind, row.scope === "board" ? null : row.kind === "tableRowEffort" ? "openai/gpt-5.5/max" : "x"] as const))(
  "%s の確認型 question への回答",
  (kind, value) => {
  it("検査が不成立なら回答は拒否され、question は開いたまま残る", async () => {
    const q = quarantined(kind, value);

    await expect(
      q.answer({ [kind]: async () => { throw new DomainError("still broken"); } }),
    ).rejects.toThrow("still broken");

    expect(openQuarantineQuestion(q.db, kind, value)).toBeDefined();
  });

  it("検査の map にその種類が無ければ回答は拒否され、question は開いたまま残る", async () => {
    const q = quarantined(kind, value);

    await expect(q.answer({})).rejects.toThrow(DomainError);

    expect(openQuarantineQuestion(q.db, kind, value)).toBeDefined();
  });

  it("受理されたら quarantine_released が種類と値を運び、pickup の再開が立つ", async () => {
    const q = quarantined(kind, value);
    const checked: Array<string | null> = [];

    await q.answer({ [kind]: async (value: string | null) => { checked.push(value); } });

    expect(checked).toEqual([value]);
    expect(openQuarantineQuestion(q.db, kind, value)).toBeUndefined();
    expect(listEvents(q.db, q.question.id).at(-1)?.payload).toEqual({
      kind: "quarantine_released",
      quarantine: kind,
      value,
    });
    expect(q.pollNow).toHaveBeenCalledOnce();
  });
});

it("起動時の照合の契機(anthropic / moonshot の行)の effort の Quarantine は、probe が通っても回答では解除しない", async () => {
  const probe = vi.fn(async () => ({ status: "runs" as const }));
  const checks = quarantineChecks({ db: openDb(":memory:"), modelProbes: { anthropic: probe, moonshot: probe }, clock: new FakeClock() });

  for (const value of ["anthropic/claude-haiku-4-5-20251001/high", "moonshot/kimi-k3/"]) {
    await expect(checks.tableRowEffort!(value)).rejects.toThrow("only a table edit settles this question");
  }
  expect(probe).not.toHaveBeenCalled();
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
      "webui",
    );

  it("workspace", async () => {
    const db = openDb(":memory:");
    const task = registerTask(db, { ...work, workspace: "prod" }, now(), ...HUMAN_WEBUI);
    quarantineWorkspace(db, "prod", "tree rule failed", now());
    expect(workspaceNeedsHuman(db, "prod")).toBe(true);
    expect(nextSlotTask(db, "sandbox", undefined, undefined, quarantineStops(db))).toBeUndefined();

    await accept("workspace", "prod", db);

    expect(workspaceNeedsHuman(db, "prod")).toBe(false);
    expect(nextSlotTask(db, "sandbox", undefined, undefined, quarantineStops(db))?.id).toBe(task.id);
  });

  it("agent 名", async () => {
    const db = openDb(":memory:");
    const task = registerTask(db, { ...work, assignee: "navigator" }, now(), ...HUMAN_WEBUI);
    quarantineAgent(db, "navigator", "unknown agent", now());
    expect(agentNeedsHuman(db, "navigator")).toBe(true);
    expect(nextSlotTask(db, undefined, "deckhand", undefined, quarantineStops(db))).toBeUndefined();

    await accept("agent", "navigator", db);

    expect(agentNeedsHuman(db, "navigator")).toBe(false);
    expect(nextSlotTask(db, undefined, "deckhand", undefined, quarantineStops(db))?.id).toBe(task.id);
  });
});
