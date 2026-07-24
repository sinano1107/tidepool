import type { Issue } from "./github.js";
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

/** Read-only context a child's AI draft is fed when drafted from a parent's
 *  "add child" screen (issue #129 point 4): the parent's own content, its
 *  existing children's titles (so a fresh child doesn't duplicate one
 *  already split off), and the human's own decompose reason if they wrote
 *  one before drafting. Nothing here is ever stored — it only steers the one
 *  prompt that produces this draft. */
export interface ChildDraftContext {
  parentTitle: string;
  parentPurpose: string;
  parentCompletionCriteria: string;
  siblingTitles: string[];
  decomposeReason?: string;
}

/** A partial subset of HandoffDoc's 6 fields, drafted by an LLM from a
 *  free-text/voice dump (issue #13). Never enforced — a human task's
 *  completion doc stays fully optional (completeTask's own exemption); this
 *  only saves typing, with missing fields surfaced as a warning by the
 *  caller (HANDOFF_FIELDS minus this object's keys), not by the client. */
export type HandoffDraft = Partial<HandoffDoc>;

/** The registration gate's verdict (issue #49 設計点4): can title / purpose /
 *  completion_criteria be derived from this issue? A failing verdict always
 *  carries what's missing plus a drafted issue comment that would fill the
 *  gap — the union makes a suggestion-less rejection unrepresentable, since
 *  the UI's whole rejection flow (提示 → 承認 → issue にコメント追記) hangs
 *  off those two fields. The comment is surfaced for the human to approve,
 *  never posted to GitHub without that approval (the board holds no content
 *  of its own; the fix lands as an issue comment, ADR 0016). */
export type IssueInspection =
  | { ok: true }
  | { ok: false; missing: string; suggested_comment: string };

/** The LLM-facing seam (issue #12, extended by #13 and #49): everything
 *  vendor-specific (which model, how the prompt is built, how JSON is
 *  extracted from its output) stays behind these calls, same shape as
 *  GitHubClient/WorkerAdapter. */
export interface DraftClient {
  /** language: the board's display language (issue #46), read fresh by the
   *  caller at each use — steers only the connective prose the model adds,
   *  never the fragments carried over from the dump. */
  draftTask(dump: string, language: string, context?: ChildDraftContext): Promise<TaskDraft>;
  draftHandoff(dump: string, language: string): Promise<HandoffDraft>;
  inspectIssue(issue: Issue): Promise<IssueInspection>;
}
