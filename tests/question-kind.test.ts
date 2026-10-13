import { expect, it } from "vitest";
import { type QuestionKind, questionColumns, questionKindOf } from "../src/question-kind.js";

// question の種類の写し(ADR 0246 決定2・3)を domain 層で述べる。書き手・分岐の振る舞いは既存のテストが見る。

const kinds: QuestionKind[] = [
  { kind: "escalation" },
  { kind: "failure", cancel_option: "abandon" },
  { kind: "premise_breach", cancel_option: "abandon", breached_decision: 7 },
  { kind: "approval", pending_child: { title: "B", purpose: "p", completion_criteria: "c", risk_flag: true } },
  { kind: "pr_merge", pr: 12 },
  { kind: "local_merge", task_id: "t-1" },
  { kind: "pr_promotion_retry", task_id: "t-2" },
  { kind: "proposal", proposal: { kind: "memory", op: "approve", candidate_id: 1, replaces: [] } },
  { kind: "quarantine", quarantine: "agent", value: "navigator" },
  { kind: "quarantine", quarantine: "registryReachability", value: null },
  { kind: "cli_auth_expiry_warning", expiry: 1_800_000_000_000 },
];

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
