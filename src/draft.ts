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

/** The LLM-facing seam (issue #12): everything vendor-specific (which model,
 *  how the prompt is built, how JSON is extracted from its output) stays
 *  behind this one call, same shape as GitHubClient/WorkerAdapter. */
export interface DraftClient {
  draftTask(dump: string): Promise<TaskDraft>;
}
