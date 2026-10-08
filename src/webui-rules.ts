export { normalizeText, whyBlank } from "./required-text.js";

// 完了時レビューが立つかの規則の正本(ADR 0111 追記8)。サーバーの拒否・完了時の起票・WebUI の欄の出し分けが
// 同じ関数を呼ぶ。WebUI へは scripts/build-webui-bundle.mjs が bundle して `TidepoolRules` として届ける(ADR 0209)ので、
// ここから届くファイルは DB や fs に触れてはならない。
import { HUMAN_WORKER_ID } from "./worker-id.js";

export interface ReviewSubject {
  type: string;
  /** ルートかどうかは親の有無で決まる。 */
  parent_id?: string | null;
  /** 空・未指定は既定の agent で、human でない側に入る。 */
  assignee?: string | null;
  review_flag?: boolean | number | null;
  risk_flag?: boolean | number | null;
}

/** 完了時レビューが立たない理由(拒否の文の後半)。立つなら undefined。 */
export function whyNoCompletionReview(t: ReviewSubject): string | undefined {
  if (t.type !== "work") return "completion review fires for work tasks only";
  if (t.assignee === HUMAN_WORKER_ID) return "completion review does not fire for a task assigned to human";
  if (t.parent_id && !t.review_flag && !t.risk_flag) {
    return "a child task's completion raises a review only with review_flag or risk_flag";
  }
  return undefined;
}

/** review_flag が意味を持たない理由。持つなら undefined。 */
export function whyReviewFlagIsInert(t: ReviewSubject): string | undefined {
  if (t.type === "work" && !t.parent_id) return "every root is already reviewed on completion";
  return whyNoCompletionReview({ ...t, review_flag: true });
}

export const completionReviewFires = (t: ReviewSubject): boolean => whyNoCompletionReview(t) === undefined;
export const reviewFlagCarriesMeaning = (t: ReviewSubject): boolean => whyReviewFlagIsInert(t) === undefined;
