import type { Db } from "./db.js";
import type { EventPayload } from "./events.js";
import { type ExecutionSettingsChange, windowMatchesModel } from "./execution-setting.js";
import { type Cell, cellJson, loadEpisodes, type RoutingEpisode } from "./learner.js";
import { PAGE_LENGTH, previousMetaReviewWatermark } from "./meta-review.js";

/** 主題 routing の meta-review の読み口(issue #917 / spec #916 C)。どれも既定の `since_watermark` は読み手と同主題の
 *  前回の登録の watermark(event id)で、ページ長は memory の読み口と同じ定数。 */

interface ReadWindow {
  since_watermark?: number;
  page?: number;
}

function paged<T>(rows: readonly T[], page = 1): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice((page - 1) * PAGE_LENGTH, page * PAGE_LENGTH), truncated: rows.length > page * PAGE_LENGTH };
}

const since = (db: Db, readerTaskId: string, input: ReadWindow) => input.since_watermark ?? previousMetaReviewWatermark(db, readerTaskId);

/** shadow 行を、その pickup が開いた session の outcome と結ぶ。session = 同じ task の、行の watermark より後で次の
 *  shadow 行より前の最初の worker_spawned(spawn に辿り着かなかった pickup は session 無し)。`diverged` は学習器の推薦と
 *  実際に走ったセルが違う行で、`diverged_only` でそれだけに絞る。 */
export function listRoutingShadow(db: Db, readerTaskId: string, input: ReadWindow & { diverged_only?: boolean }) {
  const rows = db
    .prepare("SELECT task_id, cell_recommended, cell_actual, source, basis, event_watermark, created_at FROM learner_shadow ORDER BY id")
    .all() as Array<{ task_id: string; cell_recommended: string; cell_actual: string; source: string; basis: "prior" | "data"; event_watermark: number; created_at: string }>;
  const episodes = loadEpisodes(db);
  const from = since(db, readerTaskId, input);
  const shadow = rows.flatMap((row, i) => {
    if (row.event_watermark < from) return [];
    const diverged = row.cell_recommended !== row.cell_actual;
    if (input.diverged_only && !diverged) return [];
    // ponytail: 行ごとに後続の行と全 episode を走査する O(n²)。shadow が大きくなったら task ごとに1度だけ並べる
    const next = rows.slice(i + 1).find((r) => r.task_id === row.task_id)?.event_watermark ?? Infinity;
    const session = episodes.find(
      (e) => e.task_id === row.task_id && e.worker_spawned_event_id > row.event_watermark && e.worker_spawned_event_id <= next,
    );
    return [
      {
        task_id: row.task_id,
        recommended: JSON.parse(row.cell_recommended) as Cell,
        actual: JSON.parse(row.cell_actual) as Cell,
        source: JSON.parse(row.source) as RoutingEpisode["source"],
        basis: row.basis,
        diverged,
        created_at: row.created_at,
        worker_spawned_event_id: session?.worker_spawned_event_id ?? null,
        agent: session?.agent ?? null,
        outcome: session?.outcome ?? null,
        cost_usd: session?.cost_usd ?? null,
        duration_ms: session?.duration_ms ?? null,
      },
    ];
  });
  const { rows: shown, truncated } = paged(shadow, input.page);
  return { shadow: shown, truncated };
}

/** 配分評価の分布: 評価された注釈を worker session の (`source.tier`, agent, allocation, cause) で数え、judge の model が
 *  worker のセルの model と同じだった件数を添える(ADR 0150 決定8)。unevaluated の注釈は分布に入らない。 */
export function listAllocations(db: Db, readerTaskId: string, input: ReadWindow) {
  const episodes = new Map(loadEpisodes(db).map((e) => [e.worker_spawned_event_id, e]));
  const annotations = db
    .prepare("SELECT payload FROM events WHERE kind = 'allocation_reviewed' AND id > ? ORDER BY id")
    .all(since(db, readerTaskId, input)) as Array<{ payload: string }>;
  const groups = new Map<string, { source_tier: string; agent: string; allocation: string; cause: string; count: number; judged_by_same_model: number }>();
  for (const { payload } of annotations) {
    const p = JSON.parse(payload) as Extract<EventPayload, { kind: "allocation_reviewed" }>;
    const episode = p.worker_spawned_event_id === null ? undefined : episodes.get(p.worker_spawned_event_id);
    if (!("allocation" in p) || !episode) continue;
    const key = JSON.stringify([episode.source.tier, episode.agent, p.allocation, p.cause]);
    const group = groups.get(key) ?? { source_tier: episode.source.tier, agent: episode.agent, allocation: p.allocation, cause: p.cause, count: 0, judged_by_same_model: 0 };
    group.count += 1;
    // judge は表の行の綴り(alias 可)、セルは観測された具体 id —— 表の照合と同じ部分一致
    if (p.judge?.provider === episode.cell.provider && windowMatchesModel(p.judge.model, episode.cell.model)) group.judged_by_same_model += 1;
    groups.set(key, group);
  }
  const { rows, truncated } = paged([...groups.values()], input.page);
  return { allocations: rows, truncated };
}

/** 新しいセルと人間が変えた行: 観測(worker_exited)で初めて現れたのが watermark より後のセルと、watermark より後に
 *  settings タブ / 管理MCP から書かれた表の行(`execution_settings_changed` の `row`)。 */
export function listRoutingCells(db: Db, readerTaskId: string, input: ReadWindow) {
  const from = since(db, readerTaskId, input);
  const firstSeen = new Map<string, { cell: Cell; first_observed_event_id: number }>();
  for (const e of loadEpisodes(db)) {
    if (e.worker_exited_event_id === null) continue;
    const key = cellJson(e.cell);
    const seen = firstSeen.get(key);
    if (!seen || e.worker_exited_event_id < seen.first_observed_event_id) firstSeen.set(key, { cell: e.cell, first_observed_event_id: e.worker_exited_event_id });
  }
  const changed = (
    db
      .prepare(
        `SELECT id, origin, payload, created_at FROM events
          WHERE kind = 'execution_settings_changed' AND json_extract(payload, '$.setting') = 'row' AND id > ? ORDER BY id`,
      )
      .all(from) as Array<{ id: number; origin: string; payload: string; created_at: string }>
  ).map((r) => ({ event_id: r.id, origin: r.origin, created_at: r.created_at, row: (JSON.parse(r.payload) as Extract<ExecutionSettingsChange, { setting: "row" }>).row }));
  // 人間の行の編集は数件なのでページに割らず全部返す
  const { rows: cells, truncated } = paged([...firstSeen.values()].filter((c) => c.first_observed_event_id > from), input.page);
  return { cells, rows: changed, truncated };
}
