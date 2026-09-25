/** wire の契約(ADR 0138)。WebUI が読むサーバ応答の欄だけを、`'METHOD /path'` をキーとする
 *  表1つに宣言する。WebUI は `api()` を通して表の行を受け、サーバは `res.json(x satisfies
 *  WireContract[...])` で同じ行に照らす。分岐に使う欄はリテラル union、表示だけの欄は `string`。
 *
 *  leaf module である —— WebUI の型検査プログラムがインライン `import()` 型で引くので、
 *  import してよいのは leaf の語彙だけ(ADR 0133 決定3)。動的セグメントはテンプレート形(`:id`)を
 *  キーにする。 */
import type { Cause } from "./cause.js";
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
  settlement: "completed" | "released" | "interrupted";
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

export interface QueueTask {
  id: string;
  title: string;
  /** 値集合の正本は src/tasks.ts の TaskStatus と表示上の派生状態(移送は issue #352)。 */
  status: "todo" | "in_progress" | "done" | "cancelled" | "blocked" | "held" | "skipped";
  assignee: string | null;
  risk_flag: number;
  issue_live_state?: "live" | "stale" | "unavailable";
}

/** 盤面の行と task 詳細が共有する欄。 */
export interface BoardTask extends QueueTask {
  type: "work" | "question" | "review";
  parent_id: string | null;
  raw_assignee?: string | null;
  github_issue_number: number | null;
  registrant?: string;
  purpose: string;
  question_items: Array<{ title: string; detail?: string; options: string[]; recommendation: string }> | null;
  /** 提案 question の種別(ADR 0120 決定4 / ADR 0150 決定2)。routing の行の提案(op row)は approve に修正値を添えられる。 */
  question_proposal: { kind: "memory" | "routing"; op: string } | null;
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

export interface WireContract {
  "GET /api/queue": {
    halts: BoardHalt[];
    teardown?: Teardown;
    providerUsage?: ProviderUsage[];
    tasks: QueueTask[];
  };
  "GET /api/tasks": Array<
    BoardTask & {
      landing?: { blocked_by: "attached_children" | "objections" | null } | null;
      approval?: ApprovalAnnotation | null;
      blocking?: string | null;
    }
  >;
  "GET /api/tasks/:id": BoardTask & {
    approval?: ApprovalAnnotation | null;
    blocking?: string | null;
    completion_criteria: string;
    workspace: string | null;
    review_flag: number;
    handoff_doc: string | null;
  };
  "GET /api/your-tasks": Array<Pick<QueueTask, "id" | "title" | "issue_live_state"> & { blocking: string | null }>;
  "GET /api/pause": {
    halts: BoardHalt[];
    /** Provider → 窓 → arm の状態(null は未 arm)。キーの集合は Spend-down の既知の組で、
     *  正本は src/spend-down.ts の SPEND_DOWN_WINDOWS —— WebUI はここに在る窓にだけ入口を出す。 */
    spendDown: Record<string, Record<string, { activatedAt: string } | null>>;
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
        | { kind: "decision_logged" | "premise_breached"; line: string };
      unread: boolean;
      workspace: string | null;
      cause: Cause | null;
      objections: Array<{ comment: string; session_id: number }>;
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
  "GET /api/registry/candidates": { assignees: string[]; workspaces: string[]; icons: Record<string, string> };
  "POST /api/translate":
    | {
        status: "translated";
        /** memory_entry の訳は title と text で来る(src/translation.ts の translateMemoryEntry)。 */
        title?: string;
        text?: string;
        purpose?: string;
        items?: Array<{ title: string; detail?: string }>;
        doc?: string;
      }
    | { status: "throttled" };
  "POST /api/tasks": Pick<BoardTask, "id" | "type">;
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
    table: ReadonlyArray<{ provider: string; tier: string; model: string; effort: string; price_in: number; price_out: number }>;
    frontierAdvisor: boolean;
    providerRank: readonly string[];
    priority: string;
    learnerPromoted: boolean;
    /** 振り返り Board call(配分評価・帰責の判定・起草)が共有するティア(ADR 0111 追記4、issue #914)。 */
    retrospectiveTier: string;
    providers: readonly Option[];
    tiers: readonly string[];
    priorities: readonly string[];
  };
  "GET /api/settings/memory": MemorySettings;
  "POST /api/settings/memory": MemorySettings;
  "GET /api/settings/meta-review": MetaReviewSettings;
  "POST /api/settings/meta-review": MetaReviewSettings;
  "GET /api/settings/memory/entries": {
    entries: Array<{
      id: number;
      /** 値集合の正本は src/memory.ts の MemoryEntryFields["kind"](移送は issue #352)。 */
      kind: "knowledge" | "behavior" | "definition";
      state: string;
      scope: string | null;
      path: string;
      title: string;
      text: string;
      original: { title: string; text: string } | null;
      author: { activity: string };
      invalidation_reason: string | null;
      successor_id: number | null;
      cause: string | null;
    }>;
  };
  "POST /api/settings/display-language": { language: string };
  "GET /api/settings/github": { loggedIn: boolean };
  "GET /api/translate/usage": {
    records: Array<{ usage: { input_tokens: number; output_tokens: number; estimated_cost_usd: number } }>;
  };
}
