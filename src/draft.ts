import type { HandoffDoc } from "./tasks.js";

/** Structured fields an LLM drafts from a free-text brain dump (issue #12).
 *  Every field here is a RegisterTaskInput field of the same name — the
 *  drafted response POSTs straight into /api/tasks by adding only `type`
 *  (not drafted; the registration screen's own state), same registration
 *  API/data model the plain-form fallback uses. */
export interface TaskDraft {
  title: string;
  purpose: string;
  completion_criteria: string;
  assignee?: string;
  workspace?: string;
  risk_flag?: boolean;
  review_flag?: boolean;
}

/** A partial subset of HandoffDoc's 6 fields, drafted by an LLM from a
 *  free-text/voice dump (issue #13). Never enforced — a human task's
 *  completion doc stays fully optional (completeTask's own exemption); this
 *  only saves typing, with missing fields surfaced as a warning by the
 *  caller (HANDOFF_FIELDS minus this object's keys), not by the client. */
export type HandoffDraft = Partial<HandoffDoc>;

/** The LLM-facing seam (issue #12, extended by #13): everything vendor-
 *  specific (which model, how the prompt is built, how JSON is extracted
 *  from its output) stays behind these calls, same shape as
 *  GitHubClient/WorkerAdapter. */
export interface DraftClient {
  draftTask(dump: string): Promise<TaskDraft>;
  draftHandoff(dump: string): Promise<HandoffDraft>;
}
