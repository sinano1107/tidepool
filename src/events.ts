import type { Allocation } from "./allocation-review.js";
import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import type { ExecutionSettingRow, ExecutionSettingsChange, ProviderSource, registryPinChanges, routingPinChanges, Tier, TierSource } from "./execution-setting.js";
import type { InvalidationReason, MemoryDropReason, MemoryEntryFields } from "./memory.js";
import { sessionSpawnOf } from "./precedent.js";
import type { Provider } from "./registry.js";
import type { MemoryProposal, ProposalAmendment, TaskType } from "./tasks.js";
import { entryObjections } from "./triage.js";

/** 行の拒否の証拠の種類: Provider が id を 404 で断った(ADR 0184 決定3)/ CLI の版が model の最低版に
 *  届かない(result 行の `api_error_code: claude_code_version_too_old`、ADR 0187 決定1)。 */
export type RowRefusalCause = "api_404" | "cli_version_too_old";

/** 行の拒否(ADR 0184 決定4): Provider が断った spawn 時の行と、その session の worker_spawned。 */
export interface RowRefusal {
  provider: Provider;
  model: string;
  worker_spawned_event_id: number;
  cause: RowRefusalCause;
}

/** What the advisor **actually did** in one worker session (issue #33 判断6),
 *  as against `worker_spawned.advisor`'s "what the board asked for". Carried by
 *  `worker_exited.usage.advisor`, where null means no consultation was observed
 *  at all — see that field for what the null deliberately collapses.
 *
 *  Named rather than inlined because the adapter builds it in two pieces and
 *  would otherwise spell `NonNullable<NonNullable<…>["advisor"]>` at each. */
export interface AdvisorRecord {
  /** The resolved model id the advisor actually ran as — `opus` resolves
   *  differently per host CLI version (measured), so the alias in
   *  worker_spawned does not settle it. null when the session consulted but
   *  the CLI reported no resolved id: the result line names it only for the
   *  **final turn**, so a session whose last consultation came earlier leaves
   *  it unrecorded. Deriving it from the per-model cost breakdown is not
   *  available either — that breakdown can hold the CLI's internal helper
   *  model too, so subtracting the main model does not leave one answer. */
  model: string | null;
  /** How many times the parent thread consulted, counted off the stream. Kept
   *  outside `usage` because it survives the cases `usage` does not, and
   *  because cost alone cannot tell "one consultation in a long conversation"
   *  from "three in a short one".
   *
   *  It counts the **parent thread only** — a **subagent's own advisor
   *  consultations** never appear in the parent's stream (measured 2026-08-04,
   *  issue #33; not re-verified against the 2.1.237 fixture of issue #386)
   *  while their cost still lands in the session total, so this and `usage`
   *  have different denominators and **`usage` is not divisible by
   *  `consultations`**: any per-consultation cost derived from the pair is
   *  wrong. By the same asymmetry, a session where only subagents consulted
   *  reports the whole record as null while its advisor cost is still inside
   *  `estimated_cost_usd`.
   *
   *  The narrow subject matters: the subagent's *other* activity — its prompt,
   *  its `tool_use` and `tool_result` — **does** appear in the parent's stream,
   *  carrying `parent_tool_use_id` (measured on 2.1.237, issue #386 / ADR 0083
   *  追記 2). That is what `projectEpisode` reads to flag subagent-origin
   *  actions; only the advisor block is absent. */
  consultations: number;
  /** The advisor's own slice of the session's consumption — the same shape the
   *  enclosing `usage` reports for the main model, hence the same name
   *  (CONTEXT.md's Worker session: 「トークン消費の内訳と推定ドル」). It is
   *  deliberately **not** called `spend`: this codebase already spells
   *  Spend-down(使い切り)that way, and one word for two unrelated concepts
   *  is how a glossary starts to rot.
   *
   *  null = "could not be measured", never 0 — the same posture as
   *  `usage: null` ("the session ran but filed no report"). Unmeasurable when
   *  `model` is null, when the advisor resolved to the same model as the main
   *  one (which merges both into a single per-model entry — measured), or when
   *  the main model's own resolved id was never observed, since then
   *  separability itself is unknown. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  } | null;
}

/** One model's (or the whole session's) consumption in the board's own
 *  vocabulary (ADR 0005 / issue #32) — the shape `worker_exited.usage` reports
 *  at the top level and per model id in `models`. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Codex JSONL reports tokens but no API-equivalent cost under ChatGPT auth. */
  estimated_cost_usd: number | null;
}

/** meta_review_material_injected の主題を問わない欄(ADR 0180 追記 #1239)。 */
type MetaReviewMaterialCommon = {
  kind: "meta_review_material_injected";
  worker_spawned_event_id: number;
  previous_watermark: number;
  material_watermark: number;
  tokens: number;
  tokenizer: string;
  tokenizer_version: string;
};

/** Payloads are typed per-kind; adding a kind forces the writer through this
 *  union, which is what kills the "wrote to log but forgot stats" bug class. */
export type EventPayload =
  // based_on_decision points at the decision-log entry (event id) a decomposed
  // child rests on — stamped at registration so provenance never needs a join.
  // objection_event_ids: a repair / RCA child's material objections (ADR 0171 決定1)
  | { kind: "task_registered"; type: TaskType; title: string; based_on_decision?: number; integration_review?: boolean; objection_event_ids?: number[] }
  | { kind: "decision_logged"; line: string }
  | { kind: "task_picked_up" }
  | { kind: "task_moved"; after: string | null }
  // result carries the one-line outcome against the completion criteria so the
  // log view never joins back to the task row; the handoff doc stays reachable
  // through task_id
  | { kind: "task_completed"; handoff_present: boolean; result: string | null }
  | { kind: "task_escalated"; question_id: string }
  // ADR 0121: 子が自分の乗る分解判断の前提の破綻を宣言した(人間向け kind — 判断ログに並び異議が打てる)。
  // line は宣言の理由。resolved はその宣言が閉じた帰結(question = 人間の question に渡した)。
  | { kind: "premise_breached"; line: string; based_on_decision: number }
  | { kind: "premise_breach_resolved"; outcome: "continue" | "redecompose" | "question" }
  // ADR 0104 決定4: 走行中の session が Provider の使用量上限で断られ、タスクが
  // `todo` の先頭へ戻された。失敗ではなく環境事象なので failure question は無く、
  // これが「なぜ途中で終わったか」を次のセッションへ伝える唯一の記録である
  // (CONTEXT.md「上限到達による中断」)。
  | { kind: "cap_interrupted" }
  // ADR 0184 決定4: Provider が spawn 時の行の model id を断り(行の拒否)、タスクが `todo` の先頭へ
  // 戻された。cap_interrupted は流用しない —— 上限到達による中断と読み違えないための専用の記録。
  | ({ kind: "row_refused" } & RowRefusal)
  // ADR 0073: a completed root work task had no commits to carry to its
  // protected branch. This is a board-observed fact, not a human decision.
  | { kind: "nothing_to_land"; base: string }
  // ADR 0092 / ADR 0106: 着地を1つの門(付帯子 / 未束ねの異議)で見送った事実。
  | {
      kind: "landing_deferred";
      reason: "attached_children" | "objections";
      count: number;
    }
  // issue #11: a completed work task's handoff opened this PR — pr_number is
  // the durable link the merge dial (escalate / auto_if_ci_green; `external`
  // leaves the PR to GitHub's own surface — ADR 0079) reads back
  | { kind: "pr_opened"; pr_number: number }
  // issue #11: the merge dial actually merged this PR — via the escalate
  // answer (right after a live CI check confirmed success immediately
  // beforehand) or the auto_if_ci_green poll (CI green). The actor is whose
  // judgment decided the merge: human for escalate, board for
  // auto_if_ci_green (ADR 0196)
  | { kind: "pr_merged"; pr_number: number }
  // ADR 0079 決定4: the board did NOT merge this PR — it found the PR already
  // merged on a surface it holds a decision on (an open merge question, the
  // auto-merge queue) and retired that decision. Spelled apart from pr_merged
  // on purpose: "the board merged it" and "the board observed it merged" are
  // different facts, and the narrowed canon claim (judgement is the board's
  // record only for merges the board decides) is unverifiable without the
  // distinction
  | { kind: "pr_merge_observed"; pr_number: number }
  // ADR 0092 決定3 の再発火が、PR 昇格失敗の question を人間の回答なしに引退させた
  // (issue #406)。`pr_merge_observed` と同じ「執行ではなく観測」の記録で、決着した
  // 着地そのもの(`pr_opened` / `nothing_to_land`)は question が指すタスクの側に
  // 残っているので、この行は payload を持たない
  | { kind: "pr_promotion_observed" }
  // issue #11: a risk-approval question's "approve" answer raised the
  // parent's risk_flag (upward propagation) — origin_question_id is that
  // question, so the audit trail for the flag flip never needs a join
  | { kind: "risk_flag_raised"; origin_question_id: string }
  // ADR 0006 / 0048: a task cancelled by abandon's decision-scoped cascade —
  // origin_question_id is the answered failure question, shared by every task
  // touched by the cascade (including the failed task's own subtree)
  | { kind: "task_cancelled"; origin_question_id: string }
  // ADR 0121: 再分解が破棄した旧判断の子 —— origin_breach_task_id は前提の破綻を宣言した子
  | { kind: "task_cancelled"; origin_breach_task_id: string }
  // issue #130: a human's direct cancel — the second cancel path (CONTEXT.md's
  // Cancel), no failure question above it, so reason is the human's own free
  // text (null when they gave none). Shared by every task the cascade touches
  // (the target and its unfinished descendants), same as task_cancelled above.
  | { kind: "task_cancelled_directly"; reason: string | null }
  // issue #130: a human overwrote one editable field of a registered task. The
  // edit is an append event, never a silent overwrite — `from` preserves the
  // pre-edit value in the log forever (write-path statistical purity), one
  // event per changed field. Booleans (risk_flag/review_flag) are stringified.
  | { kind: "task_edited"; field: string; from: string | null; to: string | null }
  // recommendation_accepted and recommended_by are first-class: per-agent
  // acceptance rates are a primary statistic, recorded at answer time so they
  // never need a join back through task_registered. One entry per question
  // item, in item order (issue #30) — acceptance is counted per item, not per
  // submission, so "N of M answered per recommendation" stays expressible.
  | {
      kind: "question_answered";
      answers: Array<{ answer: string; recommendation_accepted: boolean }>;
      recommended_by: string;
      // the reject-reason steering channel (issue #40) — one per submission,
      // not per item; absent entirely (not null) when the answer carried none
      comment?: string;
      // 提案の approve に添えた修正値(ADR 0150 決定2 / issue #918・ADR 0152 決定2 / issue #944)。comment と同じく無ければ欄ごと無い
      amendment?: ProposalAmendment;
    }
  // a triage objection annotates one log entry (entry_id = event id); the
  // direction comment is mandatory — silence is approval, so the only explicit
  // action carries where to go instead. session_id scopes commit-time bundling
  // to the session the objection was raised in.
  | { kind: "objection_raised"; entry_id: number; comment: string; session_id: number }
  // "this entry was put in front of the human" — the denominator of the
  // objection rate; an entry never displayed is unobserved, not approved
  | { kind: "log_entry_displayed"; entry_id: number; session_id?: number }
  // full provenance of an agent run. registry_commit is THE strict agent
  // version (ADR 0001: commit hash = agent version); definition_version is
  // only the human-readable stamp from the definition's frontmatter. The
  // vocabulary is registry-shaped, not vendor-shaped — no CLI names leak in.
  //
  // `advisor` (issue #33 判断6) is the advisor model the board actually pinned
  // for this session, verbatim as the board's execution-setting table spells
  // it (a concrete model id — ADR 0182) — board-owned text, so it does not
  // breach the line above. null means the session was launched with the advisor tool
  // explicitly disabled, which collapses two causes: the agent has no advisor
  // capability, or the host-side kill switch (判断8) was on. Recording the
  // *pinned* value rather than the frontmatter's is deliberate — the
  // frontmatter is already recoverable from registry_commit, whereas the host
  // mask is not recoverable from anything, and CONTEXT.md's Advisor requires
  // each session's effective configuration to be settleable from the event
  // history alone.
  //
  // This is what the board *asked for*, never what ran: a capability-
  // insufficient advisor is accepted at launch and silently left unattached
  // (measured). Whether it actually ran lives on the other half of the pair,
  // worker_exited.usage.advisor.
  | {
      kind: "worker_spawned";
      registry_commit: string;
      definition_version: string;
      advisor: string | null;
      /** ADR 0110 決定3: the execution setting the selector chose for this
       *  pickup — the provider it speaks, and the model / effort pinned in
       *  that provider's own notation. These are no longer recoverable from
       *  `registry_commit`: agent.md carries no compute, so the only record of
       *  what this session actually burned is here. */
      provider: Provider;
      model: string;
      effort: string;
      /** ADR 0110 決定3: **why** it was that setting — `"task"` when the
       *  task's own request column decided, `"review_tier"` for its review
       *  request, `"agent"` when the agent's `tier`
       *  did, `"board"` when the board default did. Recorded beside the values
       *  because "which model" and "who asked for it" are separate facts: the
       *  learner reads the first, a human asking "why was it this model" reads
       *  the second. It is also the only place "the default was chosen" is
       *  distinguished from "nothing was requested" (CONTEXT.md「要求」).
       *
       *  `provider` は Provider の出所(ADR 0110 決定5 / issue #544、ADR 0114 決定4):
       *  `"only"` は agent が entry を1つしか宣言していなかった、`"rank"` は残った
       *  候補から Provider 順位で選んだ、`"cost"` は task の優先順位が cost で価格が
       *  選んだ、`"learner"` は昇格した学習器が選んだ(ADR 0150 決定3)。「温存中の anthropic を避けて openai で走った」が事後に読めるのは
       *  この1値による。 */
      source: { tier: TierSource; provider: ProviderSource };
      /** ADR 0098: the Harness/version actually selected for this session. */
      harness: "claude-code" | "codex";
      cli_version: string;
    }
  // ADR 0137: a quarantine key that already has an open Confirmation question
  // fired again — recorded on that same question rather than opening a second
  // one (CONTEXT.md's Quarantine: 1資源につき確認は最大1枚)
  | { kind: "quarantine_refired"; cause: string }
  // ADR 0137 決定4: a quarantine Confirmation question's answer passed its
  // kind's check and was accepted — pickup resumes for what that kind stops.
  // ADR 0184 決定5 の門1: 行の Quarantine は、表の編集がその行を消したときにも盤面名義で
  // 決着する —— そのときだけ observed_event_id = 行を消した execution_settings_changed の id
  | { kind: "quarantine_released"; quarantine: string; value: string | null; observed_event_id?: number }
  // issue #32: pairs with worker_spawned to close out a worker session
  // (spawn~exit) — usage is null when the session ended without a final
  // stream-json `result` event (e.g. watchdog kill); the event itself is
  // always written, so a missing report never erases the session's cost.
  // estimated_cost_usd mirrors the CLI's total_cost_usd verbatim, but named
  // for the board's own vocabulary: under a subscription there is no real
  // invoice, only this run-time API-equivalent estimate.
  //
  // **The token fields and the cost field do not count the same thing**
  // (issue #33, measured 2026-08-04 — the CLI's own asymmetry, not the
  // board's choice). The token counts come from the result line's `usage`,
  // which reports the **main model on the parent thread only**; the cost
  // comes from `total_cost_usd`, which is the sum over **every model the
  // session moved** — the CLI's internal helper model, subagents, and the
  // advisor. The gap predates the advisor (the helper model's small calls),
  // but an advisor makes it large: one measured consultation was 67% of the
  // session total. The fields are left as they are so rows stay comparable
  // across the change; `advisor` below is what makes the gap readable
  // instead of silent.
  | {
      kind: "worker_exited";
      exit_code: number | null;
      signal: string | null;
      // issue #125: the tail (last ~20 lines) of the worker session's stderr,
      // where process-level failures leave their evidence. null means the
      // session wrote nothing there, keeping "quiet exit" distinguishable
      // from a broken capture. The verbatim full text is saved by the worker
      // adapter alongside its transcript (adapter-specific layout — ADR
      // 0005); this field is the event-side pointer into it.
      stderr_tail: string | null;
      // ADR 0188: the failure the CLI itself reported on stdout (Claude's
      // `is_error` result line, Codex's `turn.failed`), verbatim, last one
      // only. null means the CLI reported no failure. Display only — no
      // judgment on the board reads it (ADR 0104 決定2 / ADR 0184 決定3).
      reported_error: string | null;
      // ADR 0189: the last text the worker's root model wrote (Claude: not a
      // `<synthetic>` or subagent line; Codex: `agent_message`), verbatim, not
      // truncated. null means none was observed. Display only — no judgment on
      // the board reads it (ADR 0104 決定2 / ADR 0184 決定3).
      last_message: string | null;
      // issue #379: the id of the `worker_spawned` event that opened this
      // same session — a task can have several worker sessions (retry /
      // decompose 統合復帰 / quarantine 復帰), and the adapter now names each
      // session's transcript/stderr file `<taskId>.<this id>.stream.jsonl` /
      // `.stderr.log`, so this is what lets a reader of worker_exited
      // reconstruct which file belongs to it.
      worker_spawned_event_id: number;
      usage: TokenUsage & {
        /** issue #33 判断6: what the advisor **actually did** this session, as
         *  against worker_spawned.advisor's "what the board asked for". null
         *  means no consultation was observed at all — which deliberately
         *  collapses "configured, attached, never consulted" with
         *  "configured, silently never attached". Only a consultation is
         *  positive evidence of attachment, and the sole discriminator the
         *  CLI offers is one English warning line on stderr; matching it
         *  would be a detector that degrades silently when the vendor
         *  rewords it — the exact shape ADR 0041 exists to refuse. The two
         *  differ in cause but not in effect (neither session had an advisor
         *  influence it), so the statistics this field feeds are unharmed;
         *  the warning is still retained verbatim in stderr_tail for the
         *  operational question. */
        advisor: AdvisorRecord | null;
        /** ADR 0094 決定2: the CLI result line's per-model `modelUsage` carried
         *  as observed, keyed by the model id the CLI reports for that entry.
         *  This is raw observation, not attribution — the board does NOT
         *  infer which entry is the advisor from this breakdown (the "main
         *  vs. everything else" rule matched 7/7 in a measurement but reads
         *  the fact of a helper model having run, which this codebase does
         *  not treat as machine-observed); a reader who wants to pair a
         *  model id with the advisor does so themselves, against the
         *  session's `worker_spawned.advisor` pin (the spawn event
         *  `worker_spawned_event_id` points at). Optional and omitted
         *  (never null) when the result line carries no readable breakdown
         *  at all — a session with no models here says nothing about
         *  whether one ran, only that this field could not be filled in;
         *  same fail-closed, all-or-nothing posture as `isStreamResultEvent`. */
        models?: Record<string, TokenUsage>;
      } | null;
    }
  // issue #127: Node's spawn() itself failing (ENOENT/EACCES/PATH misconfig —
  // the child never comes into being, only an "error" event fires, never
  // "exit") — a different failure class from worker_exited, not a variant of
  // it. worker_exited(exit_code: null, signal: null) was considered and
  // rejected: a session that never had a process (ADR 0118 決定1) has no exit
  // — reusing worker_exited would fabricate the fact of an exit that did not
  // happen.
  // Node's real exits always carry a non-null code or signal, so (null, null)
  // is otherwise an impossible pair; smuggling meaning into an impossible
  // value makes the reader reverse-engineer what the pair "really" means.
  // stderr_tail also carries no evidence here (spawn failure writes nothing
  // to stderr), so the reuse would have bought nothing but a false pair.
  //
  // No `usage` field (unlike worker_exited): making it nullable would read as
  // "usage unknown" and collide with the null-usage case worker_exited
  // already has for a killed-but-real session — the field's *absence* is what
  // says "cost accounting does not apply here" rather than "cost was not
  // recorded".
  //
  // ADR 0118 決定5: a synchronous throw from `worker.start` writes this event
  // too (error_code: null, message = the caught exception), from the
  // scheduler — the observation point. Whether or not a worker_spawned pair is
  // open, the worker never ran and the failure question is answered away; this
  // event is what keeps the fact on the timeline. No reader pairs it, so an
  // unpaired spawn_failed breaks nothing.
  | { kind: "spawn_failed"; error_code: string | null; message: string }
  // ADR 0149 決定4: 走ってから transcript(stream / stderr のどちらか)が書けなくなった
  // 観測。question に答えた後もこの session の transcript が途中で切れている事実を残す。
  | {
      kind: "transcript_failed";
      error_code: string | null;
      message: string;
      file: "stream" | "stderr";
      worker_spawned_event_id: number;
    }
  // ADR 0111 決定4 / issue #547: 配分評価 —— review の verdict が確定した後、盤面が
  // Board call に問うた「この結果に対する実行設定は適切だったか」。**判断種別**の
  // 注釈であり、観測(worker_exited.usage / Precedent の行動列)とはこの kind で
  // 区別される。task_id は被レビュー task、`worker_spawned_event_id` は review の完了より前の
  // 最新 session(episode の同一性キー)。判断が返ったときだけ書く —— 撃てなかった・session の無い
  // task には何も書かず、撃って失敗したら `allocation_review_failed` だけを残す(ADR 0172 決定2)。
  // `judge` は Board call 自身の実行設定(ADR 0150 決定8)。
  | {
      kind: "allocation_reviewed";
      review_task_id: string;
      worker_spawned_event_id: number;
      judge: Pick<ExecutionSettingRow, "provider" | "model" | "effort">;
      allocation: Allocation;
      cause: Cause;
      evidence: string;
    }
  // ADR 0172 決定2: 配分評価の Board call が撃って失敗した(被レビュー task に帰属)。`review_completed_event_id` は
  // review の `task_completed` —— 撃ち直しの回数と間隔はこれで数える(ADR 0164 決定4・5)。
  | { kind: "allocation_review_failed"; review_completed_event_id: number; review_task_id: string; reviewed_task_id: string; reason: string }
  // ADR 0115 / issue #574: 帰責 —— 異議が束ねられる commit 時、盤面が Board call に
  // 問うた「この異議は誰の落ち度か」。配分評価と同じく**判断種別**の注釈で、観測
  // (objection_raised)とはこの kind で区別され、決定 log には現れない。task_id は
  // 異議されたタスク、`entry_id` は異議されたエントリ、`objection_event_ids` は出所の
  // 異議 event(すべての注釈が記録に遡れる)で、先頭がその異議群の名前(ADR 0170)。同じ異議群への2回目は新しい
  // event を追記し後が有効 —— `round` がそれを言う(`initial` = commit 時、`after_rca` = その
  // 異議群を覆う RCA 子が決着した後に findings を証拠に `uncertain` を問い直した回、#575 / ADR 0171)。entry を1つの値で読む読み手は
  // 最後の異議群の判定を読む(`currentAttributions`)。
  // どちらの回も判断が返ったときだけ書く —— 撃てなかった entry には何も書かず、撃って失敗したら
  // `objection_attribution_failed` だけを残す(ADR 0164 決定3 / ADR 0168 決定2)。初回の帰責が無い entry は
  // `uncertain` と同じく RCA を要し、第2回の対象になる(ADR 0168 決定3)。
  | {
      kind: "objection_attributed";
      entry_id: number;
      objection_event_ids: number[];
      cause: Cause;
      evidence: string;
      /** cause `memory` のとき名指された誤った entry の id(読んだ集合の内側、ADR 0166 決定3)。他の cause は null。 */
      entries: number[] | null;
      round: "initial" | "after_rca";
    }
  // ADR 0110 決定5 / issue #545: 人間が settings タブ / 管理MCP から実行設定(表の
  // 行・advisor above main・Provider 順位・優先順位の既定)を変えた操作イベント。
  // `origin` がどの手から入ったか(webui / mcp)を機械記録する(CONTEXT.md「管理MCP」)。
  // question_id = 提案 question への approve の適用(ADR 0151: meta-review の材料にも「人間が変えた行」にも数えない)。
  | ({ kind: "execution_settings_changed"; question_id?: string } & ExecutionSettingsChange)
  // ADR 0083 / spec #586 A: Memory の正本。エントリ表(memory_entries)は同じ
  // transaction で維持する投影で、この3つの再生で任意 watermark の approved 集合に
  // 戻せる。決定 log には現れない。
  // created の event id がそのままエントリの id(Knowledge は版も)。
  // question_id = 提案 question の修正値つき approve が作ったエントリの印(ADR 0151 決定3)。
  // 移動の複製(ADR 0162 決定5)と復元の複製(ADR 0163)だけが activity(写した者 —— 書き手は entry.author のまま旧から継ぐ)を持ち、
  // 移動の複製は approved なら version(旧から継いだ版)を、復元の複製は restored_from(復元元の id、版は継がない)を持つ。
  | { kind: "memory_entry_created"; entry: MemoryEntryFields; question_id?: string; activity?: MemoryEntryFields["author"]["activity"]; version?: number; restored_from?: number }
  // question_id / activity = 誰の産物かの印で、meta-review の材料判定が読む(ADR 0151 決定3)。回答が刻んだ無効化は question_id、
  // 書き込み・移動の一部として刻んだ無効化は書き手・移した者の activity(人間も持つ)。人間の直接の無効化はどちらも持たない。
  | { kind: "memory_entry_invalidated"; entry_id: number; reason: InvalidationReason; successor_id: number | null; question_id?: string; activity?: MemoryEntryFields["author"]["activity"] }
  // ADR 0120 決定3・4 / issue #620: 提案 question の approve で candidate が approved になった(版 = この event の id)。
  // replaced = pin した置換対象の id と版(後続の superseded 無効化が同じ transaction で続く)。
  | { kind: "memory_entry_approved"; entry_id: number; question_id: string; replaced: MemoryProposal["replaces"] }
  // ADR 0120 決定4 / issue #620: pin に含まれる entry が無効化され、盤面が提案 question を観測で決着させた
  // (決着させた question に帰属)。observed_event_id = その memory_entry_invalidated の id。
  | { kind: "memory_proposal_stale"; question_id: string; entry_id: number; observed_event_id: number }
  // ADR 0150 決定1 / issue #918: pin した表の行が変わった / 消えた(changed = 崩れた欄、null = 行の削除)ので、盤面が routing の
  // 提案 question を観測で決着させた(決着させた question に帰属)。observed_event_id = その execution_settings_changed の id。
  // registry の提案(issue #920)は、approve 時 / due 判定時に registry の現在値と照合して崩れた pin も決着させる —— registry の変更は
  // 盤面の event ではないので、そのとき observed_event_id は null。
  | {
      kind: "routing_proposal_stale";
      question_id: string;
      proposal_kind: "routing" | "registry";
      changed: ReturnType<typeof routingPinChanges> | ReturnType<typeof registryPinChanges>;
      observed_event_id: number | null;
    }
  // issue #920: agent の tier の提案への approve が registry の main へ commit した(盤面スコープ)。registry_commit = 着地した commit。
  // ADR 0150 決定1 が新設しないとした「registry 変更の event」ではない —— 盤面自身の書き込みの記録で、row の approve の execution_settings_changed と同じ位置。
  | { kind: "agent_tier_changed"; agent: string; from: Tier; to: Tier; question_id: string; registry_commit: string }
  // spec #586 D: worker の pull 1回(task 帰属)。返した id と snapshot watermark、search は
  // 候補ごとの落ちた理由(null = 返した)、read は求めた id のうち本文を返さなかった無効化済みの理由と見える後継
  // (ADR 0167 決定4。returned_ids はたどった先の id)。event id は tool 結果に載り、Precedent の
  // memory マーカーになる。続き(next)の呼び出しも1回の pull で、input は最初の呼び出しの引数、returned_ids はその応答で
  // 返した id だけ(ADR 0195)。
  | {
      kind: "memory_pulled";
      verb: "browse_memory" | "search_memory" | "search_memory_entries" | "read_memory" | "read_memory_entries" | "list_memory_candidates" | "list_memory_entries" | "list_memory_proposals" | "list_precedents" | "list_memory_branches";
      input: {
        prefix?: string;
        path?: string;
        query?: string;
        like?: number;
        ids?: number[];
        scope?: string | null;
        kind?: MemoryEntryFields["kind"];
        state?: MemoryEntryFields["state"] | "invalidated";
        include_invalidated?: boolean;
        since_watermark?: number;
      };
      returned_ids: number[];
      watermark: number;
      candidates?: Array<{ id: number; dropped: MemoryDropReason | null }>;
      dropped?: Array<{ id: number; reason: InvalidationReason; successor: number | null }>;
    }
  // spec #586 G: エントリ表と FTS を events から作り直した。
  // 刻んだ索引の版を持つ。
  | { kind: "memory_index_rebuilt"; tokenizer: string; preprocess_version: string }
  // spec #586 C: 人間が settings タブ / 管理MCP から memory 設定を変えた。
  | { kind: "memory_settings_changed"; injection_token_cap: number }
  // issue #924: 人間が settings タブ / 管理MCP から周期 meta-review の設定を変えた。
  | { kind: "meta_review_settings_changed"; period_days: number }
  // spec #586 C: spawn 時の注入(task 帰属、worker_spawned の直後)。注入した entry(定義を含む)の
  // id と版、組んだ時点の watermark、計数したトークン数と計数器、出した INDEX の深さ・木の全深さ・
  // 落とした関連 leaf の件数(#600 D。再生できない event なので消費者の着地を待たずに持つ)。
  // 注入ゼロでも entries 空で残す。`query` は関連 leaf を何で引いたか(ADR 0175 決定5): 英語の view で引いた
  // ならその文面、訳す対象だが訳せなかったなら理由(throttled = 撃たなかった / failed = 撃って失敗)。対象外なら欄なし。
  | {
      kind: "memory_injected";
      worker_spawned_event_id: number;
      watermark: number;
      entries: Array<{ id: number; version: number }>;
      tokens: number;
      index_depth: number;
      index_max_depth: number;
      omitted: number;
      tokenizer: string;
      tokenizer_version: string;
      query?: { view: string } | { reason: "throttled" } | { reason: "failed"; message: string };
    }
  // ADR 0180 決定2・追記 #1239: meta-review の spawn に材料の節を入れた(task 帰属、memory_injected の直後)。主題、窓の両端の
  // watermark、計数したトークン数と計数器、部分ごとに載せた id —— memory は店の変更と candidate がエントリ、異議つき判断が
  // decision の event、提案が question、枝の一覧が Definition。routing は乖離した shadow 行(learner_shadow の id)と窓の中の
  // 全 shadow 行の数とそのうち候補が2行以上あった行の数(ADR 0181 決定5)、数えた allocation_reviewed、新しいセルの初観測(worker_exited)、人間が変えた行(execution_settings_changed)、
  // 提案の question。表と設定は id を持たない。
  | (MetaReviewMaterialCommon & { subject: "memory"; store_changes: number[]; candidates: number[]; precedents: number[]; proposals: string[]; branches: number[] })
  | (MetaReviewMaterialCommon & { subject: "routing"; shadow: number[]; shadow_rows: number; shadow_rows_multi_candidate: number; allocations: number[]; cells: number[]; rows: number[]; proposals: string[] })
  // ADR 0120 決定2 / issue #618: 盤面が主題の meta-review を登録した(登録した task に帰属)。
  // material_watermark = 登録時の events の最大 id —— 次の周期の材料はこれより後の event。
  | { kind: "meta_review_registered"; subject: "memory" | "routing"; material_watermark: number }
  // spec #615 A / issue #617: Board call の Behavior candidate 起草が撃って失敗した(異議されたタスクに帰属)。
  // 撃てなかった回は書かない(ADR 0164 決定3)。`attribution_event_id` は起草の出所になるはずだった帰責 ——
  // 撃ち直しの回数と間隔はこれで数える。店の event ではなく rebuild は再生しない。
  | { kind: "memory_draft_failed"; entry_id: number; round: "initial" | "after_rca"; attribution_event_id: number; reason: string }
  // ADR 0164 決定3 / ADR 0168 決定2: 帰責の Board call が撃って失敗した(異議されたタスクに帰属)。
  // 判断ではないので `objection_attributed` には書かない。`objection_event_id` は異議群の名前(最初の異議 event の id、
  // ADR 0170 決定4)。撃ち直すのは第2回だけで、その回数と間隔は異議群ごとに `round = after_rca` のこれで数える ——
  // 初回(`initial`)は撃ち直さない。
  | { kind: "objection_attribution_failed"; entry_id: number; objection_event_id: number; round: "initial" | "after_rca"; reason: string }
  // ADR 0164 決定5 / issue #1066: 撃ち直しを打ち切った起草(target = 帰責 event の id)/ 第2回の帰責(target = 異議群の最初の異議 event の id)/
  // 配分評価(target = review の task_completed event の id、ADR 0172 決定3)への人間の Retry(以後の失敗を数え直す)と
  // Dismiss(二度と撃たない)。失敗 event と同じタスクに帰属。
  | { kind: "refire_retried" | "refire_dismissed"; refire: "draft" | "second_round" | "allocation"; target: number }
  // ADR 0195 決定5 / issue #1388: 出口の床が応答予算を超えた成功の応答を切った(盤面スコープ)。読み口の欠陥の記録 ——
  // bytes = 切る前の CallToolResult を丸ごとシリアライズしたバイト数(ADR 0195 追記1)。worker の面では session の task id を載せる。
  | { kind: "response_truncated"; surface: "management" | "worker"; verb: string; bytes: number; budget: number; task_id?: string };

export type EventKind = EventPayload["kind"];

/** 盤面スコープの kind —— task を持たず、task_id を NULL で書く(issue #545 / #590 / #927)。
 *  一覧はここにだけ置き、`appendEvent` の型がこの一覧と taskId の null を結ぶ。 */
const BOARD_SCOPED_KINDS = [
  "execution_settings_changed",
  "memory_entry_created",
  "memory_entry_invalidated",
  "memory_entry_approved",
  "memory_index_rebuilt",
  "memory_settings_changed",
  "meta_review_settings_changed",
  "agent_tier_changed",
  "response_truncated",
] as const satisfies readonly EventKind[];
type BoardScopedKind = (typeof BOARD_SCOPED_KINDS)[number];
/** task に帰属させて書く payload(`BOARD_SCOPED_KINDS` 以外)。 */
export type TaskScopedPayload = Exclude<EventPayload, { kind: BoardScopedKind }>;
export type EventOrigin = "webui" | "mcp" | "worker" | "board";

export interface EventRow {
  id: number;
  /** null は盤面スコープのイベント(`BOARD_SCOPED_KINDS`)。 */
  task_id: string | null;
  worker_id: string;
  origin: EventOrigin;
  kind: EventKind;
  payload: EventPayload;
  created_at: string;
}

/** The single typed write function: every state change is appended through
 *  here. Returns the event id so entries can be referenced (e.g. a decomposed
 *  child pointing at the decision it rests on). */
export function appendEvent(
  db: Db,
  event: { workerId: string; origin: EventOrigin; at: Date } & (
    | { taskId: null; payload: Extract<EventPayload, { kind: BoardScopedKind }> }
    | { taskId: string; payload: TaskScopedPayload }
  ),
): number {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO events (task_id, worker_id, origin, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      event.taskId,
      event.workerId,
      event.origin,
      event.payload.kind,
      JSON.stringify(event.payload),
      event.at.toISOString(),
    );
  return Number(lastInsertRowid);
}

/** The decision log is not its own entity: it is the events table narrowed to
 *  the kinds a human skims (issue #5). Kinds join this list; no table is added.
 *  satisfies は listLog の inner join の前提(どれも盤面スコープでない)を型で断言する(issue #927)。 */
export const HUMAN_FACING_KINDS = ["decision_logged", "task_completed", "premise_breached"] as const satisfies readonly Exclude<
  EventKind,
  BoardScopedKind
>[];

export type DecisionLogEntry = Omit<EventRow, "payload" | "task_id"> & {
  task_id: string;
  payload: Extract<EventRow["payload"], { kind: (typeof HUMAN_FACING_KINDS)[number] }>;
};

/** SQL 側(listLog / taskDecisionLog / push)の `kind IN (...HUMAN_FACING_KINDS)` と同じ定義。kind だけを見る ——
 *  `task_id: string` への絞り込みは、human-facing kind が BOARD_SCOPED_KINDS に入らないという上の satisfies に依る。 */
export const isDecisionLogEntry = (e: EventRow | undefined): e is DecisionLogEntry =>
  HUMAN_FACING_KINDS.some((k) => k === e?.kind);

/** 帰責 event を id つきで。 */
export type Attribution = { id: number } & Extract<EventPayload, { kind: "objection_attributed" }>;

/** 異議群(ADR 0170 決定1): 1つの entry に対し、束ねられた(session が閉じた)同じ session で打たれた異議の集合。名前は
 *  最初の異議 event の id(`objection_event_ids` の先頭)で、異議群の順は名前の順(session の順と一致する)。open session の
 *  異議はまだ異議群ではない。帰責は `objection_event_ids` の先頭で自分の異議群を名指し、同じ異議群では後の event(after_rca)が
 *  有効 —— `attribution` が無い異議群は未帰責。 */
export interface ObjectionBundle {
  entry_id: number;
  task_id: string;
  objection_event_ids: number[];
  attribution?: Attribution;
}

/** 異議群の名前(最初の異議 event の id、ADR 0170 決定4)—— 帰責の `objection_event_ids` の先頭も同じ異議群を名指す。 */
export const bundleName = (b: { objection_event_ids: number[] }) => b.objection_event_ids[0]!;

/** entry ごとの異議群を古い順に(`entryIds` を省けば全 entry)。帰責は束ねた異議群にしか書かれず、`objection_event_ids` の
 *  先頭で自分の異議群を名指す。 */
export function objectionBundles(db: Db, entryIds?: number[]): Map<number, ObjectionBundle[]> {
  const only = (column: string) => (entryIds ? `AND json_extract(${column}, '$.entry_id') IN (${entryIds.map(() => "?").join(", ")})` : "");
  const params = entryIds ?? [];
  const bySession = new Map<string, ObjectionBundle>();
  for (const o of db
    .prepare(
      `SELECT o.id, o.task_id, json_extract(o.payload, '$.entry_id') AS entry_id, s.id AS session_id
         FROM events o JOIN triage_sessions s ON s.id = json_extract(o.payload, '$.session_id')
        WHERE o.kind = 'objection_raised' AND s.committed_at IS NOT NULL ${only("o.payload")} ORDER BY o.id`,
    )
    .all(...params) as Array<{ id: number; task_id: string; entry_id: number; session_id: number }>) {
    const key = `${o.entry_id}:${o.session_id}`;
    const bundle = bySession.get(key);
    if (bundle) bundle.objection_event_ids.push(o.id);
    else bySession.set(key, { entry_id: o.entry_id, task_id: o.task_id, objection_event_ids: [o.id] });
  }
  const byName = new Map([...bySession.values()].map((b) => [`${b.entry_id}:${bundleName(b)}`, b]));
  for (const e of db
    .prepare(`SELECT * FROM events WHERE kind = 'objection_attributed' ${only("payload")} ORDER BY id`)
    .all(...params)
    .map((r) => parseEventRow(r))) {
    if (e.payload.kind !== "objection_attributed") continue; // SQL で kind を絞り済み —— 型の絞り込みのためだけ
    const attribution: Attribution = { ...e.payload, id: e.id };
    const bundle = byName.get(`${attribution.entry_id}:${bundleName(attribution)}`);
    if (bundle) bundle.attribution = attribution;
  }
  const byEntry = new Map<number, ObjectionBundle[]>();
  for (const b of [...byName.values()].sort((a, b) => bundleName(a) - bundleName(b))) byEntry.set(b.entry_id, [...(byEntry.get(b.entry_id) ?? []), b]);
  return byEntry;
}

/** entry の今の判定(ADR 0170 決定2): 最後の異議群の帰責。最後の異議群が未帰責なら entry は未帰責で、Map に載らない。
 *  entry を1つの値で読む読み手(一覧・Precedent・打ち切りの行)はすべてこれを読む —— 起草 verb は review 子が材料にした
 *  異議群の判定を読む(ADR 0171 決定3)。 */
export function currentAttributions(db: Db, entryIds?: number[]): Map<number, Attribution> {
  return new Map([...objectionBundles(db, entryIds)].flatMap(([entryId, bundles]) => {
    const attribution = bundles.at(-1)!.attribution;
    return attribution ? [[entryId, attribution] as const] : [];
  }));
}

/** A log entry annotated with its resolved workspace name (issue #44): the
 *  event's own task's `workspace`, or the board's default when the task
 *  carries none — resolved fresh at read time, never stamped onto the event
 *  itself (same "resolved fresh every use, not pinned" reference semantics
 *  as `resolveExecutionWorkspace`, ADR 0009). Also carries every objection
 *  ever raised against the entry (ADR 0085) — the annotation is a fact of
 *  the entry, not a session's state, so bundled and still commit-pending
 *  objections both ride along. `session_id` is the sole fact the read model
 *  hands the caller for telling the two apart (against the current open
 *  session, if any); `at` and who raised it are deliberately left out
 *  (issue #371). The entry's current attribution `cause` (and its `entries`, ADR 0166) — the last
 *  objection bundle's judgment (ADR 0170) — is joined at read time from append-only
 *  `objection_attributed` events (ADR 0115). */
export interface LogEntry extends DecisionLogEntry {
  workspace: string | null;
  objections: { comment: string; session_id: number }[];
  cause: Cause | null;
  /** 今の判定(`currentAttributions`)が `memory` のとき名指された entry の id 列(ADR 0166 決定6)。他の cause・未帰責のエントリは null。 */
  entries: number[] | null;
  /** エントリを含む worker session の `worker_spawned` の id(case 描画と同じ窓、`sessionSpawnOf`)。窓の外なら null。 */
  session_event_id: number | null;
}

export function listLog(db: Db, defaultWorkspaceName?: string): LogEntry[] {
  const placeholders = HUMAN_FACING_KINDS.map(() => "?").join(", ");
  // an inner join is safe here only because every HUMAN_FACING_KIND is
  // task-scoped (asserted against BOARD_SCOPED_KINDS next to HUMAN_FACING_KINDS) and tasks are never deleted
  // (append-only) — no log entry can end up orphaned, so this can never
  // silently drop one
  const rows = db
    .prepare(
      `SELECT events.*, COALESCE(tasks.workspace, ?) AS workspace
         FROM events JOIN tasks ON tasks.id = events.task_id
        WHERE events.kind IN (${placeholders}) ORDER BY events.id`,
    )
    .all(defaultWorkspaceName ?? null, ...HUMAN_FACING_KINDS)
    .map((r) => parseEventRow<{ workspace: string | null }>(r));
  // a second, flat query rather than N+1 per entry — grouped in JS below
  const objectionsByEntry = new Map<number, { comment: string; session_id: number }[]>();
  for (const o of entryObjections(db)) {
    const list = objectionsByEntry.get(o.entry_id) ?? [];
    list.push({ comment: o.comment, session_id: o.session_id });
    objectionsByEntry.set(o.entry_id, list);
  }
  const attributions = currentAttributions(db);
  // session の窓を切るのに要るのは spawn と exit だけ。窓の規則は task で絞るので盤面全体を1回で引いて渡す
  // ponytail: エントリ数 × session 数の走査。盤面が育って一覧が重くなったら task ごとに束ねる
  const sessionEvents = listEventsOfKinds(db, ["worker_spawned", "worker_exited"]);
  return rows.flatMap((entry) => {
    if (!isDecisionLogEntry(entry)) return []; // SQL で kind を絞り済み —— 型の絞り込みのためだけ
    const attribution = attributions.get(entry.id);
    return {
      ...entry,
      objections: objectionsByEntry.get(entry.id) ?? [],
      cause: attribution?.cause ?? null,
      entries: attribution?.entries ?? null,
      session_event_id: sessionSpawnOf(sessionEvents, entry)?.id ?? null,
    };
  });
}

export function getLogCursor(db: Db): number {
  const { last_read } = db.prepare("SELECT last_read FROM log_cursor WHERE id = 1").get() as {
    last_read: number;
  };
  return last_read;
}

/** The cursor only ever advances: a stale writer (an old tab) cannot flip
 *  already-read entries back to unread. */
export function advanceLogCursor(db: Db, lastRead: number): number {
  db.prepare("UPDATE log_cursor SET last_read = MAX(last_read, ?) WHERE id = 1").run(lastRead);
  return getLogCursor(db);
}

/** One task's own decision log (issue #29's review-context addendum): the
 *  events table narrowed the same way `listLog` narrows the whole board, but
 *  scoped to a single task_id — the primary resource a review's RCA reads
 *  ("自分は何をどの順で判断したか"). No summarizing middle layer: every
 *  human-facing entry, verbatim. */
export function taskDecisionLog(db: Db, taskId: string): DecisionLogEntry[] {
  const placeholders = HUMAN_FACING_KINDS.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT * FROM events WHERE task_id = ? AND kind IN (${placeholders}) ORDER BY id`,
    )
    .all(taskId, ...HUMAN_FACING_KINDS)
    .map((r) => parseEventRow(r))
    .filter(isDecisionLogEntry); // SQL で kind を絞り済み —— 型の絞り込みのためだけ
}

/** events 表の生の行(payload が文字列)を EventRow に戻す。SELECT で足した列(listLog の workspace)は `Extra` としてそのまま通す。 */
function parseEventRow<Extra = unknown>(row: unknown): EventRow & Extra {
  const raw = row as Omit<EventRow, "payload"> & { payload: string };
  return { ...raw, payload: JSON.parse(raw.payload) as EventPayload } as EventRow & Extra;
}

export function getEvent(db: Db, id: number): EventRow | undefined {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  return row === undefined ? undefined : parseEventRow(row);
}

/** payload を kind で絞った EventRow。 */
type EventRowOf<K extends EventKind> = EventRow & { payload: Extract<EventPayload, { kind: K }> };

/** kind(複数可)で盤面全体の event を id 順に引く。`after` より後(排他)・`upTo` まで(包含)に絞れる。 */
export function listEventsOfKinds<K extends EventKind>(
  db: Db,
  kinds: readonly K[],
  { after = 0, upTo = Number.MAX_SAFE_INTEGER }: { after?: number; upTo?: number } = {},
): EventRowOf<K>[] {
  return db
    .prepare(`SELECT * FROM events WHERE kind IN (${kinds.map(() => "?").join(", ")}) AND id > ? AND id <= ? ORDER BY id`)
    .all(...kinds, after, upTo)
    .map((r) => parseEventRow(r) as EventRowOf<K>);
}

/** タスクの kind の event のうち最新の1件。 */
export function latestEventOfTask<K extends EventKind>(db: Db, taskId: string, kind: K): EventRowOf<K> | undefined {
  const row = db.prepare("SELECT * FROM events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(taskId, kind);
  return row === undefined ? undefined : (parseEventRow(row) as EventRowOf<K>);
}

export function listEvents(db: Db, taskId: string): EventRow[] {
  return db
    .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id")
    .all(taskId)
    .map((r) => parseEventRow(r));
}
