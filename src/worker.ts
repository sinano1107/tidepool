import type { ExecutionSetting } from "./execution-setting.js";
import { canonicalHarness, type Harness } from "./registry.js";
import type { Task } from "./tasks.js";

/** Boundary between the board and whatever executes tasks (design principle 7:
 *  the board speaks tasks; adapters speak vendors). The real adapter spawns a
 *  Claude Code child process; tests substitute a scripted fake here.
 *
 *  終了の語彙のうち adapter が持つのは**畳み込み停止だけ**である(ADR 0099
 *  決定1/2): 強制回収と回収済み観測は worker 容器への操作であり、盤面側の
 *  supervisor(`ProcessContainers`)が1度だけ書く。 */
export interface WorkerAdapter {
  /** The board's default agent name (ADR 0012 / issue #36) — a pointer to
   *  whichever registry agent an unspecified assignee resolves to, not "the
   *  one worker" (that concept doesn't exist: slot is capacity, not
   *  identity). Used as the pickup/spawn-time fallback and as the
   *  attribution on events an unspecified assignee's task generates; never
   *  written onto a task's own `assignee` column. */
  readonly id: string;
  /** Fire-and-forget: the worker acts back on the board via MCP.
   *
   *  `setting` は selector が pickup の瞬間に選んだ実行設定(ADR 0110 決定3)。
   *  **渡されたらそれを使う** —— adapter が spawn 時に解決し直すと、除外の文脈を
   *  持たない再解決が scheduler と違う entry を選びうる(温存中の Provider で
   *  走る)。 */
  start(task: Task, setting: ExecutionSetting): void;
  /** 畳み込み停止(graceful stop): `taskId` の session に、自己終了と作業の
   *  畳み込みを促す合図を送る。**送達のみで、従われる保証はない** — 合図の
   *  選択(Claude なら SIGTERM)は Harness の性質なので adapter の実装詳細に
   *  沈み、watchdog が持つのはタイミングだけである(ADR 0099 決定1)。知らない
   *  / 既に終わった task への合図は no-op。 */
  gracefulStop(taskId: string): void;
  /** Just-in-time usage check (ADR 0008): the raw `result` text of
   *  `claude -p "/usage" --output-format json`, or null if the check itself
   *  failed (spawn error, non-zero exit, unparseable JSON). The scheduler
   *  treats a null the same as an unrecognized snapshot — fail-closed. */
  checkUsage(): Promise<string | null>;
}

/** The board-facing adapter that selects the one canonical Harness for a
 *  picked task. Each vendor adapter keeps its own live root child; broadcasting
 *  graceful stop is safe because unknown task ids are no-ops and avoids a
 *  second routing table that could drift from process reality. */
export class CanonicalWorkerRouter implements WorkerAdapter {
  readonly id: string;
  private readonly adapters: Record<Harness, WorkerAdapter>;

  constructor(options: {
    id: string;
    adapters: Record<Harness, WorkerAdapter>;
  }) {
    this.id = options.id;
    this.adapters = options.adapters;
  }

  start(task: Task, setting: ExecutionSetting): void {
    // 選ばれた実行設定の Provider の正準経路へ出す —— 「どの Harness で
    // 走るか」を Provider と別に解決すると、選択と dispatch がずれる(ADR 0098)。
    this.adapters[canonicalHarness(setting.provider)].start(task, setting);
  }

  gracefulStop(taskId: string): void {
    for (const adapter of Object.values(this.adapters)) adapter.gracefulStop(taskId);
  }

  /** Provider-specific usage selection belongs to #454. Until that slice,
   *  preserve the existing Claude board usage observation unchanged. */
  checkUsage(): Promise<string | null> {
    return this.adapters["claude-code"].checkUsage();
  }
}
