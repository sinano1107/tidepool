import { describe, expect, it, vi } from "vitest";
import { agentNeedsHuman } from "../src/agent.js";
import { listBoardCalls } from "../src/board-call-usage.js";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { openQuarantineQuestion, QUARANTINES, type QuarantineChecks, quarantineAgent, quarantineStops, registerQuarantine } from "../src/quarantine.js";
import { answerQuestion, getTask, nextSlotTask, registerTask, settleQuestionAsObserved } from "../src/tasks.js";
import { quarantineWorkspace, workspaceNeedsHuman } from "../src/workspace.js";
import { awaitWindow, BOARD_CALL_USAGE, FakeClock, unusedLanding } from "./fakes.js";
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

// 盤面全体の種類と続く poll の失敗は値を持たない(NULL の鍵)。effort の行は回答を受ける契機(openai の行)の値
describe.each(QUARANTINES.map((row) => [row.kind, row.scope === "board" || row.scope === "none" ? null : row.kind === "tableRowEffort" ? "openai/gpt-5.5/max" : "x"] as const))(
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

/** 確認の回答の再検査が立てた model turn は、受理・拒否の前に1行を残す(ADR 0299 決定3・6)。usage の無い結果は行を残さない。 */
it("Provider 認証の再検査は cli_auth_probe、行と Interview の対象の再検査は model_probe の1行を Provider つきで残し、拒否でも残す", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const turn = (provider: "anthropic" | "moonshot", model: string, effort: string | null) => ({
    boardCall: { setting: { provider, model, effort }, usage: BOARD_CALL_USAGE },
  });
  const checks = quarantineChecks({
    db,
    clock,
    providerCliAuth: {
      anthropic: async () => ({ status: "authenticated", ...turn("anthropic", "haiku", "low") }),
      moonshot: async () => ({ status: "unknown", reason: "budget cap", ...turn("moonshot", "kimi-k3[1m]", null) }),
    },
    modelProbes: {
      anthropic: async (model) => ({ status: "runs", ...turn("anthropic", model, "low") }),
      moonshot: async (model) => ({ status: "unknown", reason: "no result", ...turn("moonshot", model, null) }),
    },
  });

  await checks.providerAuth!("anthropic");
  await expect(checks.providerAuth!("moonshot")).rejects.toThrow("moonshot authentication is still unavailable");
  await checks.tableRow!("anthropic/claude-fable-5-1");
  await expect(checks.interviewTarget!("moonshot/kimi-k2-5")).rejects.toThrow("still cannot run");

  const createdAt = clock.now().toISOString();
  expect(listBoardCalls(db).map(({ use, provider, model, effort, usage, createdAt }) => ({ use, provider, model, effort, usage, createdAt }))).toEqual([
    { use: "cli_auth_probe", provider: "anthropic", model: "haiku", effort: "low", usage: BOARD_CALL_USAGE, createdAt },
    { use: "cli_auth_probe", provider: "moonshot", model: "kimi-k3[1m]", effort: null, usage: BOARD_CALL_USAGE, createdAt },
    { use: "model_probe", provider: "anthropic", model: "claude-fable-5-1", effort: "low", usage: BOARD_CALL_USAGE, createdAt },
    { use: "model_probe", provider: "moonshot", model: "kimi-k2-5", effort: null, usage: BOARD_CALL_USAGE, createdAt },
  ]);
});

it("usage の無い再検査の結果は行を残さない", async () => {
  const db = openDb(":memory:");
  const checks = quarantineChecks({
    db,
    clock: new FakeClock(),
    providerCliAuth: { anthropic: async () => ({ status: "unauthorized", reason: "API returned 401" }) },
    modelProbes: { anthropic: async () => ({ status: "refused", reason: "API returned 404 for this model id" }) },
  });

  await expect(checks.providerAuth!("anthropic")).rejects.toThrow(DomainError);
  await expect(checks.tableRow!("anthropic/claude-fable-5-1")).rejects.toThrow(DomainError);

  expect(listBoardCalls(db)).toEqual([]);
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

// ADR 0288 決定1: 回答は書き込みの時点で question がまだ開いているときだけ書く —— 呼び手が読んだ時点では開いていても、閉じていれば回答ごと止まる
it.each(["done", "cancelled"])("読んだ後に %s になった Quarantine の確認 question への回答は拒まれ、回答も解除も残らない", (status) => {
  const { db, question } = quarantined("workspace", "x");
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, question.id);

  expect(() => answerQuestion(db, question, ["repaired by hand"], now(), undefined, undefined, undefined, "webui")).toThrow(DomainError);

  const kinds = listEvents(db, question.id).map((event) => event.kind);
  expect(kinds).not.toContain("question_answered");
  expect(kinds).not.toContain("quarantine_released");
});

// ADR 0288 決定4: 検査の await の間に閉じた question への回答は、閉じた理由で応答が分かれる
it("検査の await の間に盤面が観測で閉じた確認 question への回答は、回答を残さず観測で閉じた印を返し、解除は1件だけ残る", async () => {
  const q = quarantined("workspace", "x");
  const gate = awaitWindow();
  const first = q.answer({ workspace: gate.hold });
  await gate.entered;
  settleQuestionAsObserved(q.db, q.question.id, { kind: "quarantine_released", quarantine: "workspace", value: "x" }, now());
  gate.open();

  await expect(first).resolves.toMatchObject({ status: "done", settled_by_observation: "quarantine_released" });
  const kinds = listEvents(q.db, q.question.id).map((event) => event.kind);
  expect(kinds).not.toContain("question_answered");
  expect(kinds.filter((kind) => kind === "quarantine_released")).toHaveLength(1);
});

it("検査の await の間に別の回答が通った確認 question への回答は拒まれ、回答は1件だけ残る", async () => {
  const q = quarantined("workspace", "x");
  const gate = awaitWindow();
  // 窓は1回だけ止まる —— 2本目の回答の検査はすぐ通る
  const checks = { workspace: gate.hold };
  const first = q.answer(checks);
  await gate.entered;
  await q.answer(checks);
  gate.open();

  await expect(first).rejects.toThrow(DomainError);
  expect(listEvents(q.db, q.question.id).filter((event) => event.kind === "question_answered")).toHaveLength(1);
});
