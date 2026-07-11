import { describe, expect, it } from "vitest";
import { buildQuestionPushPayload } from "../src/push.js";
import type { Task } from "../src/tasks.js";

function questionTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "q-1",
    type: "question",
    status: "todo",
    assignee: null,
    workspace: null,
    title: "workspace を quarantine 解除していい?",
    purpose: "registry に復活していることを確認済み",
    completion_criteria: "n/a",
    risk_flag: false,
    review_flag: false,
    parent_id: null,
    sort_key: 0,
    handoff_doc: null,
    pr_number: null,
    question_items: [
      { title: "workspace を quarantine 解除していい?", options: ["approve", "reject"], recommendation: "approve" },
    ],
    question_answer: null,
    question_cancel_option: null,
    question_pending_child: null,
    question_pending_merge_pr: null,
    question_quarantine_workspace: null,
    question_quarantine_agent: null,
    created_at: new Date(0).toISOString(),
    ...overrides,
  } as Task;
}

describe("buildQuestionPushPayload(issue #14): 通知タップで単発回答ビューへのディープリンク", () => {
  it("タイトルにタスク名、本文に purpose、url に質問へのディープリンクを含む", () => {
    const task = questionTask();
    expect(buildQuestionPushPayload(task)).toEqual({
      title: "workspace を quarantine 解除していい?",
      body: "registry に復活していることを確認済み",
      url: "/?question=q-1",
    });
  });
});
