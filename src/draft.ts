/** Structured fields an LLM drafts from a free-text brain dump (issue #12),
 *  shaped to match RegisterTaskInput 1:1 — the drafted response POSTs
 *  straight into /api/tasks unmodified (same registration API/data model
 *  the plain-form fallback uses). */
export interface TaskDraft {
  title: string;
  purpose: string;
  completion_criteria: string;
  assignee?: string;
  workspace?: string;
  risk_flag?: boolean;
}

/** The LLM-facing seam (issue #12): everything vendor-specific (which model,
 *  how the prompt is built, how JSON is extracted from its output) stays
 *  behind this one call, same shape as GitHubClient/WorkerAdapter. */
export interface DraftClient {
  draftTask(dump: string): Promise<TaskDraft>;
}
