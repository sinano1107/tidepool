import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, taskDecisionLog } from "../src/events.js";
import { completeTask, declarePremiseBreach, getTask, joinHistory, logDecision, registerTask, type Task, taskHistoryRows } from "../src/tasks.js";
import { decomposeTaskViaWorker, FULL_HANDOFF, HUMAN_WEBUI } from "./harness.js";

// ADR 0322 決定2・3 / 追記: history の行は自分の event id を名乗り、子の context は全ての子が task id を持つ

const at = new Date("2026-10-28T00:00:00.000Z");

function root(db: Db): Task {
  return registerTask(db, { type: "work", title: "T", purpose: "purpose of T", completion_criteria: "criteria of T" }, at, ...HUMAN_WEBUI);
}

function decompose(db: Db, parent: Task, ...titles: string[]): Task[] {
  return decomposeTaskViaWorker(db, getTask(db, parent.id)!, { reason: "split T", children: titles.map((title) => ({ title, purpose: `purpose of ${title}`, completion_criteria: `criteria of ${title}` })) }, "tako", at);
}

it("2つの子を持つ判断の行は畳んでも decision_logged の id を名乗り、子の登録 event の id にならない", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a, b] = decompose(db, parent, "A", "B");
  const [decision] = taskDecisionLog(db, parent.id);

  const rows = taskHistoryRows(db, parent.id);
  expect(rows.map((row) => row.entry)).toEqual([
    expect.objectContaining({ id: decision!.id, decision: "split T" }),
    expect.objectContaining({ id: decision!.id, decision: "split T" }),
  ]);
  expect(joinHistory(rows)).toEqual([
    { id: decision!.id, decision: "split T", children: [expect.objectContaining({ id: a!.id, title: "A" }), expect.objectContaining({ id: b!.id, title: "B" })] },
  ]);
});

it("受験者でない子の context も task id を持つ", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a] = decompose(db, parent, "A");

  const [row] = taskHistoryRows(db, parent.id);
  expect(row!.entry).toEqual(expect.objectContaining({ children: [expect.objectContaining({ id: a!.id, title: "A" })] }));
});

it("判断ログの人間向けの4種はそれぞれ history の行になり、event の順に自分の event id を名乗る", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [child] = decompose(db, parent, "A");
  const decided = logDecision(db, getTask(db, child!.id)!, "read the module", "tako", at, "worker");
  const written = appendEvent(db, { taskId: child!.id, actorId: "tako", origin: "worker", at, payload: { kind: "memory_written", line: "wrote knowledge #1 \"M\" at build (whole board)", created: [1], invalidated: [] } });
  declarePremiseBreach(db, getTask(db, child!.id)!, "module M is broken", "tako", at, "worker");
  const breached = taskDecisionLog(db, child!.id).find((e) => e.kind === "premise_breached")!.id;
  completeTask(db, getTask(db, child!.id)!, FULL_HANDOFF, "tako", at, "worker");
  const completed = taskDecisionLog(db, child!.id).find((e) => e.kind === "task_completed")!.id;

  expect(taskHistoryRows(db, child!.id).map((row) => row.entry)).toEqual([
    { id: decided, decision: "read the module", children: [] },
    { id: written, memory_written: "wrote knowledge #1 \"M\" at build (whole board)" },
    { id: breached, premise_breached: "module M is broken" },
    { id: completed, completion: FULL_HANDOFF.outcome },
  ]);
});
