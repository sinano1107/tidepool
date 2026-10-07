import { expect, it } from "vitest";
import { openDb } from "../src/db.js";

import { DomainError } from "../src/domain-error.js";
import { taskDecisionLog } from "../src/events.js";

import {
  cancelTaskDirectly,
  completeTask,
  continueDecomposition,
  declarePremiseBreach,
  getRegistrant,
  getTask,
  joinHistory,
  logDecision,
  nextSlotTask,
  presentTask,
  redecompose,
  registerTask,
  type Task,
  taskHistoryRows,
} from "../src/tasks.js";

import { listLog } from "../src/triage.js";
import {
  BOARD_WORKER_ID,
  HUMAN_WORKER_ID,
} from "../src/worker-id.js";
import { answerQuestionViaWebui, decomposeTaskAsWorker, HUMAN_WEBUI, humanDecomposeTaskViaWebui } from "./harness.js";


const at = new Date("2026-09-15T00:00:00.000Z");
const HANDOFF = { outcome: "done", deliverables: "n/a", decision_refs: "n/a", dead_ends: "n/a", resume_context: "n/a", known_issues: "n/a" };
type Db = ReturnType<typeof openDb>;

function root(db: Db, title = "T"): Task {
  return registerTask(db, { type: "work", title, purpose: `purpose of ${title}`, completion_criteria: `criteria of ${title}` }, at, ...HUMAN_WEBUI);
}

function spec(title: string) {
  return { title, purpose: `purpose of ${title}`, completion_criteria: `criteria of ${title}` };
}

function agentDecompose(db: Db, parent: Task, ...titles: string[]): Task[] {
  return decomposeTaskAsWorker(db, getTask(db, parent.id)!, { reason: `split ${parent.title}`, children: titles.map(spec) }, "tako", at);
}

/** 分解の author(worker)が撮り直す。authority も保護 workspace も無い。 */
function redecomposeAsWorker(db: Db, parent: Task, input: Parameters<typeof redecompose>[2], workerId: string, now: Date): Task[] {
  return redecompose(db, parent, input, workerId, now, undefined, undefined, "worker");
}

/** 同じ親に乗る別の分解判断の子(人間 decompose が blocked な親に足す形)。 */
function otherDecisionChild(db: Db, parent: Task, title: string): Task {
  const decision = logDecision(db, parent, `human adds ${title}`, HUMAN_WORKER_ID, at, "worker");
  return registerTask(db, { type: "work", ...spec(title), parent_id: parent.id, based_on_decision: decision }, at, ...HUMAN_WEBUI);
}

it("前提の破綻は宣言者と同じ分解判断の未決着の兄弟のサブツリーだけを held にし、別の分解判断の子は pickup できる", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a, b, c] = agentDecompose(db, parent, "A", "B", "C");
  const [bChild] = agentDecompose(db, b!, "B1");
  const other = otherDecisionChild(db, parent, "H");

  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker");

  expect(presentTask(db, getTask(db, a!.id)!).status).toBe("held");
  expect(presentTask(db, getTask(db, c!.id)!).status).toBe("held");
  expect(presentTask(db, getTask(db, bChild!.id)!).status).toBe("held");
  expect(presentTask(db, getTask(db, other.id)!).status).toBe("todo");
  expect(nextSlotTask(db)?.id).toBe(other.id);
  db.close();
});

it("待っている未決着の子がすべて破綻した判断の範囲に入るとき、blocked の親が pickup の先頭になる(早期統合復帰)", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a, b] = agentDecompose(db, parent, "A", "B");
  completeTask(db, getTask(db, b!.id)!, HANDOFF, "tako", at, "worker");

  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker");

  expect(presentTask(db, getTask(db, parent.id)!).status).toBe("blocked");
  expect(nextSlotTask(db)?.id).toBe(parent.id);
  db.close();
});

it("書き手が人間の分解判断への宣言は Tidepool 名義の question(continue / abandon)を宣言者の子に登録し、兄弟は held、親も宣言者も pickup されない", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a, b] = humanDecomposeTaskViaWebui(db, parent, { reason: "human split", children: [spec("A"), spec("B")] }, at);

  const question = declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker")!;

  expect(question.parent_id).toBe(a!.id);
  expect(getRegistrant(db, question.id)).toBe(BOARD_WORKER_ID);
  expect(question.question_items).toEqual([
    expect.objectContaining({ options: ["continue", "abandon"], recommendation: "continue" }),
  ]);
  expect(question.question_cancel_option).toBe("abandon");
  expect(question.purpose).toContain("module M is broken");
  expect(question.purpose).toContain("1 unfinished sibling from the same decomposition decision");
  expect(presentTask(db, getTask(db, b!.id)!).status).toBe("held");
  expect(nextSlotTask(db)).toBeUndefined();
  db.close();
});

it("破綻の question への abandon は分解判断ごと破棄して親を再計画に戻し、continue は宣言者と兄弟を解放する", () => {
  const db = openDb(":memory:");
  const abandoned = root(db, "abandoned");
  const [a, b] = humanDecomposeTaskViaWebui(db, abandoned, { reason: "human split", children: [spec("A"), spec("B")] }, at);
  const abandonQuestion = declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker")!;

  answerQuestionViaWebui(db, abandonQuestion, ["abandon"], at);

  expect([getTask(db, a!.id)?.status, getTask(db, b!.id)?.status]).toEqual(["cancelled", "cancelled"]);
  expect(nextSlotTask(db)?.id).toBe(abandoned.id);
  completeTask(db, getTask(db, abandoned.id)!, HANDOFF, "tako", at, "worker");

  const continued = root(db, "continued");
  const [c, d] = humanDecomposeTaskViaWebui(db, continued, { reason: "human split", children: [spec("C"), spec("D")] }, at);
  const continueQuestion = declarePremiseBreach(db, getTask(db, c!.id)!, "module M is broken", "tako", at, "worker")!;

  answerQuestionViaWebui(db, continueQuestion, ["continue"], at);

  expect(presentTask(db, getTask(db, d!.id)!).status).toBe("todo");
  expect(nextSlotTask(db)?.id).toBe(c!.id);
  db.close();
});

it("破綻の question に abandon + comment で答えると、親の history で cancel された子の origin_question がその comment を運ぶ", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a] = humanDecomposeTaskViaWebui(db, parent, { reason: "human split", children: [spec("A"), spec("B")] }, at);
  const question = declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker")!;

  answerQuestionViaWebui(db, question, ["abandon"], at, { comment: "M は作り直す" });

  const originQuestion = { title: question.title, answer: ["abandon"], comment: "M は作り直す" };
  expect(joinHistory(taskHistoryRows(db, parent.id))).toEqual([
    {
      decision: "human split",
      children: [
        expect.objectContaining({ title: "A", status: "cancelled", origin_question: originQuestion }),
        expect.objectContaining({ title: "B", status: "cancelled", origin_question: originQuestion }),
      ],
    },
  ]);
  db.close();
});

it("親の continue は判断ログ1行で held を解いて親を blocked に戻し、同じ判断への2度目の宣言は親に戻さず question になる", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a, b] = agentDecompose(db, parent, "A", "B");
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker");

  continueDecomposition(db, getTask(db, parent.id)!, "M is fine; the failing test was stale", "tako", at, "worker");

  expect(presentTask(db, getTask(db, b!.id)!).status).toBe("todo");
  expect(nextSlotTask(db)?.id).toBe(a!.id);

  const question = declarePremiseBreach(db, getTask(db, b!.id)!, "M is still broken", "tako", at, "worker")!;
  expect(question.parent_id).toBe(b!.id);
  expect(getRegistrant(db, question.id)).toBe(BOARD_WORKER_ID);
  expect(nextSlotTask(db)).toBeUndefined();
  db.close();
});

it("続行・再分解は子の前提の破綻が開いていない親を拒み、破綻が開いている間の素の decompose は再分解へ案内して拒む", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a] = agentDecompose(db, parent, "A");

  expect(() => continueDecomposition(db, getTask(db, parent.id)!, "line", "tako", at, "worker")).toThrow(DomainError);
  expect(() => redecomposeAsWorker(db, getTask(db, parent.id)!, { reason: "r", children: [spec("X")] }, "tako", at)).toThrow(DomainError);
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker");
  expect(() => agentDecompose(db, parent, "X")).toThrow(/redecompose/);
  db.close();
});

it("再分解は破綻した判断の未決着の子を宣言の出自つきで cancel して新しい判断の子を登録し、子の登録が失敗すれば旧い子も破綻も残る", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a, , c] = agentDecompose(db, parent, "A", "B", "C");
  completeTask(db, getTask(db, c!.id)!, HANDOFF, "tako", at, "worker");
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker");

  expect(() =>
    redecomposeAsWorker(db, getTask(db, parent.id)!, { reason: "replan", children: [{ ...spec("X"), tier: "bogus" }] }, "tako", at),
  ).toThrow(DomainError);
  expect(joinHistory(taskHistoryRows(db, parent.id))).toEqual([
    {
      decision: "split T",
      children: [
        expect.objectContaining({ title: "A", status: "held", premise_breach: "module M is broken" }),
        expect.objectContaining({ title: "B", status: "held" }),
        expect.objectContaining({ title: "C", status: "done" }),
      ],
    },
  ]);

  redecomposeAsWorker(db, getTask(db, parent.id)!, { reason: "replan around M", children: [spec("X")] }, "tako", at);

  const breach = { title: "A", reason: "module M is broken" };
  expect(joinHistory(taskHistoryRows(db, parent.id))).toEqual([
    {
      decision: "split T",
      children: [
        expect.objectContaining({ title: "A", status: "cancelled", origin_breach: breach }),
        expect.objectContaining({ title: "B", status: "cancelled", origin_breach: breach }),
        expect.objectContaining({ title: "C", status: "done" }),
      ],
    },
    { decision: "replan around M", children: [expect.objectContaining({ title: "X", status: "todo" })] },
  ]);
  expect(nextSlotTask(db)?.title).toBe("X");
  db.close();
});

it("続行の後、親の時系列は宣言の欄を持たず、親の続行の1行を子のない判断として運ぶ", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a] = agentDecompose(db, parent, "A");
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker");

  continueDecomposition(db, getTask(db, parent.id)!, "M is fine", "tako", at, "worker");

  expect(joinHistory(taskHistoryRows(db, parent.id, a!.id))).toEqual([
    { decision: "split T", children: [expect.not.objectContaining({ premise_breach: expect.anything() })] },
    { decision: "M is fine", children: [] },
  ]);
  db.close();
});

it("分解判断に乗らない root と付帯子の宣言は escalate へ案内して拒む", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const attached = registerTask(db, { type: "work", ...spec("repair"), parent_id: parent.id }, at, ...HUMAN_WEBUI);

  expect(() => declarePremiseBreach(db, getTask(db, parent.id)!, "r", "tako", at, "worker")).toThrow(/escalate/);
  expect(() => declarePremiseBreach(db, attached, "r", "tako", at, "worker")).toThrow(/escalate/);
  db.close();
});

it("破綻が開いたまま木が直接 cancel されると、cancel された宣言者は破綻の欄を持たない", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a] = agentDecompose(db, parent, "A", "B");
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker");

  cancelTaskDirectly(db, getTask(db, parent.id)!, null, at, {}, "webui");

  expect(joinHistory(taskHistoryRows(db, parent.id))).toEqual([
    {
      decision: "split T",
      children: [
        expect.not.objectContaining({ premise_breach: expect.anything() }),
        expect.objectContaining({ title: "B", status: "cancelled" }),
      ],
    },
  ]);
  db.close();
});

it("破綻の question が立っている間、その木への直接 cancel は拒まれる", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a] = humanDecomposeTaskViaWebui(db, parent, { reason: "human split", children: [spec("A"), spec("B")] }, at);
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker");

  expect(() => cancelTaskDirectly(db, getTask(db, parent.id)!, null, at, {}, "webui")).toThrow(/answer it/);
  db.close();
});

it("前提の破綻の宣言は判断ログの一覧(盤面全体・宣言者の task)に異議を向けられるエントリとして並ぶ", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a] = agentDecompose(db, parent, "A");

  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at, "worker");

  const breach = expect.objectContaining({
    task_id: a!.id,
    kind: "premise_breached",
    payload: expect.objectContaining({ line: "module M is broken" }),
  });
  expect(taskDecisionLog(db, a!.id)).toEqual([breach]);
  expect(listLog(db)).toContainEqual(breach);
  db.close();
});
