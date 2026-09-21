/** wire の契約(ADR 0138)。WebUI が読むサーバ応答の欄だけを、`'METHOD /path'` をキーとする
 *  表1つに宣言する。WebUI は `api()` を通して表の行を受け、サーバは `res.json(x satisfies
 *  WireContract[...])` で同じ行に照らす。分岐に使う欄はリテラル union、表示だけの欄は `string`。
 *
 *  依存ゼロの leaf module である —— WebUI の型検査プログラムがインライン `import()` 型で引くので、
 *  import してよいのは leaf の語彙だけ(ADR 0133 決定3)。動的セグメントはテンプレート形(`:id`)を
 *  キーにする。 */
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
  settlement: "completed" | "released" | "interrupted";
}

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
  status: "todo" | "in_progress" | "done" | "cancelled" | "blocked" | "held" | "skipped";
  assignee: string | null;
  risk_flag: number;
  issue_live_state?: "live" | "stale" | "unavailable";
}

export interface WireContract {
  "GET /api/queue": {
    halts: BoardHalt[];
    teardown?: Teardown;
    providerUsage?: ProviderUsage[];
    tasks: QueueTask[];
  };
}
