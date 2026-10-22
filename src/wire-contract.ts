/** wire の契約(ADR 0138)。WebUI が読むサーバ応答の欄だけを、`'METHOD /path'` をキーとする
 *  表1つに宣言する。WebUI は `api()` を通して表の行を受け、サーバは `sendJson(res, x satisfies
 *  WireContract[...])` で同じ行に照らす。分岐に使う欄はリテラル union、表示だけの欄は `string`。
 *
 *  leaf module である —— WebUI の型検査プログラムがインライン `import()` 型で引くので、
 *  import してよいのは leaf の語彙だけ(ADR 0133 決定3)。動的セグメントはテンプレート形(`:id`)を
 *  キーにする。 */
import type { Cause } from "./cause.js";
import type { AdvisorCeiling } from "./claude-model-alias.js";
import type { HaltKind } from "./halt-kind.js";

/** 盤面全体の停止の entry。 */
export interface BoardHalt {
  kind: HaltKind;
}

/** 後始末中の session(ADR 0109 決定2)。経路は `settlement` が言う(ADR 0113 決定3)。 */
export interface Teardown {
  taskId: string;
  startedAt: string;
  /** 値集合の正本は src/teardown.ts の Settlement(移送は issue #352)。 */
  settlement: "completed" | "released" | "interrupted" | "never_ran";
}

/** 最後の poll の失敗(ADR 0294 決定1)。停止ではないが pickup を待たせているものの2つ目。 */
export interface PollFailure {
  at: string;
  message: string;
}

/** サーバ側の正本は src/throttle.ts の DisplayProviderUsage(値集合の移送は issue #352)。 */
export interface ProviderUsage {
  provider: string;
  status: "observed" | "unauthorized" | "unobservable" | "absent";
  plan: string | null;
  reason?: string;
  observedAt: string | null;
  windows: Array<{
    window: string;
    model: string | null;
    usedPercent: number | null;
    offset: number;
    throttled: boolean;
    resumesAt: string | null;
  }>;
}

/** merge question の印は根に刻まれた PR の決着から導く(ADR 0265 決定2)。`pr_merged` は盤面の名義の merge で、回答の記録が無いもの(決定5)。 */
export type RootSettledByObservation = "pr_merged" | "pr_merge_observed" | "pr_close_observed";

/** 観測で閉じた question の印(ADR 0265 決定7): 回答なしで盤面が閉じたときの種類。WebUI の札の文言表がこれで欠けを落とす。 */
export type SettledByObservation =
  | RootSettledByObservation
  | "pr_promotion_observed"
  | "quarantine_released"
  | "routing_proposal_stale"
  | "memory_proposal_stale";

/** done の work の行の着地の状態(ADR 0265 決定7、src/landing.ts の landingState)。WebUI の札の文言表がこれで欠けを落とす。 */
export type LandingState = "auto_merge_queue" | "merge_question" | "merged" | "merge_observed" | "close_observed" | "withdrawn" | "landed";

/** 回答の応答と question の行が運ぶ印。 */
export interface SettledMark {
  settled_by_observation: SettledByObservation | null;
}

export interface QueueTask {
  id: string;
  title: string;
  /** 値集合の正本は src/task-status.ts の TaskStatus と表示上の派生状態(移送は issue #352)。 */
  status: "todo" | "in_progress" | "done" | "cancelled" | "blocked" | "held" | "skipped";
  assignee: string | null;
  risk_flag: number;
  issue_live_state?: "live" | "stale" | "unavailable";
  /** キューの読み口だけ: この行を skipped にしている閉じた根と PR(ADR 0265 決定6)。 */
  closed_root?: { task_id: string; pr_number: number };
}

/** 盤面の行と task 詳細が共有する欄。 */
export interface BoardTask extends QueueTask {
  type: "work" | "question" | "review" | "memory_repair" | "routing_repair" | "interview";
  parent_id: string | null;
  /** 受験者だけ: その Interview の root の id(ADR 0267 決定6)。 */
  interview_root_id: string | null;
  /** 出題済みの Interview の root が blocked で待つもの(ADR 0273 決定3): 監査か受験者か。他の行には欄が無い。 */
  interview_waiting?: "audit" | "examinees";
  /** 解決前の workspace の名前。Interview の root と受験者では実環境の名前で、受験者の走る場所は面接室(ADR 0273 決定8)。 */
  workspace: string | null;
  review_flag: number;
  review_by: string[] | null;
  raw_assignee?: string | null;
  github_issue_number: number | null;
  registrant?: string;
  purpose: string;
  question_items: Array<{ title: string; detail?: string; options: string[]; recommendation: string }> | null;
  /** 提案 question の種別(ADR 0120 決定4 / ADR 0150 決定2 / ADR 0152 決定2)。routing の行の提案(op row)と段の追加(op add_tier)、registry の tier の提案、
   *  段の説明の提案(op tier_description)、Interview の提案(op interview、仮説・測る仕事・対象の effort・実環境)、memory の approve / consolidate のうち `candidate_id` を持つもの(その文言、Exemplar なら注釈 list ——
   *  種別は画面が candidate から引く)は approve に修正値を添えられる。registry の tier の提案の `pin.tier` は下げ先の選択肢の上端(ADR 0200 決定4)。 */
  question_proposal: {
    kind: "memory" | "routing" | "registry";
    op: string;
    candidate_id?: number;
    /** op tier_description は段の名前、op add_tier は足す段(名前・説明・位置)—— 後者は修正値の欄の初期値(issue #1439)。 */
    tier?: string | { name: string; description: string; position: number };
    pin?: { tier: string } | { promoted: boolean } | { description: string } | { row: { tier: string } } | { rows: Array<{ tier: string }> };
    /** op interview の欄 —— 修正値の欄の初期値。修正できる対象は effort だけで、一覧の順のまま送る(src/execution-setting.ts の parseInterviewAmendment)。 */
    hypothesis?: string;
    measured_work?: string;
    targets?: Array<{ provider: string; model: string; effort: string | null }>;
    workspace?: string;
  } | null;
  /** 確認 question の Quarantine の種別(src/quarantine.ts の QuarantineKind)。行の Quarantine(`tableRow` と effort ごとの
   *  `tableRowEffort`)の question だけが settings タブを開くボタンを持つ(ADR 0184 決定6 / ADR 0218 決定2)。 */
  question_quarantine_kind: string | null;
  /** failure / premise-breach question の cancel option の選択肢(question 画面が `discards` をその脇に出す、ADR 0271 決定4)。 */
  question_cancel_option: string | null;
}

export interface ScratchpadLine {
  id: number;
  line: string;
}

/** 危険な値の確認の 409(ADR 0061 決定1)。理由コードは表示の表を引くだけで、知らない
 *  コードは生の文字列で出す(settings-screen の DANGEROUS_REASON_LABEL)ので `string`。 */
interface DangerousValuesConflict {
  error: string;
  confirm_required: true;
  dangerous_values: string[];
}

/** 削除の 409(ADR 0087)。確認では買えない `blocked` の形も同じ status で来るので、
 *  `confirm_required` は立たないことがある —— WebUI は立ったときだけ確認を開く。 */
interface DeletionConflict {
  error: string;
  confirm_required?: true;
}

/** 重ねた1本の木の門の拒否(ADR 0221)。片側の `id` は今ある行(`existing`)か移動元、null はこの操作が置く行。 */
interface OneTreeConflict {
  error: string;
  pairs: Array<{
    entry: { id: number | null; existing: boolean; kind: "knowledge" | "behavior" | "definition" | "exemplar"; path: string };
    definition: { id: number | null; existing: boolean; path: string; scope: string };
  }>;
}

/** 設定面の1選択肢(src/registry.ts の PROVIDER_OPTIONS)。 */
interface Option {
  value: string;
  label: string;
}

/** spawn 注入の上限(src/memory.ts の MemorySettings)。 */
interface MemorySettings {
  injection_token_cap: number;
}

/** 周期 meta-review の間隔の下限(日、src/meta-review.ts の MetaReviewSettings)。 */
interface MetaReviewSettings {
  period_days: number;
}

/** 承認 question の注釈(issue #757)。question 行にだけ載り、承認 question なら非 null。 */
interface ApprovalAnnotation {
  raises_parent_risk: boolean;
}

/** 着地 question の注釈(ADR 0092 決定4, src/landing.ts の landingAnnotation)。question 行にだけ載り、着地 question なら非 null で
 *  `blocked_by` が回答可否、一般 question は null。 */
interface LandingAnnotation {
  blocked_by: "attached_children" | "objections" | null;
}

/** cancel で成果が捨てられる done の work(ADR 0271 決定4、src/tasks.ts の Discard)。agent が実行したものだけ、盤面の順。 */
interface Discard {
  id: string;
  title: string;
}

/** memory の提案 question の移動の注釈(ADR 0162 決定6, src/memory.ts の movedPins)。移された pin ごとに旧 id と `path_moved` の
 *  鎖の末尾の id・path・scope。question 行にだけ載り、移された pin が無ければ空。 */
interface MovedPin {
  id: number;
  tail_id: number;
  path: string;
  scope: string | null;
}

export interface WireContract {
  "GET /api/queue": {
    halts: BoardHalt[];
    teardown?: Teardown;
    lastPollFailure?: PollFailure;
    providerUsage?: ProviderUsage[];
    tasks: QueueTask[];
  };
  "GET /api/tasks": Array<
    BoardTask & {
      landing?: LandingAnnotation | null;
      approval?: ApprovalAnnotation | null;
      moved?: MovedPin[];
      blocking?: string | null;
      /** 理由の comment が要る選択肢(ADR 0179 決定4)。 */
      needs_comment?: string[];
      /** 自由記述の回答を受けるか —— 固定選択肢の question は false(issue #1309)。 */
      free_text?: boolean;
      settled_by_observation?: SettledByObservation | null;
      /** question 行だけ: failure / premise-breach question の cancel option が捨てる done の work(ADR 0271 決定4)。それ以外は空。 */
      discards?: Discard[];
      /** question でない行だけ: 着地の状態(question 行の `landing` 注釈とは別物)。 */
      landing_state?: LandingState | null;
    }
  >;
  "GET /api/tasks/:id": BoardTask & {
    /** 保存された assignee(編集フォームが読む素の値)。`assignee` は一覧と同じ解決後の値(issue #1208)。 */
    raw_assignee: string | null;
    landing?: LandingAnnotation | null;
    approval?: ApprovalAnnotation | null;
    moved?: MovedPin[];
    blocking?: string | null;
    needs_comment?: string[];
    free_text?: boolean;
    settled_by_observation?: SettledByObservation | null;
    landing_state?: LandingState | null;
    /** question 行は cancel option の、それ以外はその task の直接 cancel の、捨てられる done の work(ADR 0271 決定4)。 */
    discards: Discard[];
    completion_criteria: string;
    review_flag: number;
    review_by: string[] | null;
    handoff_doc: string | null;
    /** Interview の root だけ: 面接室のホスト上の在り処(まだ開いていなければ null)と最新の出題の head(出題前は null)(ADR 0273 決定1・3)。 */
    interview_room?: string | null;
    posed_head?: string | null;
    /** 受験者だけ: 自分の checkout のホスト上の在り処(まだ開いていなければ null)(ADR 0276 決定4)。 */
    examinee_checkout?: string | null;
  };
  "GET /api/your-tasks": Array<Pick<QueueTask, "id" | "title" | "issue_live_state"> & { blocking: string | null }>;
  "GET /api/pause": {
    halts: BoardHalt[];
    /** Provider → 窓 → arm の状態(null は未 arm)。キーの集合は Spend-down の既知の組で、
     *  正本は src/spend-down.ts の SPEND_DOWN_WINDOWS —— WebUI はここに在る窓にだけ入口を出す。
     *  resetsAt は結んだ窓の reset、null は次に開く窓への arm(ADR 0260)。 */
    spendDown: Record<string, Record<string, { activatedAt: string; resetsAt: string | null } | null>>;
    providerUsage?: ProviderUsage[];
  };
  "GET /api/log": {
    entries: Array<{
      id: number;
      created_at: string;
      task_id: string;
      worker_id: string;
      /** 値集合の正本は src/events.ts の HUMAN_FACING_KINDS(移送は issue #352)。 */
      payload:
        | { kind: "task_completed"; result: string | null; handoff_present: boolean }
        | { kind: "decision_logged" | "premise_breached"; line: string }
        /** AI の記憶の書き込み(src/events.ts の memory_written): 作った・無効化したエントリの id。 */
        | { kind: "memory_written"; line: string; created: number[]; invalidated: number[] };
      unread: boolean;
      workspace: string | null;
      cause: Cause | null;
      /** 今の判定(最後の異議群の帰責)が memory のとき名指された entry の id 列(src/triage.ts の LogEntry)。他は null。 */
      entries: number[] | null;
      /** 今の判定の evidence(src/triage.ts の LogEntry)。未帰責は null。 */
      evidence: string | null;
      objections: Array<{ comment: string; session_id: number }>;
      /** エントリを含む worker session の worker_spawned の id(src/triage.ts の LogEntry)。窓の外なら null。 */
      session_event_id: number | null;
      /** Interview のグループ(src/triage.ts の LogEntry、ADR 0273 決定10): root と監査の行だけ。鍵は root_id、見出しは title と workspace。 */
      interview: { root_id: string; title: string; workspace: string | null } | null;
    }>;
    cursor: number;
  };
  "GET /api/triage": {
    session: { id: number } | null;
    queue: Array<QueueTask & { front_inserted: boolean }>;
    scratchpad: ScratchpadLine[];
  };
  "POST /api/triage/scratchpad": ScratchpadLine;
  "POST /api/triage/close": {
    /** 値集合の正本は src/triage.ts の TriageCommitResult(移送は issue #352)。 */
    outcome: "closed_now" | "already_closed_by_timeout" | "no_open_session";
    closed_at: string | null;
  };
  "GET /api/registry/candidates": { assignees: string[]; builtIns: string[]; workspaces: string[]; icons: Record<string, string> };
  "POST /api/translate":
    | {
        status: "translated";
        /** memory_entry の訳は title と text で来る(src/translation.ts の translateMemoryEntry)。 */
        title?: string;
        text?: string;
        purpose?: string;
        items?: Array<{ title: string; detail?: string }>;
        doc?: string;
        /** log_entries の訳は要求の event id ごとに来る(ADR 0296 決定4)。 */
        entries?: Array<{ event_id: number; text: string }>;
      }
    | { status: "throttled" };
  "POST /api/tasks": Pick<BoardTask, "id" | "type">;
  /** 観測決着も 200 で、印が回答は記録されていないことを言う(ADR 0265 決定7)。 */
  "POST /api/tasks/:id/answer": SettledMark;
  /** 登録の門の 422(src/human-verbs.ts の issue_rejected)。`api()` のキーには出ない。 */
  "POST /api/tasks 422": { missing: string; suggested_comment: string };
  "POST /api/tasks/draft": {
    title: string;
    purpose: string;
    completion_criteria: string;
    assignee?: string;
    workspace?: string;
    risk_flag?: boolean;
    review_flag?: boolean;
  };
  /** 欄名の正本は src/tasks.ts の HANDOFF_FIELDS。 */
  "POST /api/tasks/:id/complete/draft": Partial<
    Record<"outcome" | "deliverables" | "decision_refs" | "dead_ends" | "resume_context" | "known_issues", string>
  > & { missing: string[] };
  "GET /api/push/vapid-public-key": { publicKey: string | null };
  "GET /api/settings/timezone": { tz: string };
  "GET /api/settings/display-language": { language: string; options: readonly string[] };
  "GET /api/github-issues": { issues: Array<{ number: number; title: string }>; truncated: boolean };
  "GET /api/pending-dumps": ScratchpadLine[];
  "GET /api/workspaces": {
    workspaces: Array<{
      name: string;
      registrySelf: boolean;
      path?: string;
      repo?: string;
      branch?: string;
      notes?: string;
      protected?: boolean;
      review_allowed_commands?: string[];
      allowed_domains?: string[];
    }>;
    /** 値集合の正本は src/workspace.ts の WorkspacesBaseDirSource(ADR 0082 決定1)。 */
    workspacesBaseDir: { path: string; source: "configured" | "default" };
  };
  /** register の門(issue #383)。`clone_landing` は origin を持たない checkout では null。 */
  "POST /api/workspaces 409": {
    error: string;
    confirm_required: true;
    live_checkout_signals: string[];
    clone_landing: string | null;
  };
  "PATCH /api/workspaces/:name 409": DangerousValuesConflict;
  /** 残る checkout の場所(ADR 0087 決定4)。 */
  "DELETE /api/workspaces/:name": { checkout: string };
  "DELETE /api/workspaces/:name 409": DeletionConflict;
  "GET /api/agents": {
    agents: Array<{
      name: string;
      icon?: string;
      description: string;
      systemPrompt: string;
      authority: string;
      provider: string;
      tier?: string;
      advisor: boolean;
      skills: string[];
      builtin?: true;
      shadowsBuiltIn?: true;
    }>;
    authorityProfiles: string[];
    providers: readonly Option[];
  };
  "POST /api/agents": { shadows_built_in?: true };
  "DELETE /api/agents/:name 409": DeletionConflict;
  "GET /api/profiles": {
    profiles: Array<{
      name: string;
      guidance: string;
      assignable_to?: string[];
      allowed_workspaces?: string[];
      merge?: string;
    }>;
  };
  "POST /api/profiles 409": DangerousValuesConflict;
  "PATCH /api/profiles/:name 409": DangerousValuesConflict;
  "DELETE /api/profiles/:name 409": DeletionConflict;
  "GET /api/skills": { skills: string[]; degraded: boolean };
  "GET /api/settings/quiet-hours": { start: string; end: string; tz: string };
  "POST /api/settings/quiet-hours": { start: string; end: string };
  "GET /api/settings/provider-pace-offsets": { offsets: Array<{ provider: string; window: string; offset: number }> };
  "GET /api/settings/execution": {
    /** quarantine_question_id: 行の Quarantine(ADR 0184 決定6)の開いている question。null = 走れる行。 */
    table: ReadonlyArray<{ provider: string; tier: string; model: string; effort: string | null; price_in: number; price_out: number; quarantine_question_id: string | null }>;
    /** advisor の上限(ADR 0208 決定1)。agent の画面は `off` で「この盤面では使われない」を出す。 */
    advisorCeiling: AdvisorCeiling;
    providerRank: readonly string[];
    priority: string;
    /** review task の並べ方(ADR 0111 追記10)。`priority` は work 用。 */
    reviewPriority: string;
    learnerPromoted: boolean;
    defaultTier: string;
    /** 盤面自身の判断の段(振り返り Board call と周期 meta-review、ADR 0200 決定4)。 */
    judgementTier: string;
    providers: readonly Option[];
    /** 盤面の段の一覧、順序どおり(ADR 0200 決定1・3)。 */
    tiers: ReadonlyArray<{ name: string; description: string }>;
    priorities: readonly string[];
    advisorCeilings: readonly AdvisorCeiling[];
  };
  "GET /api/settings/memory": MemorySettings;
  "POST /api/settings/memory": MemorySettings;
  "GET /api/settings/meta-review": MetaReviewSettings;
  "POST /api/settings/meta-review": MetaReviewSettings;
  "GET /api/settings/memory/entries": {
    entries: Array<{
      id: number;
      /** 値集合の正本は src/memory.ts の MemoryEntryFields["kind"](移送は issue #352)。 */
      kind: "knowledge" | "behavior" | "definition" | "exemplar";
      state: string;
      scope: string | null;
      path: string;
      title: string;
      text: string;
      original: { title: string; text: string; language: string } | null;
      addressee: string | null;
      author: { activity: string };
      invalidation_reason: string | null;
      successor_id: number | null;
      /** 無効化の書き手(src/memory.ts の InvalidatedBy)。無効化されていなければ null。 */
      invalidated_by: { question_id: string } | { activity: string } | { worker: string } | null;
      /** 復元の複製の id(ADR 0163 追記 #1059)。復元していなければ null。 */
      restored_as: number | null;
      /** superseded でこの行を後継に指す id(ADR 0162 の畳みの跡)。 */
      replaced_ids: number[];
      /** 孤立の印(ADR 0173 決定5): 宛先の agent・scope の workspace のどちらが registry に無いか。registry の無い盤面では欄が無い。 */
      orphaned?: "addressee" | "scope" | "both" | null;
      cause: string | null;
      /** 値集合の正本は src/memory.ts の MemorySource。event の ref が自身の id なら出所は作成 event(事例なし)。 */
      source: { kind: "commit"; ref: string } | { kind: "event" | "decision"; ref: number };
      /** Exemplar のみ(src/memory.ts の ExemplarAnnotation)。 */
      annotations?: Array<{
        anchor: "whole" | { field: "decision" | "steering" | "handoff" | "result"; quote: string };
        polarity: "imitate" | "avoid";
        text: string;
        original?: { text: string; language: string };
      }>;
    }>;
  };
  "POST /api/settings/memory/knowledge 409": OneTreeConflict;
  "POST /api/settings/memory/definitions 409": OneTreeConflict;
  "POST /api/settings/memory/behaviors 409": OneTreeConflict;
  "POST /api/settings/memory/exemplars 409": OneTreeConflict;
  "POST /api/settings/memory/entries/:entry_id/move 409": OneTreeConflict;
  "POST /api/settings/memory/branches/move 409": OneTreeConflict;
  "POST /api/settings/memory/entries/:entry_id/restore 409": OneTreeConflict;
  /** 撃ち直しを打ち切った振り返り Board call(src/retrospective.ts の listHaltedRefires、ADR 0164 決定5 / ADR 0172 決定3)。
   *  配分評価の行は review と被レビュー task(target は review の task_completed event の id)、起草と第2回の行は entry と
   *  その帰責(target は起草なら帰責 event の id、第2回なら異議群の最初の異議 event の id(ADR 0170 決定4)、cause は entry の
   *  今の判定で、最後の異議群が未帰責なら null)。 */
  "GET /api/settings/execution/halted-refires": {
    halted: Array<
      { target: number; task: { id: string; title: string }; last_failure: { reason: string; at: string } } & (
        | { refire: "allocation"; review: { id: string; title: string } }
        | { refire: "draft" | "second_round"; entry: { id: number; text: string }; cause: Cause | null; round: "initial" | "after_rca" }
      )
    >;
  };
  /** 応答予算の床の記録の行(src/response-budget.ts の listFloorRows、ADR 0219 決定2): (surface, verb) ごとに1行。 */
  "GET /api/settings/response-floors": {
    floors: Array<{ surface: "management" | "worker"; verb: string; count: number; last_at: string; max_bytes: number; last_task_id: string | null }>;
  };
  /** 事例の case 描画(src/memory.ts の MemoryCase、ADR 0153 決定3): decision entry なら本文と steering、session なら decision 列。 */
  "GET /api/settings/memory/cases/:event_id":
    | { decision: string; steering: string[]; handoff: string | null; result: string | null }
    | { decisions: string[]; handoff: string | null; result: string | null };
  "POST /api/settings/display-language": { language: string };
  "GET /api/settings/github": { loggedIn: boolean };
  /** 翻訳の呼び出し1回 = 1行(src/translation-cache.ts の listTranslationUsage、ADR 0296 決定5)。created_at の古い順、同時刻は記録順。 */
  "GET /api/translate/usage": {
    records: Array<{
      usage: {
        input_tokens: number;
        output_tokens: number;
        /** null は測れない(Codex は費用を返さない)—— 0 ではない */
        estimated_cost_usd: number | null;
      };
    }>;
  };
}
