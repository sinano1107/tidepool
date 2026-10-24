import { expect, it } from "vitest";
import { type QuestionKind, questionColumns, questionKindOf } from "../src/question-kind.js";

// question の種類の写し(ADR 0246 決定2・3)を domain 層で述べる。書き手・分岐の振る舞いは既存のテストが見る。

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
