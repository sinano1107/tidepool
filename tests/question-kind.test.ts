import { expect, it, onTestFinished } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { openDb } from "../src/db.js";
import { type QuestionKind, questionColumns, questionKindOf } from "../src/question-kind.js";
import { registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI } from "./harness.js";

// question の種類の写し(ADR 0246 決定2・3)と、種類で分かれる登録の門の肢の数(ADR 0310 決定7)を domain 層で述べる。
// それ以外の書き手・分岐の振る舞いは既存のテストが見る。

// 種類で鍵を張るので、union に種類を足すとここが tsc のエラーになり、往復のテストが読む側の腕の書き漏れを捕まえる
const examples: { [K in QuestionKind["kind"]]: Extract<QuestionKind, { kind: K }>[] } = {
  stop_reason: [{ kind: "stop_reason", task_id: "stopped-task" }],
  escalation: [{ kind: "escalation" }],
  failure: [{ kind: "failure", cancel_option: "abandon" }],
  premise_breach: [{ kind: "premise_breach", cancel_option: "abandon", breached_decision: 7 }],
  broken_probe: [{ kind: "broken_probe", reason: "the probe leaks the expected output" }],
  approval: [{ kind: "approval", pending_child: { title: "B", purpose: "p", completion_criteria: "c", risk_flag: true } }],
  pr_merge: [{ kind: "pr_merge", pr: 12 }],
  local_merge: [{ kind: "local_merge", task_id: "t-1" }],
  pr_promotion_retry: [{ kind: "pr_promotion_retry", task_id: "t-2" }],
  proposal: [{ kind: "proposal", proposal: { kind: "memory", op: "approve", candidate_id: 1, replaces: [] } }],
  quarantine: [
    { kind: "quarantine", quarantine: "agent", value: "navigator" },
    { kind: "quarantine", quarantine: "registryReachability", value: null },
  ],
  cli_auth_expiry_warning: [{ kind: "cli_auth_expiry_warning", expiry: 1_800_000_000_000 }],
};
const kinds: QuestionKind[] = Object.values(examples).flat();

it.each(kinds.map((kind) => [kind.kind, kind] as const))("%s は 列 → 種類 で元に戻る", (_, kind) => {
  expect(questionKindOf(questionColumns(kind))).toEqual(kind);
});

it("どの種類にも当てはまらない列の組み合わせは、埋まっている列を名指して投げる", () => {
  const none = questionColumns({ kind: "escalation" });

  expect(() => questionKindOf({ ...none, question_breached_decision: 7 })).toThrow("question_breached_decision");
  expect(() =>
    questionKindOf({ ...none, question_pending_merge_pr: 12, question_proposal: { kind: "memory", op: "approve", candidate_id: 1, replaces: [] } }),
  ).toThrow("question_proposal + question_pending_merge_pr");
  expect(() => questionKindOf({ ...none, question_quarantine_value: "navigator" })).toThrow("question_quarantine_value");
});

// 肢 0 個は stop_reason だけの例外(ADR 0310 決定7)—— 他の種別は従来どおり拒み、stop_reason も肢を持てば拒む
function registerQuestion(kind: QuestionKind | undefined, options: string[]) {
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const parent = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, new Date(0), ...HUMAN_WEBUI);
  return () => registerTask(db, {
    type: "question", title: "q", purpose: "p", completion_criteria: "c", parent_id: parent.id,
    question: [{ title: "q", options, ...(options.length > 0 && { recommendation: options[0] }) }],
    ...(kind && { question_kind: kind }),
  }, new Date(0), BOARD_ACTOR_ID, "board");
}

it.each([
  ["escalation", undefined],
  ["failure", { kind: "failure", cancel_option: "abandon" }],
] as const)("%s の項目は肢 0 個では登録できない", (_, kind) => {
  expect(registerQuestion(kind, [])).toThrow("a question item carries 2 to 4 options");
});

it("stop_reason の項目は肢を持つと登録できない", () => {
  expect(registerQuestion({ kind: "stop_reason", task_id: "t" }, ["a", "b"])).toThrow("a stop reason question item carries no options and no recommendation");
});
