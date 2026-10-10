export { whyInvalidClockTime } from "./clock-time.js";
export { EFFORT_LEVELS, whyInvalidEffort } from "./effort.js";
export { whyInvalidOffset } from "./pace-offset-rule.js";
export { whyNotPositiveInteger } from "./positive-integer.js";
export { whyInvalidPrice } from "./price.js";
export { whyInvalidProviderRank } from "./provider.js";
export { whyInvalidRegistryName } from "./registry-name.js";
export { normalizeText, whyBlank } from "./required-text.js";
export { whyInvalidSkillAllowlist } from "./skill-allowlist.js";
export { isSettled } from "./task-status.js";

// 完了時レビューが立つかの規則の正本(ADR 0111 追記8)。サーバーの拒否・完了時の起票・WebUI の欄の出し分けが
// 同じ関数を呼ぶ。WebUI へは scripts/build-webui-bundle.mjs が bundle して `TidepoolRules` として届ける(ADR 0209)ので、
// ここから届くファイルは DB や fs に触れてはならない。
import { normalizeText } from "./required-text.js";
import { HUMAN_WORKER_ID } from "./worker-id.js";

/** 原文欄のラベルの言語 = 申告を送らない WebUI の書き込みにサーバが付ける言語(ADR 0230 決定4、写しの一致は ADR 0223 決定2)。
 *  欄の原文が写した原文のどれかと一致すればその言語、書き換えたら今の表示言語。Knowledge / Behavior / Definition は title と
 *  text の組で、Exemplar の注釈は title を持たず text だけで比べる。一致した相手の言語が割れる端は追わない(先に一致した1件)。 */
export function originalLabelLanguage(
  typed: { title?: string; text: string },
  copied: ReadonlyArray<{ title?: string; text: string; language: string } | null | undefined>,
  current: string,
): string {
  const title = typed.title === undefined ? undefined : normalizeText(typed.title);
  return copied.find((c) => c?.text === normalizeText(typed.text) && c.title === title)?.language ?? current;
}

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

/** tier / priority が意味を持たない理由。持つなら undefined。review task の要求は review_tier だけである
 *  (ADR 0111 追記10)。登録の拒否と #1552 の Edit が同じ関数を呼ぶ。 */
export function whyExecutionRequestIsInert(t: Pick<ReviewSubject, "type">): string | undefined {
  return t.type === "review" ? "a review task runs at its review_tier; tier and priority are for work tasks only" : undefined;
}

export const completionReviewFires = (t: ReviewSubject): boolean => whyNoCompletionReview(t) === undefined;
export const reviewFlagCarriesMeaning = (t: ReviewSubject): boolean => whyReviewFlagIsInert(t) === undefined;
