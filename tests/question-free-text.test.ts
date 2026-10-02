import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { questionAnnotations } from "../src/memory.js";
import { BOARD_WORKER_ID, type RegisterTaskInput, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

// 自由記述を受けるかは盤面が決めて読み口に載せる(issue #1309・ADR 0179 決定4)。門(assertAnswerable)が
// 選択肢にない回答を断る固定選択肢の question は false、escalate と確認型 question(quarantine 解除)は true。

const at = new Date("2026-10-01T00:00:00.000Z");
const QUESTIONS = {
  merge: { options: ["merge", "hold"], pending_merge_pr: 7 },
  "local merge": { options: ["merge", "hold"], pending_local_merge_task_id: "t-1" },
  "PR promotion": { options: ["retry", "abandon promotion"], pending_pr_promotion_task_id: "t-1" },
  "pending child": { options: ["approve", "reject"], pending_child: { title: "B", purpose: "p", completion_criteria: "c" } },
  proposal: { options: ["approve", "reject"], proposal: { kind: "routing", op: "promote", pin: { promoted: false } } },
  "cancel option": { options: ["retry", "abandon"], cancel_option: "abandon" },
  escalate: { options: ["a", "b"] },
  quarantine: { options: ["repaired by hand"], quarantine: { kind: "agent", value: "navigator" } },
} satisfies Record<string, Partial<RegisterTaskInput> & { options: string[] }>;

function freeTextOf(kind: keyof typeof QUESTIONS) {
  const db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const { options, ...fields } = QUESTIONS[kind];
  const question = registerTask(
    db,
    {
      type: "question",
      title: "q",
      purpose: "p",
      completion_criteria: "a human answer is recorded",
      parent_id: parent.id,
      question: [{ title: "t", options, recommendation: options[0]! }],
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

it.each(["escalate", "quarantine"] as const)("%s question は自由記述を受ける(free_text: true)", (kind) => {
  expect(freeTextOf(kind)).toBe(true);
});
