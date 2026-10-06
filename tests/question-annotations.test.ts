import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { answerQuestion, approvalAnnotation, getTask, needsComment, type RegisterTaskInput, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

// question の注釈 approval / needs_comment の規則(issue #757・ADR 0179 決定4)を domain 層で1度だけ述べる。
// サーバ境界(tests/approval-annotation.test.ts)は口が同じ注釈を写すことだけを見る(ADR 0107)。

const at = new Date("2026-10-01T00:00:00.000Z");

function board() {
  const db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const question = (extra: Partial<RegisterTaskInput>) =>
    registerTask(
      db,
      {
        type: "question",
        title: "q",
        purpose: "p",
        completion_criteria: "a human answer is recorded",
        parent_id: parent.id,
        question: [{ title: "t", options: ["approve", "reject"], recommendation: "approve" }],
        ...extra,
      },
      at,
      ...HUMAN_WEBUI,
    );
  const approval = (title: string, child: { risk_flag?: boolean; assignee?: string } = {}) =>
    question({ pending_child: { title, purpose: "p", completion_criteria: "c", ...child } });
  return { db, parent, question, approval };
}

it("承認 question でなければ approval 注釈は null", () => {
  const { db, question } = board();

  expect(approvalAnnotation(db, question({}))).toBeNull();
});

it("risk ありの子 × risk なしの親の承認 question は、approve で親の risk が上がると注釈する", () => {
  const { db, approval } = board();

  expect(approvalAnnotation(db, approval("migrate", { risk_flag: true }))).toEqual({ raises_parent_risk: true });
});

it("親が既に risk ありなら親の risk は上がらないと注釈する —— 登録時でなく現在の親に当てる(approve と注釈は同じ判定)", () => {
  const { db, parent, approval } = board();
  const first = approval("migrate", { risk_flag: true });
  const second = approval("rotate", { risk_flag: true });
  expect(approvalAnnotation(db, first)).toEqual({ raises_parent_risk: true });

  // 1つ目の approve が親の risk を実際に上げる
  answerQuestion(db, first, ["approve"], at, undefined, undefined, undefined, "webui");
  expect(getTask(db, parent.id)!.risk_flag).toBeTruthy();

  expect(approvalAnnotation(db, second)).toEqual({ raises_parent_risk: false });
});

it("assignee だけが理由の子(risk_flag なし)の承認 question は、親の risk は上がらないと注釈する", () => {
  const { db, approval } = board();

  expect(approvalAnnotation(db, approval("tune", { assignee: "dba-specialist" }))).toEqual({ raises_parent_risk: false });
});

it("理由必須の選択肢 needs_comment は memory 提案で reject と defer、routing / registry 提案と承認 question で reject、ほかは空", () => {
  const { question, approval } = board();
  const memory = question({ proposal: { kind: "memory", op: "approve", candidate_id: 1, replaces: [] } });
  const routing = question({ proposal: { kind: "routing", op: "promote", pin: { promoted: false } } });
  const registry = question({
    proposal: { kind: "registry", op: "agent_tier", agent: "reef-crab", to: 1, pin: { tier: 2, rows: [] }, evidence: [1] }, // 段は id(種の economy / standard)
  });

  expect(needsComment(memory)).toEqual(["reject", "defer"]);
  expect(needsComment(routing)).toEqual(["reject"]);
  expect(needsComment(registry)).toEqual(["reject"]);
  expect(needsComment(approval("migrate", { risk_flag: true }))).toEqual(["reject"]);
  expect(needsComment(question({}))).toEqual([]);
});
