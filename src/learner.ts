import type { Allocation } from "./allocation-review.js";
import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import type { EventPayload, EventRow } from "./events.js";
import {
  BOARD_DEFAULT_PRIORITY,
  type ExecutionSetting,
  type Priority,
  windowMatchesModel,
} from "./execution-setting.js";
import { sessionWindow } from "./precedent.js";
import type { Provider } from "./registry.js";
import { acceptedSql, type Task } from "./tasks.js";

/** 学習器のセル(CONTEXT.md「学習器」/ ADR 0110 決定4): 観測された具体の
 *  (provider, model id, effort, advisor model)。advisor は spawn 時の **pin**
 *  であって相談回数ではない —— 「pin あり・相談0回」を advisor 無しのセルに
 *  合流させると両セルの受理率が歪む(ADR 0110 退けた案)。 */
export interface Cell {
  provider: Provider;
  model: string;
  effort: string;
  advisor: string | null;
}

/** 1つの worker session を学習器が読む形(Precedent の `Episode` と同じ session
 *  単位だが、transcript を持たず outcome だけを持つ)。文脈のうち持つのは workspace
 *  (プーリングの段)だけ —— 要求ティアは候補集合を、優先順位は推薦の呼び手が
 *  task から渡す。agent / interview 種別はセルを割らず、読み手が生えたら tasks と
 *  events から引ける。
 *  `outcome` の `excluded` は「まだ判定が無い」「帰責が worker の落ち度でない」で、
 *  受理率の分母に入らない(ADR 0115 決定5)。 */
export interface LearnerEpisode {
  cell: Cell;
  workspace: string | null;
  outcome: "accepted" | "rejected" | "excluded";
  cost_usd: number | null;
  duration_ms: number | null;
}

/** 1 session の outcome(純関数)。受理は統合点レビューの完了からの派生(ADR 0111
 *  決定1、`acceptedSql`)で、0 は「保留」も含むので失敗とは読まない。負の信号は
 *  worker の落ち度と帰責された異議(`capability`)と、配分評価の underpowered ×
 *  capability だけ —— `preference` / `requirement_change` / `environment` の異議は
 *  数えず、環境要因を除く配分評価と同じ機構に乗る(ADR 0115 決定5)。負の信号は
 *  受理より強い: 受理された task に capability の異議が残っていれば負である。
 *  配分評価は reviewer ごとに1件(ADR 0111 決定2)なので session に複数並びうる ——
 *  1つでも負なら負。 */
export function episodeOutcome(facts: {
  accepted: boolean;
  causes: readonly Cause[];
  allocations: readonly { allocation: Allocation; cause: Cause }[];
}): LearnerEpisode["outcome"] {
  if (
    facts.causes.includes("capability") ||
    facts.allocations.some((a) => a.allocation === "underpowered" && a.cause === "capability")
  ) {
    return "rejected";
  }
  return facts.accepted ? "accepted" : "excluded";
}

/** セルごとの集計。費用と時間は観測された平均(null = 観測が1つも無い)。 */
export interface CellStats {
  cell: Cell;
  accepted: number;
  rejected: number;
  cost_usd_mean: number | null;
  duration_ms_mean: number | null;
}

export interface Recommendation {
  recommended: ExecutionSetting;
  /** `prior` = 候補のどれにもデータが無く、表(selector の並び)そのまま。
   *  「出所」(selector の `source`)とは別物なので別の名前で持つ。 */
  basis: "prior" | "data";
}

/** セルの綴りは1つ: 集計の鍵も shadow 行の JSON もこれを通す。 */
export const cellJson = (c: Cell): string =>
  JSON.stringify({ provider: c.provider, model: c.model, effort: c.effort, advisor: c.advisor });
const cellOf = (s: ExecutionSetting): Cell => ({
  provider: s.provider,
  model: s.model,
  effort: s.effort,
  advisor: s.advisor ?? null,
});

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** episode 列 → セルの集計(純関数)。`excluded` は数えない。 */
export function aggregateCells(episodes: readonly LearnerEpisode[]): CellStats[] {
  const byKey = new Map<string, { cell: Cell; episodes: LearnerEpisode[] }>();
  for (const e of episodes) {
    if (e.outcome === "excluded") continue;
    const key = cellJson(e.cell);
    const group = byKey.get(key) ?? { cell: e.cell, episodes: [] };
    group.episodes.push(e);
    byKey.set(key, group);
  }
  return [...byKey.values()].map(({ cell, episodes: group }) => ({
    cell,
    accepted: group.filter((e) => e.outcome === "accepted").length,
    rejected: group.filter((e) => e.outcome === "rejected").length,
    cost_usd_mean: mean(group.flatMap((e) => (e.cost_usd === null ? [] : [e.cost_usd]))),
    duration_ms_mean: mean(group.flatMap((e) => (e.duration_ms === null ? [] : [e.duration_ms]))),
  }));
}

/** セルが表の候補行に当たるか。model は alias 行の部分一致(`windowMatchesModel`、
 *  ADR 0030 の線)、advisor は pin どうしの同じ照合。 */
function cellMatches(candidate: ExecutionSetting, cell: Cell): boolean {
  return (
    cell.provider === candidate.provider &&
    cell.effort === candidate.effort &&
    windowMatchesModel(candidate.model, cell.model) &&
    (candidate.advisor === undefined
      ? cell.advisor === null
      : cell.advisor !== null && windowMatchesModel(candidate.advisor, cell.advisor))
  );
}

/** 候補行1つの事後分布(Beta-Bernoulli)。事前分布は表の行 = 受理1件分の疑似観測
 *  (固定慣習、設定に出さない)。盤面全体の事後分布が workspace の事前分布なので、
 *  この workspace の episode は盤面の段と workspace の段で2度数えられる —— それが
 *  「自分の workspace の観測を他所より重く見る」機構そのものである。 */
function posterior(
  candidate: ExecutionSetting,
  board: readonly CellStats[],
  workspace: readonly CellStats[],
): { accepted: number; total: number; cost: number | null } {
  const matched = [...board, ...workspace].filter((s) => cellMatches(candidate, s.cell));
  const accepted = matched.reduce((n, s) => n + s.accepted, 0);
  const rejected = matched.reduce((n, s) => n + s.rejected, 0);
  const costs = matched.flatMap((s) => (s.cost_usd_mean === null ? [] : [s.cost_usd_mean]));
  return { accepted: 1 + accepted, total: 1 + accepted + rejected, cost: mean(costs) };
}

/** 推薦(純関数): 候補を事後平均で並べ、同点は selector の並びのまま。乱数は
 *  持たない(Thompson sampling をしないので seed も無い)。`priority` が cost の
 *  ときだけ、同点の間で観測された費用の平均が鍵になる —— 両方に観測があるときに
 *  限る(quality では Provider 順位が selector の並びに既に入っている)。 */
export function recommend(input: {
  candidates: readonly ExecutionSetting[];
  board: readonly CellStats[];
  workspace: readonly CellStats[];
  priority: Priority;
}): Recommendation {
  const scored = input.candidates.map((candidate, order) => ({
    candidate,
    order,
    ...posterior(candidate, input.board, input.workspace),
  }));
  // 事後平均の比較は整数の交差乗算 —— 浮動小数の「同点」で決定論が崩れない
  const ranked = [...scored].sort((a, b) => {
    const byMean = b.accepted * a.total - a.accepted * b.total;
    if (byMean !== 0) return byMean;
    if (input.priority === "cost" && a.cost !== null && b.cost !== null && a.cost !== b.cost) {
      return a.cost - b.cost;
    }
    return a.order - b.order;
  });
  // 候補が空なら来ない —— 全 entry 除外は selector が先に skipped にしている
  return {
    recommended: ranked[0]!.candidate,
    basis: scored.some((s) => s.total > 1) ? "data" : "prior",
  };
}

/** 観測された具体 id: `worker_exited.usage.models` の鍵のうち pin に当たるものが
 *  **ちょうど1つ**ならそれ、そうでなければ pin の綴りのまま。内訳から advisor を
 *  推定しない(events.ts の `models` の注記)ので、advisor は常に pin である。 */
function observedModel(pin: string, models: Record<string, unknown> | undefined): string {
  const hits = Object.keys(models ?? {}).filter((id) => windowMatchesModel(pin, id));
  return hits.length === 1 ? hits[0]! : pin;
}

type Spawned = EventRow & { payload: Extract<EventPayload, { kind: "worker_spawned" }> };

/** 学習器の episode に、routing meta-review の読み口が session を引き当てる鍵を足したもの。 */
export interface RoutingEpisode extends LearnerEpisode {
  task_id: string;
  worker_spawned_event_id: number;
  worker_exited_event_id: number | null;
  agent: string;
  source: Spawned["payload"]["source"];
}

/** 盤面境界の読み口: work task の worker session を1つ1 episode に(codex の
 *  session も含む —— Precedent の投影表は transcript を持つ session しか持たない
 *  ので、events を直に読む)。受理は task の派生なので task の**最後の** session に
 *  だけ付け、前の session は自分の窓の中の負の信号でしか数えない。異議の窓は
 *  Precedent と同じ規則(spawn より後、exit または次の spawn より前)。 */
// ponytail: pickup ごとに work task の全 session を読み直す。表が大きくなったら集計を増分で持つ
export function loadEpisodes(db: Db): RoutingEpisode[] {
  const tasks = db
    .prepare(
      `SELECT id, workspace, ${acceptedSql("tasks.id")} AS accepted FROM tasks
        WHERE type = 'work' AND EXISTS (SELECT 1 FROM events WHERE task_id = tasks.id AND kind = 'worker_spawned')`,
    )
    .all() as Array<Pick<Task, "id" | "workspace"> & { accepted: number }>;
  const events = (
    db
      .prepare(
        `SELECT * FROM events
          WHERE kind IN ('worker_spawned', 'worker_exited', 'objection_attributed', 'allocation_reviewed')
            AND task_id IN (SELECT id FROM tasks WHERE type = 'work') ORDER BY id`,
      )
      .all() as Array<Omit<EventRow, "payload"> & { payload: string }>
  ).map((r) => ({ ...r, payload: JSON.parse(r.payload) as EventPayload }));
  const spawns = events.filter((e): e is Spawned => e.payload.kind === "worker_spawned");
  return spawns.map((spawned) => {
    const task = tasks.find((t) => t.id === spawned.task_id)!;
    const { exited, hasNextSpawn, inSession } = sessionWindow(events, spawned);
    // 最新の帰責が entry ごとに有効(append-only、attribution.ts と同じ読み方)
    const causes = new Map<number, Cause>();
    const allocations: { allocation: Allocation; cause: Cause }[] = [];
    for (const e of events) {
      if (e.task_id !== spawned.task_id) continue;
      const p = e.payload;
      if (p.kind === "objection_attributed" && inSession({ id: p.entry_id, task_id: spawned.task_id })) causes.set(p.entry_id, p.cause);
      if (p.kind === "allocation_reviewed" && p.worker_spawned_event_id === spawned.id && "allocation" in p) {
        allocations.push({ allocation: p.allocation, cause: p.cause });
      }
    }
    const usage = exited?.payload.kind === "worker_exited" ? exited.payload.usage : null;
    return {
      task_id: spawned.task_id!,
      worker_spawned_event_id: spawned.id,
      worker_exited_event_id: exited?.id ?? null,
      agent: spawned.worker_id,
      source: spawned.payload.source,
      cell: {
        provider: spawned.payload.provider,
        model: observedModel(spawned.payload.model, usage?.models),
        effort: spawned.payload.effort,
        advisor: spawned.payload.advisor,
      },
      workspace: task.workspace,
      outcome: episodeOutcome({
        accepted: task.accepted === 1 && !hasNextSpawn,
        causes: [...causes.values()],
        allocations,
      }),
      cost_usd: usage?.estimated_cost_usd ?? null,
      duration_ms: exited ? Date.parse(exited.created_at) - Date.parse(spawned.created_at) : null,
    };
  });
}

/** shadow 行の書き手(盤面境界、spec #541): work task の pickup 直前に、除外を
 *  当てた候補から学習器の推薦を引いて、selector の実際の選択とその出所に並べて1行残す。
 *  **選択には介入しない** —— 返り値も無く、呼び手は結果を読まない。 */
export function recordShadow(
  db: Db,
  task: Pick<Task, "id" | "workspace" | "priority">,
  candidates: readonly ExecutionSetting[],
  actual: ExecutionSetting,
  now: Date,
): void {
  const episodes = loadEpisodes(db);
  const { recommended, basis } = recommend({
    candidates,
    board: aggregateCells(episodes),
    workspace: aggregateCells(episodes.filter((e) => e.workspace === task.workspace)),
    priority: task.priority ?? BOARD_DEFAULT_PRIORITY,
  });
  db.prepare(
    `INSERT INTO learner_shadow (task_id, cell_recommended, cell_actual, source, basis, event_watermark, created_at)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM events), ?)`,
  ).run(
    task.id,
    cellJson(cellOf(recommended)),
    cellJson(cellOf(actual)),
    JSON.stringify(actual.source),
    basis,
    now.toISOString(),
  );
}
