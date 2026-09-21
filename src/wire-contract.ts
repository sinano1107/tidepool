/** wire の契約(ADR 0138)。WebUI が読むサーバ応答の欄だけを、`'METHOD /path'` をキーとする
 *  表1つに宣言する。WebUI は `api()` を通して表の行を受け、サーバは `res.json(x satisfies
 *  WireContract[...])` で同じ行に照らす。分岐に使う欄はリテラル union、表示だけの欄は `string`。
 *
 *  leaf module である —— WebUI の型検査プログラムがインライン `import()` 型で引くので、
 *  import してよいのは leaf の語彙だけ(ADR 0133 決定3)。動的セグメントはテンプレート形(`:id`)を
 *  キーにする。 */
import type { Cause } from "./cause.js";
import type { HaltKind } from "./halt-kind.js";

/** 盤面全体の停止の entry。属性を持つのは throttle だけ(ADR 0068 決定2)。 */
export interface BoardHalt {
  kind: HaltKind;
  revalidating?: boolean;
  failClosed?: boolean;
  resumesAt?: string | null;
  observedAt?: string | null;
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
}

export interface ScratchpadLine {
  id: number;
  line: string;
}

/** 一窓ぶんの throttle(src/throttle.ts の WindowThrottleState)。 */
interface WindowThrottle {
  throttled: boolean;
  resumeAt: string | null;
}

export interface WireContract {
  "GET /api/queue": {
    halts: BoardHalt[];
    teardown?: Teardown;
    providerUsage?: ProviderUsage[];
    tasks: QueueTask[];
  };
  "GET /api/tasks": Array<BoardTask & { landing?: { blocked_by: "attached_children" | "objections" | null } | null }>;
  "GET /api/tasks/:id": BoardTask & {
    completion_criteria: string;
    workspace: string | null;
    review_flag: number;
    handoff_doc: string | null;
  };
  "GET /api/your-tasks": Array<Pick<QueueTask, "id" | "title" | "issue_live_state"> & { blocking: string | null }>;
  "GET /api/pause": {
    halts: BoardHalt[];
    throttle: {
      throttled: boolean;
      resumesAt: string | null;
      revalidating: boolean;
      windows: { session: WindowThrottle | null; week: WindowThrottle | null; fable: WindowThrottle | null };
    };
    spendDown: Record<"session" | "week", { activatedAt: string } | null>;
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
    | { status: "translated"; text?: string; purpose?: string; items?: Array<{ title: string; detail?: string }>; doc?: string }
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
}
