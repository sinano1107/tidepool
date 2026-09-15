import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  answerQuestion,
  BOARD_WORKER_ID,
  cancelTaskDirectly,
  completeTask,
  continueDecomposition,
  DomainError,
  declarePremiseBreach,
  decomposeTask,
  getRegistrant,
  getTask,
  HUMAN_WORKER_ID,
  humanDecomposeTask,
  logDecision,
  nextSlotTask,
  presentTask,
  redecompose,
  registerTask,
  type Task,
  taskHistory,
} from "../src/tasks.js";

const at = new Date("2026-09-15T00:00:00.000Z");
const HANDOFF = { outcome: "done", deliverables: "n/a", decision_refs: "n/a", dead_ends: "n/a", resume_context: "n/a", known_issues: "n/a" };
type Db = ReturnType<typeof openDb>;

function root(db: Db, title = "T"): Task {
  return registerTask(db, { type: "work", title, purpose: `purpose of ${title}`, completion_criteria: `criteria of ${title}` }, at);
}

function spec(title: string) {
  return { title, purpose: `purpose of ${title}`, completion_criteria: `criteria of ${title}` };
}

function agentDecompose(db: Db, parent: Task, ...titles: string[]): Task[] {
  return decomposeTask(db, getTask(db, parent.id)!, { reason: `split ${parent.title}`, children: titles.map(spec) }, "tako", at);
}

/** 同じ親に乗る別の分解判断の子(人間 decompose が blocked な親に足す形)。 */
function otherDecisionChild(db: Db, parent: Task, title: string): Task {
  const decision = logDecision(db, parent, `human adds ${title}`, HUMAN_WORKER_ID, at);
  return registerTask(db, { type: "work", ...spec(title), parent_id: parent.id, based_on_decision: decision }, at);
}

it("前提の破綻は宣言者と同じ分解判断の未決着の兄弟のサブツリーだけを held にし、別の分解判断の子は pickup できる", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a, b, c] = agentDecompose(db, parent, "A", "B", "C");
  const [bChild] = agentDecompose(db, b!, "B1");
  const other = otherDecisionChild(db, parent, "H");

  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at);

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
  completeTask(db, getTask(db, b!.id)!, HANDOFF, "tako", at);

  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at);

  expect(presentTask(db, getTask(db, parent.id)!).status).toBe("blocked");
  expect(nextSlotTask(db)?.id).toBe(parent.id);
  db.close();
});

it("書き手が人間の分解判断への宣言は Tidepool 名義の question(continue / abandon)を宣言者の子に登録し、兄弟は held、親も宣言者も pickup されない", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a, b] = humanDecomposeTask(db, parent, { reason: "human split", children: [spec("A"), spec("B")] }, at);

  const question = declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at)!;

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
  const [a, b] = humanDecomposeTask(db, abandoned, { reason: "human split", children: [spec("A"), spec("B")] }, at);
  const abandonQuestion = declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at)!;

  answerQuestion(db, abandonQuestion, ["abandon"], at);

  expect([getTask(db, a!.id)?.status, getTask(db, b!.id)?.status]).toEqual(["cancelled", "cancelled"]);
  expect(nextSlotTask(db)?.id).toBe(abandoned.id);
  completeTask(db, getTask(db, abandoned.id)!, HANDOFF, "tako", at);

  const continued = root(db, "continued");
  const [c, d] = humanDecomposeTask(db, continued, { reason: "human split", children: [spec("C"), spec("D")] }, at);
  const continueQuestion = declarePremiseBreach(db, getTask(db, c!.id)!, "module M is broken", "tako", at)!;

  answerQuestion(db, continueQuestion, ["continue"], at);

  expect(presentTask(db, getTask(db, d!.id)!).status).toBe("todo");
  expect(nextSlotTask(db)?.id).toBe(c!.id);
  db.close();
});

it("親の continue は判断ログ1行で held を解いて親を blocked に戻し、同じ判断への2度目の宣言は親に戻さず question になる", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a, b] = agentDecompose(db, parent, "A", "B");
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at);

  continueDecomposition(db, getTask(db, parent.id)!, "M is fine; the failing test was stale", "tako", at);

  expect(presentTask(db, getTask(db, b!.id)!).status).toBe("todo");
  expect(nextSlotTask(db)?.id).toBe(a!.id);

  const question = declarePremiseBreach(db, getTask(db, b!.id)!, "M is still broken", "tako", at)!;
  expect(question.parent_id).toBe(b!.id);
  expect(getRegistrant(db, question.id)).toBe(BOARD_WORKER_ID);
  expect(nextSlotTask(db)).toBeUndefined();
  db.close();
});

it("続行・再分解は子の前提の破綻が開いていない親を拒み、破綻が開いている間の素の decompose は再分解へ案内して拒む", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a] = agentDecompose(db, parent, "A");

  expect(() => continueDecomposition(db, getTask(db, parent.id)!, "line", "tako", at)).toThrow(DomainError);
  expect(() => redecompose(db, getTask(db, parent.id)!, { reason: "r", children: [spec("X")] }, "tako", at)).toThrow(DomainError);
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at);
  expect(() => agentDecompose(db, parent, "X")).toThrow(/redecompose/);
  db.close();
});

it("再分解は破綻した判断の未決着の子を宣言の出自つきで cancel して新しい判断の子を登録し、子の登録が失敗すれば旧い子も破綻も残る", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a, , c] = agentDecompose(db, parent, "A", "B", "C");
  completeTask(db, getTask(db, c!.id)!, HANDOFF, "tako", at);
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at);

  expect(() =>
    redecompose(db, getTask(db, parent.id)!, { reason: "replan", children: [{ ...spec("X"), tier: "bogus" }] }, "tako", at),
  ).toThrow(DomainError);
  expect(taskHistory(db, parent.id)).toEqual([
    {
      decision: "split T",
      children: [
        expect.objectContaining({ title: "A", status: "held", premise_breach: "module M is broken" }),
        expect.objectContaining({ title: "B", status: "held" }),
        expect.objectContaining({ title: "C", status: "done" }),
      ],
    },
  ]);

  redecompose(db, getTask(db, parent.id)!, { reason: "replan around M", children: [spec("X")] }, "tako", at);

  const breach = { title: "A", reason: "module M is broken" };
  expect(taskHistory(db, parent.id)).toEqual([
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
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at);

  continueDecomposition(db, getTask(db, parent.id)!, "M is fine", "tako", at);

  expect(taskHistory(db, parent.id, a!.id)).toEqual([
    { decision: "split T", children: [expect.not.objectContaining({ premise_breach: expect.anything() })] },
    { decision: "M is fine", children: [] },
  ]);
  db.close();
});

it("破綻の question が立っている間、その木への直接 cancel は拒まれる", () => {
  const db = openDb(":memory:");
  const parent = root(db);
  const [a] = humanDecomposeTask(db, parent, { reason: "human split", children: [spec("A"), spec("B")] }, at);
  declarePremiseBreach(db, getTask(db, a!.id)!, "module M is broken", "tako", at);

  expect(() => cancelTaskDirectly(db, getTask(db, parent.id)!, null, at, {})).toThrow(/answer it/);
  db.close();
});
