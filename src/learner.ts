import type { Allocation } from "./allocation-review.js";
import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import { type EventPayload, type EventRow, listEventsOfKinds, objectionBundles, sessionWindow } from "./events.js";
import type { ExecutionSetting } from "./execution-setting.js";
import type { Provider } from "./provider.js";
import { acceptedSql, type Task } from "./tasks.js";
import type { TierId } from "./tier.js";

/** 学習器のセル(CONTEXT.md「学習器」/ ADR 0110 決定4): spawn 時の pin の綴りの
 *  (provider, model id, effort, advisor model)—— 表の行は具体 id だけなので、main の pin が世代を
 *  名指す(ADR 0182 決定3)。advisor の綴りは `fable` か具体 id で、alias なら世代が進んでも同じセルに
 *  数え続ける(ADR 0200 決定6)。advisor も spawn 時の **pin**
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
 *  (プーリングの段)と走った段(`tier_id`、ADR 0210 決定3 —— 行は段を移るので、候補集合だけでは段が決まらない)。
 *  優先順位は selector の並びに入っている。agent / interview 種別はセルを割らず、読み手が生えたら tasks と
 *  events から引ける。費用と時間は session ごとの観測で、推薦の鍵にはならない
 *  (routing meta-review の shadow 行の読み口が読む、ADR 0183)。
 *  `outcome` の `excluded` は「まだ判定が無い」「帰責が worker の落ち度でない」で、
 *  受理率の分母に入らない(ADR 0115 決定5)。 */
export interface LearnerEpisode {
  cell: Cell;
  tier_id: TierId;
  workspace: string | null;
  outcome: "accepted" | "rejected" | "excluded";
  cost_usd: number | null;
  duration_ms: number | null;
}

/** 1 session の outcome(純関数)。受理は統合点レビューの完了からの派生(ADR 0111
 *  決定1、`acceptedSql`)で、0 は「保留」も含むので失敗とは読まない。負の信号は
 *  worker の落ち度と帰責された異議(`capability`)と、配分評価の underpowered ×
 *  capability だけ —— `preference` / `requirement_change` / `environment` / `memory`(ADR 0166 決定4)の異議は
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

/** セルごとの集計: 受理数と却下数。 */
export interface CellStats {
  cell: Cell;
  accepted: number;
  rejected: number;
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

/** episode 列 → セルの集計(純関数)。`excluded` は数えない。 */
export function aggregateCells(episodes: readonly LearnerEpisode[]): CellStats[] {
  const byKey = new Map<string, CellStats>();
  for (const e of episodes) {
    if (e.outcome === "excluded") continue;
    const key = cellJson(e.cell);
    const stats = byKey.get(key) ?? { cell: e.cell, accepted: 0, rejected: 0 };
    stats[e.outcome]++;
    byKey.set(key, stats);
  }
  return [...byKey.values()];
}

/** 推薦が数える観測(純関数、ADR 0210 決定2): 候補の段で走った episode だけを、盤面の段と workspace の段に集計する。
 *  行を段の間で移すと移った先では未観測になり、戻せば元の観測がまた数えられる。 */
export function observedInTier(
  episodes: readonly LearnerEpisode[],
  tier: TierId,
  workspace: string | null,
): { board: CellStats[]; workspace: CellStats[] } {
  const inTier = episodes.filter((e) => e.tier_id === tier);
  return { board: aggregateCells(inTier), workspace: aggregateCells(inTier.filter((e) => e.workspace === workspace)) };
}

/** セルが表の候補行に当たるか: model も advisor も完全一致(ADR 0182 決定3)—— 部分一致だと `claude-opus-5` の行が
 *  `claude-opus-5-5` の実績を拾う。Throttle の窓の部分一致(`windowMatchesModel`)とは別の式。 */
function cellMatches(candidate: ExecutionSetting, cell: Cell): boolean {
  return (
    cell.provider === candidate.provider &&
    cell.effort === candidate.effort &&
    cell.model === candidate.model &&
    cell.advisor === (candidate.advisor ?? null)
  );
}

/** 候補行1つの1段の実績: その段の集計のうち行に当たるセルの受理数と却下数(疑似観測を含まない)。 */
type Tally = { accepted: number; rejected: number };
const tally = (candidate: ExecutionSetting, stats: readonly CellStats[]): Tally => {
  const matched = stats.filter((s) => cellMatches(candidate, s.cell));
  return { accepted: matched.reduce((n, s) => n + s.accepted, 0), rejected: matched.reduce((n, s) => n + s.rejected, 0) };
};

/** 候補行1つの、推薦が数えた実績(盤面の段と workspace の段を分けたまま)。shadow 行が両セルについて運ぶ(ADR 0181 決定5)。 */
export interface TrackRecord {
  board: Tally;
  workspace: Tally;
}
const trackRecord = (candidate: ExecutionSetting, board: readonly CellStats[], workspace: readonly CellStats[]): TrackRecord => ({
  board: tally(candidate, board),
  workspace: tally(candidate, workspace),
});

/** 推薦(純関数): 候補行ごとの事後分布(Beta-Bernoulli)を並べる。事前分布は表の行 = 受理1件分の疑似観測(固定慣習、
 *  設定に出さない)。盤面全体の事後分布が workspace の事前分布なので、この workspace の episode は盤面の段と workspace の段で
 *  2度数えられる —— それが「自分の workspace の観測を他所より重く見る」機構そのものである。
 *  学習器は未観測の候補へ移らない(ADR 0181 決定1・2): 先頭(selector の並びの1番目)が未観測ならそれが推薦。先頭に観測が
 *  あれば、観測のある候補が先頭に勝つかを1つずつ比べる —— 先頭の観測数が候補より少ないあいだは却下数(先頭の却下が多いときだけ
 *  勝つ —— 先頭が残りを全部受理しても追いつけない、ADR 0182 決定4)、それ以外は事後平均の並べ方で先頭より前に来るとき。
 *  勝つ候補が無ければ先頭、あればその中で並べ方の1番目。並べ方は事後平均 → selector の並び —— 観測された session 費用は
 *  鍵にしない(ADR 0183。cost の鍵は表の価格で、selector の並びに既に入っている)。
 *  乱数は持たない(Thompson sampling をしないので seed も無い)。 */
export function recommend(input: {
  candidates: readonly ExecutionSetting[];
  board: readonly CellStats[];
  workspace: readonly CellStats[];
}): Recommendation {
  const scored = input.candidates.map((candidate, order) => {
    const { board, workspace } = trackRecord(candidate, input.board, input.workspace);
    const accepted = board.accepted + workspace.accepted;
    const rejected = board.rejected + workspace.rejected;
    const observed = accepted + rejected;
    return { candidate, order, observed, rejected, accepted: 1 + accepted, total: 1 + observed };
  });
  type Scored = (typeof scored)[number];
  // 事後平均の比較は整数の交差乗算 —— 浮動小数の「同点」で決定論が崩れない
  const byOrdering = (a: Scored, b: Scored) => b.accepted * a.total - a.accepted * b.total || a.order - b.order;
  // 候補が空なら来ない —— 全 entry 除外は selector が先に skipped にしている
  const [head, ...rest] = scored as [Scored, ...Scored[]];
  const beatsHead = (c: Scored) =>
    c.observed > 0 && (head.observed < c.observed ? head.rejected > c.rejected : byOrdering(c, head) < 0);
  const winners = head.observed > 0 ? rest.filter(beatsHead).sort(byOrdering) : [];
  return {
    recommended: (winners[0] ?? head).candidate,
    basis: scored.some((s) => s.observed > 0) ? "data" : "prior",
  };
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
  // work task だけに絞る(spawn を持つ work task —— session の窓も配分の評価も spawn のタスクの event しか見ない)
  const workIds = new Set<string | null>(tasks.map((t) => t.id));
  const events = listEventsOfKinds(db, ["worker_spawned", "worker_exited", "allocation_reviewed"]).filter((e) => workIds.has(e.task_id));
  // 異議群ごとの有効な判定(同じ異議群では後の event が有効)をすべて —— 前の異議群の capability を後の異議群の
  // preference で消さない(ADR 0170 決定3)
  const attributions = [...objectionBundles(db).values()].flat().flatMap((b) => (b.attribution ? [{ ...b.attribution, task_id: b.task_id }] : []));
  const spawns = events.filter((e): e is Spawned => e.payload.kind === "worker_spawned");
  return spawns.map((spawned) => {
    const task = tasks.find((t) => t.id === spawned.task_id)!;
    const { exited, hasNextSpawn, inSession } = sessionWindow(events, spawned);
    // 異議群のタスク(= entry のタスク)で窓に入れる
    const causes = attributions.filter((a) => inSession({ id: a.entry_id, task_id: a.task_id })).map((a) => a.cause);
    const allocations: { allocation: Allocation; cause: Cause }[] = [];
    for (const e of events) {
      if (e.task_id !== spawned.task_id) continue;
      const p = e.payload;
      if (p.kind === "allocation_reviewed" && p.worker_spawned_event_id === spawned.id) {
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
        model: spawned.payload.model,
        effort: spawned.payload.effort,
        advisor: spawned.payload.advisor,
      },
      tier_id: spawned.payload.tier_id,
      workspace: task.workspace,
      outcome: episodeOutcome({
        accepted: task.accepted === 1 && !hasNextSpawn,
        causes,
        allocations,
      }),
      cost_usd: usage?.estimated_cost_usd ?? null,
      duration_ms: exited ? Date.parse(exited.created_at) - Date.parse(spawned.created_at) : null,
    };
  });
}

/** selector の分岐(純関数、ADR 0110 決定4 / ADR 0150 決定3): 除外を当てた候補(selector の並び)から、実際に走る設定と
 *  shadow 行の組を決める。昇格前は表の先頭が走り、shadow の推薦は学習器の選択。昇格後は学習器の選択が出所 `learner` で
 *  走り、shadow の推薦は表の先頭 —— 列は増えず意味が反転する。学習器は未観測の候補へ移らず未観測の先頭はそのまま走るので
 *  (ADR 0181)、どの候補にも観測が無い昇格初日も、人間が先頭に置いた新しい行も、昇格の前後で同じ設定が走る。
 *  組は両セルのその時点の実績と候補数(除外後の行の数)を運ぶ(ADR 0181 決定5)。 */
export function selectorBranch(input: Parameters<typeof recommend>[0] & { promoted: boolean }): {
  chosen: ExecutionSetting;
  shadow: {
    recommended: ExecutionSetting;
    actual: ExecutionSetting;
    basis: Recommendation["basis"];
    recommended_record: TrackRecord;
    actual_record: TrackRecord;
    candidates: number;
  };
} {
  const table = input.candidates[0]!;
  const { recommended, basis } = recommend(input);
  const chosen = input.promoted ? { ...recommended, source: { ...recommended.source, provider: "learner" as const } } : table;
  const other = input.promoted ? table : recommended;
  const record = (s: ExecutionSetting) => trackRecord(s, input.board, input.workspace);
  return {
    chosen,
    shadow: { recommended: other, actual: chosen, basis, recommended_record: record(other), actual_record: record(chosen), candidates: input.candidates.length },
  };
}

/** shadow 行の書き手(盤面境界、spec #541): work task の pickup 直前に、selector の分岐が決めた組を1行残す。返り値は行の id。 */
export function recordShadow(db: Db, taskId: string, shadow: ReturnType<typeof selectorBranch>["shadow"], now: Date): number {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO learner_shadow (task_id, cell_recommended, cell_actual, source, basis, record_recommended, record_actual, candidates, event_watermark, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM events), ?)`,
  ).run(
    taskId,
    cellJson(cellOf(shadow.recommended)),
    cellJson(cellOf(shadow.actual)),
    JSON.stringify(shadow.actual.source),
    shadow.basis,
    JSON.stringify(shadow.recommended_record),
    JSON.stringify(shadow.actual_record),
    shadow.candidates,
    now.toISOString(),
  );
  return Number(lastInsertRowid);
}
