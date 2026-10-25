import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { questionAnnotations } from "../src/memory.js";
import { type RegisterTaskInput, recordPrNumber, registerTask } from "../src/tasks.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import { HUMAN_WEBUI } from "./harness.js";

// 自由記述を受けるかは盤面が決めて読み口に載せる(issue #1309・ADR 0179 決定4)。門(assertAnswerable)が
// 選択肢にない回答を断る固定選択肢の question は false、escalate と確認型 question(quarantine 解除)は true。

const at = new Date("2026-10-01T00:00:00.000Z");
const QUESTIONS = {
  merge: { options: ["merge", "hold"], question_kind: { kind: "pr_merge", pr: 7 } },
  "local merge": { options: ["merge", "hold"], question_kind: { kind: "local_merge", task_id: "t-1" } },
  "PR promotion": { options: ["retry", "abandon promotion"], question_kind: { kind: "pr_promotion_retry", task_id: "t-1" } },
  "pending child": { options: ["approve", "reject"], question_kind: { kind: "approval", pending_child: { title: "B", purpose: "p", completion_criteria: "c" } } },
  proposal: { options: ["approve", "reject"], question_kind: { kind: "proposal", proposal: { kind: "routing", op: "promote", evidence: [1], pin: { promoted: false } } } },
  "cancel option": { options: ["retry", "abandon"], question_kind: { kind: "failure", cancel_option: "abandon" } },
  escalate: { options: ["a", "b"] },
  quarantine: { options: ["repaired by hand"], question_kind: { kind: "quarantine", quarantine: "agent", value: "navigator" } },
  // 停止の理由 question は肢も推奨も持たない(ADR 0310 決定7)
  "stop reason": { options: [], question_kind: { kind: "stop_reason", task_id: "t-1" } },
} satisfies Record<string, Partial<RegisterTaskInput> & { options: string[] }>;

function freeTextOf(kind: keyof typeof QUESTIONS) {
  const db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  // merge question は PR 7 を開いた根から立つ(ADR 0265)
  recordPrNumber(db, parent.id, 7);
  const { options, ...fields } = QUESTIONS[kind];
  const question = registerTask(
    db,
    {
      type: "question",
      title: "q",
      purpose: "p",
      completion_criteria: "a human answer is recorded",
      parent_id: parent.id,
      question: [{ title: "t", options, ...(options[0] !== undefined && { recommendation: options[0] }) }],
      ...fields,
    },
    at,
    BOARD_WORKER_ID,
    "webui",
  );
  return questionAnnotations(db, question).free_text;
}

it.each(["merge", "local merge", "PR promotion", "pending child", "proposal", "cancel option"] as const)(
  "固定選択肢の %s question は自由記述を受けない(free_text: false)",
  (kind) => {
    expect(freeTextOf(kind)).toBe(false);
  },
);

it.each(["escalate", "quarantine", "stop reason"] as const)("%s question は自由記述を受ける(free_text: true)", (kind) => {
  expect(freeTextOf(kind)).toBe(true);
});
