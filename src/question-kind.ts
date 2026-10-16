import type { PendingChildSpec, QuestionProposal, Task, TierRef } from "./tasks.js";
import type { TierId } from "./tier.js";

/** question の種類(ADR 0246 決定2)。表は種類ごとの列のままで、判別子はこの union だけが持つ。書く側(`questionColumns`)と
 *  読む側(`questionKindOf`)は対で、種類を足すと両方の腕と、読む側の結果で分岐する switch が tsc のエラーになる。 */
export type QuestionKind<T extends TierRef = TierId> =
  /** agent の escalate(mcp.ts)。種類別の列を持たない。 */
  | { kind: "escalation" }
  /** watchdog の kill と scheduler の issue-gone(escalateTask 経由、ADR 0006)。cancel_option で答えると分解判断ごとの abandon。 */
  | { kind: "failure"; cancel_option: string }
  /** abandon の範囲は宣言者の分解判断ごと(ADR 0121)。受験者は分解判断に乗らないので宣言できない(ADR 0267 決定7)。 */
  | { kind: "premise_breach"; cancel_option: string; breached_decision: number }
  /** Interview の root の probe の破綻の報告(ADR 0251): reason は root が書いた理由で、retry が新しい root に見せる。 */
  | { kind: "broken_probe"; reason: string }
  /** decomposeTask の承認 question(issue #11)。approve で pending_child を実体化する。 */
  | { kind: "approval"; pending_child: PendingChildSpec }
  /** recordPrOpened の escalate の枝(issue #11): pr はこの question が代わりに立つ PR 番号。 */
  | { kind: "pr_merge"; pr: number }
  /** landing.ts(ADR 0053): task_id はローカルだけのブランチが merge / hold を待つ完了済みの task。 */
  | { kind: "local_merge"; task_id: string }
  /** landing.ts(issue #66): task_id は PR 昇格に失敗した完了済みの task。 */
  | { kind: "pr_promotion_retry"; task_id: string }
  /** memory.ts・routing-review.ts の提案 question(ADR 0120 決定4)。副種別は proposal の kind / op に残す。 */
  | { kind: "proposal"; proposal: QuestionProposal<T> }
  /** quarantine.ts の Confirmation question(ADR 0137 決定2)。quarantine の語彙は quarantine.ts にあり、この向きには依存しないので開いた文字列。 */
  | { kind: "quarantine"; quarantine: string; value: string | null }
  /** cli-auth.ts(ADR 0075): expiry は警告した設定上の期限(epoch)。 */
  | { kind: "cli_auth_expiry_warning"; expiry: number };

const COLUMNS = [
  "question_cancel_option",
  "question_breached_decision",
  "question_broken_probe_reason",
  "question_pending_child",
  "question_proposal",
  "question_pending_merge_pr",
  "question_pending_local_merge_task_id",
  "question_pending_pr_promotion_task_id",
  "question_quarantine_kind",
  "question_quarantine_value",
  "question_cli_auth_expiry_warning",
] as const;

export type QuestionColumns<T extends TierRef = TierId> = Pick<Task, Exclude<(typeof COLUMNS)[number], "question_proposal">> & {
  question_proposal: QuestionProposal<T> | null;
};

/** 書く側: 種類 → 種類別の列。2つの種類の列を同時に埋める道は無い。 */
export function questionColumns<T extends TierRef>(kind: QuestionKind<T>): QuestionColumns<T> {
  const none = Object.fromEntries(COLUMNS.map((column) => [column, null])) as Record<(typeof COLUMNS)[number], null>;
  switch (kind.kind) {
    case "escalation":
      return none;
    case "failure":
      return { ...none, question_cancel_option: kind.cancel_option };
    case "premise_breach":
      return { ...none, question_cancel_option: kind.cancel_option, question_breached_decision: kind.breached_decision };
    case "broken_probe":
      return { ...none, question_broken_probe_reason: kind.reason };
    case "approval":
      return { ...none, question_pending_child: kind.pending_child };
    case "pr_merge":
      return { ...none, question_pending_merge_pr: kind.pr };
    case "local_merge":
      return { ...none, question_pending_local_merge_task_id: kind.task_id };
    case "pr_promotion_retry":
      return { ...none, question_pending_pr_promotion_task_id: kind.task_id };
    case "proposal":
      return { ...none, question_proposal: kind.proposal };
    case "quarantine":
      return { ...none, question_quarantine_kind: kind.quarantine, question_quarantine_value: kind.value };
    case "cli_auth_expiry_warning":
      return { ...none, question_cli_auth_expiry_warning: kind.expiry };
  }
}

/** 読む側: 列 → 種類。どの種類にも当てはまらない組み合わせは、埋まっている列を名指して投げる(ADR 0246 決定3)——
 *  書く側が union なので、ここに届くのは写しの不具合か直接の SQL だけ。 */
export function questionKindOf<T extends TierRef>(q: QuestionColumns<T>): QuestionKind<T> {
  const filled = COLUMNS.filter((column) => q[column] !== null).join(" + ");
  switch (filled) {
    case "":
      return { kind: "escalation" };
    case "question_cancel_option":
      return { kind: "failure", cancel_option: q.question_cancel_option! };
    case "question_cancel_option + question_breached_decision":
      return { kind: "premise_breach", cancel_option: q.question_cancel_option!, breached_decision: q.question_breached_decision! };
    case "question_broken_probe_reason":
      return { kind: "broken_probe", reason: q.question_broken_probe_reason! };
    case "question_pending_child":
      return { kind: "approval", pending_child: q.question_pending_child! };
    case "question_proposal":
      return { kind: "proposal", proposal: q.question_proposal! };
    case "question_pending_merge_pr":
      return { kind: "pr_merge", pr: q.question_pending_merge_pr! };
    case "question_pending_local_merge_task_id":
      return { kind: "local_merge", task_id: q.question_pending_local_merge_task_id! };
    case "question_pending_pr_promotion_task_id":
      return { kind: "pr_promotion_retry", task_id: q.question_pending_pr_promotion_task_id! };
    case "question_quarantine_kind":
    case "question_quarantine_kind + question_quarantine_value":
      return { kind: "quarantine", quarantine: q.question_quarantine_kind!, value: q.question_quarantine_value };
    case "question_cli_auth_expiry_warning":
      return { kind: "cli_auth_expiry_warning", expiry: q.question_cli_auth_expiry_warning! };
  }
  throw new Error(`question columns fit no question kind: ${filled}`);
}
