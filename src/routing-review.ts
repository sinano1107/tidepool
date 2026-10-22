import { type AgentView, agentViewProviders } from "./agent-create.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import { type EventOrigin, type EventPayload, getEvent, listEventsOfKinds } from "./events.js";
import {
  assertPosition,
  assertRowFits,
  assertTierDescription,
  assertTierName,
  assertTierRunnableFor,
  boardDefaultTier,
  composeRoutingRow,
  loadExecutionSettingTable,
  matchesRowKey,
  parseRoutingRowChange,
  type RowKey,
  readExecutionSettings,
  rowName,
} from "./execution-setting.js";
import { type Cell, cellJson, loadEpisodes, loadSeeds, type RoutingEpisode, type TrackRecord } from "./learner.js";
import {
  completeMetaReview,
  injectedMaterial,
  inWindow,
  type MetaReviewWindow,
  materialSection,
  metaReviewWindow,
  objectedJudgments,
  previousMetaReviewWatermark,
  ROUTING_META_REVIEW_VERBS,
  repairJudgments,
} from "./meta-review.js";
import { normalizeText, whyBlank } from "./required-text.js";
import { type Packed, packItems, readPosition } from "./response-budget.js";
import {
  assertInterviewFields,
  getTask,
  type HandoffDoc,
  type InterviewProposal,
  type InterviewTarget,
  listChildren,
  type RegistryProposal,
  type RoutingAddTierProposal,
  type RoutingProposal,
  registerTask,
  type Task,
  type TierDescriptionProposal,
} from "./tasks.js";
import { assertKnownTier, liveTierRows, proposalTierNames, type Tier, type TierId, tierIdOf, tierNameOf, tierNames } from "./tier.js";

/** 主題 routing の meta-review の読み口(issue #917 / spec #916 C)。どれも既定の `since_watermark` は読み手と同主題の
 *  前回の登録の watermark(event id)で、応答予算と続き(next)で返す(ADR 0195)。 */

interface ReadWindow {
  since_watermark?: number;
}

const since = (db: Db, readerTaskId: string, args: ReadWindow) => args.since_watermark ?? previousMetaReviewWatermark(db, readerTaskId);

/** shadow 行を、その pickup が開いた session の outcome と結ぶ。session = 同じ task の、行の watermark より後で次の
 *  shadow 行より前の最初の worker_spawned(spawn に辿り着かなかった pickup は session 無し)。`diverged` は学習器の推薦と
 *  実際に走ったセルが違う行で、`diverged_only` でそれだけに絞る。 */
export function listRoutingShadow(db: Db, readerTaskId: string, input: ReadWindow & { diverged_only?: boolean; next?: string }) {
  const read = readPosition<ReadWindow & { diverged_only?: boolean }>("list_routing_shadow", input);
  // 境目の鍵は learner_shadow の id —— 応答の行には載せないので、同じ位置の元の行から引く
  const kept = shadowRows(db, { after: since(db, readerTaskId, read.args) }).filter((row) => !read.args.diverged_only || row.diverged);
  const shadow = kept.map(({ id: _, ...row }) => row);
  return packItems(read, "shadow", shadow, {}, { keyOf: (_, i) => kept[i]!.id }) as Packed<{ shadow: typeof shadow }>;
}

/** list_routing_shadow の行(ページ割り前、learner_shadow の id つき)。行の watermark W は event W より後に書かれたので、窓
 *  `(after, upTo]` の行は `after <= W < upTo`。session は窓で切らない。 */
function shadowRows(db: Db, { after, upTo = Number.MAX_SAFE_INTEGER }: MetaReviewWindow) {
  const rows = db
    .prepare(
      "SELECT id, task_id, cell_recommended, cell_actual, source, basis, record_recommended, record_actual, candidates, event_watermark, created_at FROM learner_shadow ORDER BY id",
    )
    .all() as Array<{
    id: number;
    task_id: string;
    cell_recommended: string;
    cell_actual: string;
    source: string;
    basis: "prior" | "data";
    record_recommended: string;
    record_actual: string;
    candidates: number;
    event_watermark: number;
    created_at: string;
  }>;
  const episodes = loadEpisodes(db);
  return rows.flatMap((row, i) => {
    if (row.event_watermark < after || row.event_watermark >= upTo) return [];
    const diverged = row.cell_recommended !== row.cell_actual;
    // ponytail: 行ごとに後続の行と全 episode を走査する O(n²)。shadow が大きくなったら task ごとに1度だけ並べる
    const next = rows.slice(i + 1).find((r) => r.task_id === row.task_id)?.event_watermark ?? Infinity;
    const session = episodes.find(
      (e) => e.task_id === row.task_id && e.worker_spawned_event_id > row.event_watermark && e.worker_spawned_event_id <= next,
    );
    return [
      {
        id: row.id,
        task_id: row.task_id,
        recommended: JSON.parse(row.cell_recommended) as Cell,
        actual: JSON.parse(row.cell_actual) as Cell,
        source: JSON.parse(row.source) as RoutingEpisode["source"],
        basis: row.basis,
        recommended_record: JSON.parse(row.record_recommended) as TrackRecord,
        actual_record: JSON.parse(row.record_actual) as TrackRecord,
        candidates: row.candidates,
        diverged,
        created_at: row.created_at,
        worker_spawned_event_id: session?.worker_spawned_event_id ?? null,
        // 学習器が数える層と同じ値 —— Interview の提案の実環境はここから選ぶ(ADR 0258 決定3)
        workspace: session?.workspace ?? null,
        agent: session?.agent ?? null,
        outcome: session?.outcome ?? null,
        cost_usd: session?.cost_usd ?? null,
        duration_ms: session?.duration_ms ?? null,
      },
    ];
  });
}

/** 配分評価の分布: 注釈を worker session の (`source.tier`, 段, agent, allocation, cause) で数え、judge の model が
 *  worker のセルの model と同じだった件数を添える(ADR 0150 決定8)。段はどの出所の session にも付き、その session が走った段
 *  (ADR 0210 決定5)。段は id で割り、消した段には `tier_retired` が付く。 */
export function listAllocations(db: Db, readerTaskId: string, input: ReadWindow & { next?: string }) {
  const read = readPosition<ReadWindow>("list_allocations", input);
  const { groups, keys } = allocationRows(db, { after: since(db, readerTaskId, read.args) });
  // 境目の鍵は数える単位そのもの(tier の出所・段の id・agent・allocation・cause)
  return packItems(read, "allocations", groups, {}, { keyOf: (_, i) => keys[i]! }) as Packed<{ allocations: typeof groups }>;
}

/** list_allocations の行(ページ割り前)とその鍵と、数えた allocation_reviewed の event id。 */
function allocationRows(db: Db, window: MetaReviewWindow) {
  const episodes = new Map(loadEpisodes(db).map((e) => [e.worker_spawned_event_id, e]));
  const tierOf = db.prepare("SELECT name, position IS NULL AS retired FROM tiers WHERE id = ?");
  const counted: number[] = [];
  const groups = new Map<
    string,
    { source_tier: string; tier: Tier; tier_retired?: true; agent: string; allocation: string; cause: string; count: number; judged_by_same_model: number }
  >();
  for (const { id, payload: p } of listEventsOfKinds(db, ["allocation_reviewed"], window)) {
    const episode = episodes.get(p.worker_spawned_event_id);
    if (!episode) continue;
    counted.push(id);
    const key = JSON.stringify([episode.source.tier, episode.tier_id, episode.agent, p.allocation, p.cause]);
    const tier = tierOf.get(episode.tier_id) as { name: Tier; retired: number };
    const group = groups.get(key) ?? {
      source_tier: episode.source.tier,
      tier: tier.name,
      ...(tier.retired ? { tier_retired: true as const } : {}),
      agent: episode.agent,
      allocation: p.allocation,
      cause: p.cause,
      count: 0,
      judged_by_same_model: 0,
    };
    group.count += 1;
    // judge は表の行の綴り、セルは pin の綴り —— 学習器が行に当てるのと同じ完全一致(ADR 0182 決定3)
    if (p.judge.provider === episode.cell.provider && p.judge.model === episode.cell.model) group.judged_by_same_model += 1;
    groups.set(key, group);
  }
  return { groups: [...groups.values()], keys: [...groups.keys()], counted };
}

/** 新しいセルと人間が変えた行: 観測(worker_exited)で初めて現れたのが watermark より後のセルと、watermark より後に
 *  settings タブ / 管理MCP から書かれた表の行(`execution_settings_changed` の `row`、編集なら置き換えた行の `key` も)。提案 question への approve の適用は
 *  read_routing_settings が読むので含まない(ADR 0151 決定2)。 */
export function listRoutingCells(db: Db, readerTaskId: string, input: ReadWindow & { next?: string }) {
  const read = readPosition<ReadWindow>("list_routing_cells", input);
  const { cells, rows } = cellRows(db, { after: since(db, readerTaskId, read.args) });
  // 人間の行の編集は数件なので封筒として最初の応答に全部載せ、続きはセルだけ。セルの境目の鍵はセルそのもの(cellJson)
  return packItems(read, "cells", cells, { rows }, { keyOf: (c) => cellJson(c.cell) }) as Packed<{ cells: typeof cells }, { rows: typeof rows }>;
}

/** read_routing_settings: 今の表と設定(封筒、最初の応答だけ)と、過去の提案(古い順、境目の鍵は提案の question id)。 */
export function readRoutingSettings(db: Db, input: { next?: string }) {
  const read = readPosition("read_routing_settings", input);
  const proposals = listRoutingProposals(db);
  return packItems(read, "proposals", proposals, readExecutionSettings(db), { keyOf: (p) => p.question_id }) as Packed<
    { proposals: typeof proposals },
    ReturnType<typeof readExecutionSettings>
  >;
}

/** list_routing_cells の2種の行(ページ割り前): 窓 `(after, upTo]` に本番の初観測か種の event があるセルと、窓の中の人間の行の
 *  編集。受験者の session は観測ではないので初観測に数えない。セルはその provider / model / effort の種を段ごとに運ぶが、行の
 *  ある (セル, 段) の種だけ —— 行を消しても種の event は残るが、読み手は読まない(spec #2190 / ADR 0273 決定7)。本番の session の
 *  まだ無い種のセルは advisor null・初観測 null で載る。 */
function cellRows(db: Db, window: MetaReviewWindow) {
  const firstSeen = new Map<string, { cell: Cell; first_observed_event_id: number | null }>();
  for (const e of loadEpisodes(db)) {
    if (e.interview || e.worker_exited_event_id === null) continue;
    const key = cellJson(e.cell);
    const seen = firstSeen.get(key);
    if (!seen || e.worker_exited_event_id < seen.first_observed_event_id!) firstSeen.set(key, { cell: e.cell, first_observed_event_id: e.worker_exited_event_id });
  }
  const rows = listEventsOfKinds(db, ["execution_settings_changed"], window).flatMap(({ id, origin, created_at, payload: p }) =>
    p.setting === "row" && p.question_id === undefined ? [{ event_id: id, origin, created_at, ...(p.key && { key: p.key }), row: p.row, ...(p.seed && { seed: p.seed }) }] : [],
  );
  const table = loadExecutionSettingTable(db);
  const liveTiers = new Map(liveTierRows(db).map((t) => [t.id, t.name]));
  const seeds = loadSeeds(db).flatMap(({ cell, tier_id, kind, event_id }) => {
    const tier = liveTiers.get(tier_id);
    return tier !== undefined && table.some((row) => row.tier === tier && matchesRowKey(row, cell)) ? [{ cell, tier, kind, event_id }] : [];
  });
  for (const { cell } of seeds) {
    if (![...firstSeen.values()].some((c) => matchesRowKey(c.cell, cell))) firstSeen.set(cellJson({ ...cell, advisor: null }), { cell: { ...cell, advisor: null }, first_observed_event_id: null });
  }
  const cells = [...firstSeen.values()]
    .map((c) => ({ ...c, seeds: seeds.filter((s) => matchesRowKey(c.cell, s.cell)).map(({ tier, kind, event_id }) => ({ tier, kind, event_id })) }))
    .filter((c) => (c.first_observed_event_id !== null && inWindow(c.first_observed_event_id, window)) || c.seeds.some((s) => inWindow(s.event_id, window)));
  return { cells, rows };
}

/** 過去の routing / registry の提案(spec #916 C): 提案、回答(question_answered の答え・修正値・コメント)、observed の理由
 *  (routing_proposal_stale)、registry へ適用した tier の提案なら着地した commit(agent_tier_changed)。提案の表は持たず question と
 *  event から組む。verb は窓で切らない —— 退けられた提案を繰り返さないための読み物なので、全期間を返す。window を渡すと、回答か
 *  陳腐化の event がその窓 `(after, upTo]` にある提案だけ(材料の節の決着した提案、ADR 0180 追記 #1239)。 */
function listRoutingProposals(db: Db, window?: MetaReviewWindow) {
  const rows = db
    .prepare(
      `SELECT t.id, t.question_proposal,
         (SELECT payload FROM events WHERE task_id = t.id AND kind = 'question_answered') AS answered,
         (SELECT payload FROM events WHERE task_id = t.id AND kind = 'routing_proposal_stale') AS stale,
         (SELECT payload FROM events WHERE kind = 'agent_tier_changed' AND json_extract(payload, '$.question_id') = t.id) AS applied,
         (SELECT MAX(id) FROM events WHERE task_id = t.id AND kind IN ('question_answered', 'routing_proposal_stale')) AS settled_id
       FROM tasks t WHERE json_extract(t.question_proposal, '$.kind') IN ('routing', 'registry') ORDER BY t.rowid`,
    )
    .all() as Array<{ id: string; question_proposal: string; answered: string | null; stale: string | null; applied: string | null; settled_id: number | null }>;
  const settled = rows.filter(({ settled_id }) => !window || inWindow(settled_id, window));
  return settled.map((row) => {
    const answered = row.answered === null ? null : (JSON.parse(row.answered) as Extract<EventPayload, { kind: "question_answered" }>);
    const stale = row.stale === null ? null : (JSON.parse(row.stale) as Extract<EventPayload, { kind: "routing_proposal_stale" }>);
    const applied = row.applied === null ? null : (JSON.parse(row.applied) as Extract<EventPayload, { kind: "agent_tier_changed" }>);
    return {
      question_id: row.id,
      proposal: proposalTierNames(db, JSON.parse(row.question_proposal) as RoutingProposal | RegistryProposal),
      answer: answered?.answers[0]?.answer ?? null,
      amendment: answered?.amendment ?? null,
      comment: answered?.comment ?? null,
      observed: stale && { changed: stale.changed, observed_event_id: stale.observed_event_id },
      ...(applied && { applied: { registry_commit: applied.registry_commit, from: applied.from, to: applied.to } }),
    };
  });
}

/** routing meta-review の評価の対象(ADR 0278 決定5・追記5): 行は (provider, model, effort) の3欄、段は盤面の中の照合なので id で名指す
 *  (ADR 0200 決定2)。判断ログの行の `judgment` が持つ。 */
export type RoutingObject = { row: RowKey } | { agent: string } | { tier_id: TierId } | { learner: true };
/** 判断を要する項目(材料の部分と注入の記録): 対象に、盤面が読み物として行には今の表の段を、段にはその名前を添える。 */
export type RoutingJudgmentItem = { row: RowKey; tier: Tier } | { agent: string } | { tier_id: TierId; tier: Tier } | { learner: true };
/** complete_routing_review が受ける判断の鍵(節の Items to judge が並べる形): 段は名前で名指し、行に添えた段は省ける。 */
export type RoutingJudgmentKey = { row: RowKey; tier?: Tier } | { agent: string } | { tier: Tier } | { learner: true };

/** 項目を verb の鍵の形に(節の Items to judge が並べる形)。 */
export const judgmentKey = (item: RoutingJudgmentItem): RoutingJudgmentKey => ("tier_id" in item ? { tier: item.tier } : item);

/** 対象を文面で名指す綴り(拒否文と判断ログの文)。行は rowName、段は名前。 */
const itemName = (item: { row: Parameters<typeof rowName>[0] } | { agent: string } | { tier: Tier } | { learner: true }) =>
  "row" in item ? rowName(item.row) : "agent" in item ? `agent ${item.agent}` : "tier" in item ? `tier ${item.tier}` : "the learner";

/** 提案が写す対象(ADR 0278 決定5): op で写す —— `row` / `add_tier` は動かす行、`agent_tier` は agent、`tier_description` は段、
 *  `promote` / `demote` は学習器、`interview` は根拠 session が走った行(pin の行)。完了の被覆と修理子の対象の門が共有する。 */
function proposalObjects(proposal: RoutingProposal | RegistryProposal): RoutingObject[] {
  if (proposal.kind === "registry") return [{ agent: proposal.agent }];
  switch (proposal.op) {
    case "row":
    case "add_tier":
      return [{ row: proposal.row }];
    case "tier_description":
      return [{ tier_id: proposal.tier }];
    case "interview":
      return proposal.pin.rows.map((row) => ({ row }));
    case "promote":
    case "demote":
      return [{ learner: true }];
    default:
      return proposal satisfies never;
  }
}

/** この review の提案 question が判断済みにする対象。 */
const proposedObjects = (db: Db, reviewId: string): RoutingObject[] =>
  listChildren(db, reviewId).flatMap(({ question_proposal: p }) => (p?.kind === "routing" || p?.kind === "registry" ? proposalObjects(p) : []));

/** routing_repair の提案の門(ADR 0279 決定4): 提案が写す対象(proposalObjects)は、修理子が運ぶ判断の行が名指す対象だけ。段は
 *  名前でなく id で突き合わせる —— 名前は生きている段の中でだけ一意で、退役した段の名前は後から別の段が取れる。拒否文は今の名前で名指す。 */
function requireRepairReach(db: Db, repairId: string, proposal: RoutingProposal | RegistryProposal): void {
  const key = (object: RoutingObject) => ("tier_id" in object ? `tier_id ${object.tier_id}` : itemName(object));
  const named = new Set(repairJudgments(db, repairId, "routing").map(key));
  const outside = proposalObjects(proposal).find((object) => !named.has(key(object)));
  if (!outside) return;
  const name = itemName("tier_id" in outside ? { tier: tierNameOf(db, outside.tier_id) } : outside);
  throw new DomainError(`${name} is not named by the objected judgment: a routing repair proposes only on what that judgment names`);
}

/** routing_repair の verb(ADR 0279 決定4): routing の判断の行を運べば routing meta-review の読み口と提案 verb —— 親の主題の読み手として
 *  指針の節を受けるので、その id 読み(read_memory_entries)も持つ(ADR 0283 決定3)。型つきの行を運ばなければ無い(基本の面だけ)。
 *  Codex の `enabled_tools` が読み、MCP の登録も同じこの判定で登録する。 */
export const routingRepairVerbs = (db: Db, taskId: string): string[] => (repairJudgments(db, taskId, "routing").length === 0 ? [] : [...ROUTING_META_REVIEW_VERBS]);

/** 材料の記録の後に誰であれ対象を変えた event(ADR 0278 追記4・追記5): 行は表の行の書き込みと削除(提案の approve の適用も)、agent は registry
 *  への段の書き込み、段は説明の書き換え(位置の移動・段の追加・改名は段の定義を変えない)、学習器は昇格 / 降格。段の event は名前で名指すので、
 *  注入した名前から改名をたどって id に引く。 */
function actedSince(db: Db, recordId: number, injectedTiers: ReadonlyMap<TierId, Tier>): RoutingObject[] {
  const tierIds = new Map([...injectedTiers].map(([id, name]) => [name, id]));
  return listEventsOfKinds(db, ["execution_settings_changed", "agent_tier_changed"], { after: recordId }).flatMap(({ payload: p }): RoutingObject[] => {
    if (p.kind === "agent_tier_changed") return [{ agent: p.agent }];
    if (p.setting === "row") return [{ row: p.row }, ...(p.key ? [{ row: p.key }] : [])];
    if (p.setting === "delete_row") return [{ row: p }];
    if (p.setting === "learner_promoted") return [{ learner: true }];
    const id = "name" in p ? tierIds.get(p.name) : undefined;
    if (id === undefined) return [];
    if (p.setting === "rename_tier") {
      tierIds.delete(p.name);
      tierIds.set(p.to, id);
    }
    return p.setting === "edit_tier" && p.description !== undefined ? [{ tier_id: id }] : [];
  });
}

/** routing meta-review の完了(ADR 0278 決定2〜5・追記4・追記5): 注入した一覧のうち、今も項目で、この review の提案も記録の後の誰かの
 *  変更も判断済みにしていない対象に no_change が要る(骨格は completeMetaReview)。段は id で同じ項目で、鍵は注入した名前 —— spawn 後の
 *  改名は行為ではない。文には行なら今の段を、段なら今の名前を書く。`precedents` は読み手の窓の異議つき判断(memory.ts の routingPrecedents ——
 *  import の循環を避けて呼び手が渡す)、`agents` は registry の agent 一覧(今の項目の agent の絞り込み)。 */
export function completeRoutingReview(
  db: Db,
  review: Task,
  input: { judgments: Array<RoutingJudgmentKey & { reason?: string }>; handoff?: Partial<HandoffDoc> },
  workerId: string,
  now: Date,
  origin: EventOrigin,
  precedents: { decision_event_id: number }[],
  agents?: readonly RegistryAgent[],
): Task {
  // 自身の列: 問いは「この task は meta-review か」で、行の主題ではない(ADR 0283 決定1)
  if (review.meta_review_subject !== "routing") throw new DomainError("only a routing meta-review completes with complete_routing_review");
  const record = injectedMaterial(db, review.id, "routing");
  const injectedTiers = new Map(record.items.flatMap((item) => ("tier_id" in item ? [[item.tier_id, item.tier] as const] : [])));
  const key = (item: RoutingObject | RoutingJudgmentItem | RoutingJudgmentKey) =>
    itemName("tier_id" in item ? { tier: injectedTiers.get(item.tier_id) ?? tierNameOf(db, item.tier_id) } : item);
  const judged = new Set([...proposedObjects(db, review.id), ...actedSince(db, record.id, injectedTiers)].map(key));
  const open = routingMaterial(db, metaReviewWindow(db, review.id), precedents, agents).parts.items.filter((item) => !judged.has(key(item)));
  return completeMetaReview<RoutingJudgmentItem, RoutingJudgmentKey>(
    db,
    review,
    input,
    { injected: record.items, open },
    {
      key,
      label: (item) => ("row" in item ? `${itemName(item)} (${item.tier})` : itemName(item)),
      kind: "routing",
      value: "no_change",
      object: (item): RoutingObject => ("row" in item ? { row: item.row } : "tier_id" in item ? { tier_id: item.tier_id } : item),
    },
    workerId,
    now,
    origin,
  );
}

/** 判断を要する項目を材料の部分から導く(ADR 0278 決定5・追記5): 行は、session に辿り着いた乖離 shadow 行で走った行・人間が変えた行・
 *  初観測のセルの和集合で、今の表にある行だけ —— 行の無い対象には verb が届かない。agent は段の出所が agent の配分評価の集計の agent の
 *  うち agent_tier が届くもの(registry にあり、組み込みでなく、一番下の段でない)、段は出所が task の集計の生きている段、学習器は毎周期。
 *  異議つき判断のうち前の routing meta-review の判断の行が名指す対象も、同じ絞りで載る(ADR 0279 決定5)。 */
function judgmentItems(
  db: Db,
  parts: { shadow: ReturnType<typeof shadowRows>; allocations: ReturnType<typeof allocationRows>; precedents: { decision_event_id: number }[] } & ReturnType<typeof cellRows>,
  registry: readonly RegistryAgent[] = [],
): RoutingJudgmentItem[] {
  const objected = objectedJudgments(db, parts.precedents, "routing");
  const table = loadExecutionSettingTable(db);
  const rows = new Map<string, RoutingJudgmentItem>();
  for (const key of [
    ...parts.shadow.flatMap((s) => (s.worker_spawned_event_id === null ? [] : [s.actual])),
    ...parts.rows.map((r) => r.row),
    ...parts.cells.map((c) => c.cell),
    ...objected.flatMap((o) => ("row" in o ? [o.row] : [])),
  ]) {
    const row = table.find((r) => matchesRowKey(r, key));
    if (row && !rows.has(rowName(row))) rows.set(rowName(row), { row: { provider: row.provider, model: row.model, effort: row.effort }, tier: row.tier });
  }
  const { groups } = parts.allocations;
  const lowerable = (name: string) => registry.some((agent) => agent.name === name && !agent.builtin && tierStep(db, agent).below !== undefined);
  const agents = new Set([...groups.flatMap((g) => (g.source_tier === "agent" ? [g.agent] : [])), ...objected.flatMap((o) => ("agent" in o ? [o.agent] : []))].filter(lowerable));
  // 生きている段の行そのものを集めるので、集計(名前)と判断の行(id)の重なりは Set が畳む
  const live = liveTierRows(db);
  const tiers = new Set([
    ...groups.flatMap((g) => (g.source_tier === "task" && !g.tier_retired ? live.filter((t) => t.name === g.tier) : [])),
    ...objected.flatMap((o) => ("tier_id" in o ? live.filter((t) => t.id === o.tier_id) : [])),
  ]);
  return [...rows.values(), ...[...agents].map((agent) => ({ agent })), ...[...tiers].map(({ id, name }) => ({ tier_id: id, tier: name })), { learner: true }];
}

/** routing の材料の節の7つの部分(ADR 0180 追記 #1239): 今の表と設定(窓でなく spawn 時点)、窓の中の乖離した shadow 行と
 *  全行数と候補が2行以上あった行数(ADR 0181 決定5)、配分評価の分布、新しいセルと人間が変えた行、異議つき判断(ADR 0279 決定6)、窓の中で
 *  決着した提案、判断を要する項目。行はそれぞれの読み口と同じ。異議つき判断の行は memory.ts の list_precedents の行を呼び手が渡す(import の循環を避ける)。 */
export function routingMaterial<P extends { decision_event_id: number }>(db: Db, window: Required<MetaReviewWindow>, precedents: P[], agents?: readonly RegistryAgent[]) {
  const shadow = shadowRows(db, window);
  const allocations = allocationRows(db, window);
  const { cells, rows } = cellRows(db, window);
  const read = {
    settings: readExecutionSettings(db),
    shadow: shadow.filter((row) => row.diverged),
    shadow_rows: shadow.length,
    shadow_rows_multi_candidate: shadow.filter((row) => row.candidates > 1).length,
    allocations,
    cells,
    rows,
    precedents,
    proposals: listRoutingProposals(db, window),
  };
  const parts = { ...read, items: judgmentItems(db, read, agents) };
  const section = materialSection("routing", window, [
    [
      "Table and settings",
      "The fields of read_routing_settings except proposals, as they stand at the start of this session, not windowed.",
      [parts.settings],
      "no settings",
    ],
    [
      "Diverged shadow rows",
      `Rows of list_routing_shadow written in this window where the learner's recommendation and the cell that ran differ. ${parts.shadow_rows} shadow ` +
        `rows were written in this window, ${parts.shadow_rows_multi_candidate} of them with two or more candidates; both counts include matched rows, ` +
        "and a row with one candidate always matches. Track records count production sessions only. A record's seed, when not null, is an accepted score of a done Interview or a row a human added as observed: it makes the cell observed in that tier and weighs one accepted session in place of the table's prior. Read the matched rows, and rows before this window, with list_routing_shadow.",
      parts.shadow.map(({ id: _, ...row }) => row),
      "no diverged shadow rows",
    ],
    ["Allocation reviews", "Rows of list_allocations counting the annotations written in this window.", allocations.groups, "no allocation reviews"],
    [
      "New cells and changed rows",
      "The cells and rows of list_routing_cells: cells first observed or seeded in this window, and execution-setting rows humans wrote in this window.",
      [...cells, ...rows],
      "no new cells or changed rows",
    ],
    ["Objected decisions", "Rows of list_precedents for the objections raised in this window.", parts.precedents, "no objected decisions"],
    ["Settled proposals", "Proposals of read_routing_settings answered or settled as observed in this window.", parts.proposals, "no settled proposals"],
    [
      "Items to judge",
      "The objects this cycle needs a judgment on, keyed as complete_routing_review takes them: the rows that ran in the diverged shadow rows, the " +
        "rows humans changed and the rows of the new cells (a row is keyed by provider, model and effort; the tier beside it is the tier it is in, " +
        "for reading), the agents of the allocation reviews under an agent's default tier, the tiers of those under a task's requested tier, and " +
        "the learner, and the rows, agents and tiers named by the judgments of the objected decisions, under the same conditions. A new cell " +
        "with no row in the table is not an item. Act on each item with propose_routing_change, or pass it to " +
        "complete_routing_review as no_change.",
      parts.items.map(judgmentKey),
      "no items to judge",
    ],
  ]);
  return { subject: "routing" as const, section, parts };
}

/** registry の agent の、段の提案が読む欄(AgentView も registry の定義も持つ)。 */
export type RegistryAgent = { name: string; tier?: string; builtin?: boolean };

/** agent の今の段(書いていなければ盤面既定)と、その1段下(ADR 0150 決定5)。「1段下」は盤面の一覧の順序(ADR 0200 決定4)で、
 *  一番下の段なら undefined —— agent_tier の門と Items to judge の agent が同じこの1本を読む。 */
function tierStep(db: Db, agent: RegistryAgent): { from: Tier; below: Tier | undefined } {
  const tiers = tierNames(db);
  const from = agent.tier ?? boardDefaultTier(db);
  return { from, below: tiers[tiers.indexOf(from) - 1] };
}

/** agent の tier の提案の門と pin(issue #920 / spec #916 B・C): 組み込みでない agent を、今の tier(省略は盤面既定)のちょうど
 *  1段下へ。下げ先に agent の entry の行が無ければ下げた agent は skipped になるので断る。根拠はその agent の worker_spawned で、
 *  pin の行はそれらが走った表の行の現在値。 */
function agentTierProposal(db: Db, agents: readonly AgentView[], input: { agent?: string; to?: Tier; evidence?: number[] }): RegistryProposal {
  const { agent: name, to, evidence } = input;
  if (name === undefined || whyBlank(name) || to === undefined || whyBlank(to) || !evidence?.length) throw new DomainError("op agent_tier names the agent, the target tier (to) and at least one evidence worker_spawned event id");
  const agent = agents.find((a) => a.name === name);
  if (!agent) throw new DomainError(`unknown agent: ${name}`);
  if (agent.builtin) throw new DomainError(`agent ${name} is built-in; its definition is the board's code, not a registry file`);
  const { from, below } = tierStep(db, agent);
  if (to !== below) throw new DomainError(`an agent's tier is lowered by exactly one step: ${name} is at ${from}, so the only target is ${below ?? "none (already the lowest tier)"}`);
  assertTierRunnableFor(db, name, agentViewProviders(agent), to);
  // 根拠の pin は「表にあるか」の照合なので、Quarantine 中の行も含む生の表で引く
  const table = loadExecutionSettingTable(db);
  const rows = new Map<string, RegistryProposal["pin"]["rows"][number]>();
  for (const id of evidence) {
    const event = getEvent(db, id);
    if (event?.payload.kind !== "worker_spawned" || event.worker_id !== name) throw new DomainError(`evidence ${id} is not a worker_spawned event of ${name}`);
    const spawned = event.payload;
    // 根拠は床を agent の既定ティアが決めた episode だけ(ADR 0111 追記2)—— 他の出所の tier は agent の宣言の過剰を言わない
    if (spawned.source.tier !== "agent") throw new DomainError(`evidence ${id} took its tier from ${spawned.source.tier}, not from ${name}'s default tier`);
    const row = table.find((r) => matchesRowKey(r, spawned));
    if (!row) throw new DomainError(`evidence ${id} ran on ${rowName(spawned)}, which is no longer in the execution-setting table`);
    rows.set(`${row.provider}/${row.model}/${row.effort}`, { provider: row.provider, model: row.model, tier: tierIdOf(db, row.tier), effort: row.effort });
  }
  // agent が tier を書いていれば from はその値(書いていなければ盤面既定の段)
  return { kind: "registry", op: "agent_tier", agent: name, to: tierIdOf(db, to), pin: { tier: tierIdOf(db, from), rows: [...rows.values()] }, evidence };
}

/** 段を足す提案の隣の段の pin: id と説明(issue #1436)。 */
const neighbour = (tier: { id: TierId; description: string } | undefined) => (tier ? { id: tier.id, description: tier.description } : null);

/** 段を足して行を移す提案の門と pin(issue #1424 / ADR 0200 決定8): 段の名前・説明・位置は段の挿入と同じ線、行は表にあり、
 *  根拠は worker_spawned。pin は行の全欄と、いまの一覧で位置の隣にいる段。 */
function addTierProposal(
  db: Db,
  input: { tier?: string; description?: string; position?: number; row?: { provider: string; model: string; effort: string | null }; evidence?: number[] },
): RoutingAddTierProposal {
  const { tier: name, description, position, row: key, evidence } = input;
  if (name === undefined || description === undefined || position === undefined || !key || !evidence?.length) {
    throw new DomainError("op add_tier names the new tier (tier, description, position), the row to move into it and at least one evidence worker_spawned event id");
  }
  const tier = { name, description, position };
  assertTierName(db, tier.name);
  assertTierDescription(tier.description);
  const tiers = liveTierRows(db);
  assertPosition(tier.position, tiers.length);
  const row = loadExecutionSettingTable(db).find((r) => matchesRowKey(r, key));
  if (!row) throw new DomainError(`the execution-setting table has no row for ${rowName(key)}`);
  for (const id of evidence) {
    if (getEvent(db, id)?.payload.kind !== "worker_spawned") throw new DomainError(`evidence ${id} is not a worker_spawned event`);
  }
  return {
    kind: "routing",
    op: "add_tier",
    tier,
    row: { provider: row.provider, model: row.model, effort: row.effort },
    evidence,
    pin: { row: { ...row, tier: tierIdOf(db, row.tier) }, below: neighbour(tiers[tier.position - 1]), above: neighbour(tiers[tier.position]) },
  };
}

/** 段の説明の提案の門と pin(ADR 0200 決定7): 生きている段の説明を1行の新しい文面へ。根拠は、床を task の申告が決めて
 *  (`source.tier` が task)その task がこの段を要求した worker_spawned だけで、書き手が人間の task も数える。pin は説明のいまの文面。 */
function tierDescriptionProposal(db: Db, input: { tier?: string; description?: string; evidence?: number[] }): TierDescriptionProposal {
  const { tier, description, evidence } = input;
  if (tier === undefined || whyBlank(tier) || description === undefined || !evidence?.length) {
    throw new DomainError("op tier_description names the tier, its new description and at least one evidence worker_spawned event id");
  }
  assertKnownTier(db, "tier", tier);
  assertTierDescription(description);
  const current = liveTierRows(db).find((t) => t.name === tier)!;
  if (description === current.description) throw new DomainError(`tier ${tier}'s description already reads: ${current.description}`);
  const requested = db.prepare("SELECT 1 FROM tasks JOIN tiers ON tiers.id = tasks.tier_id WHERE tasks.id = ? AND tiers.name = ? AND tiers.position IS NOT NULL");
  for (const id of evidence) {
    const event = getEvent(db, id);
    if (event?.payload.kind !== "worker_spawned") throw new DomainError(`evidence ${id} is not a worker_spawned event`);
    if (event.payload.source.tier !== "task") throw new DomainError(`evidence ${id} took its tier from ${event.payload.source.tier}, not from its task's request`);
    if (!requested.get(event.task_id, tier)) throw new DomainError(`evidence ${id} is a session of a task that did not request ${tier}`);
  }
  return { kind: "routing", op: "tier_description", tier: current.id, description, evidence, pin: { description: current.description } };
}

/** 提案 question と approve で登録する root の題(修正後の対象で組み直す)。 */
export function interviewTitle(targets: readonly InterviewTarget[], tier: Tier): string {
  return `Interview ${targets.length === 1 ? rowName(targets[0]!) : `${targets.length} targets`} in tier ${tier}`;
}

/** Interview の提案の門と pin(#921 / ADR 0199 決定5 / ADR 0258 決定1 / ADR 0273 決定6・9): 欄は人間の登録の扉と同じ検査を通し、
 *  対象は表にある model の、測る段で行でないものだけ。根拠は本番の episode の worker_spawned で、その task が root の根拠の task に
 *  なる。実環境は登録済みで、根拠の episode のどれかの workspace(学習器が数える層と同じ値)。pin は根拠の行の全欄。 */
function interviewProposal(
  db: Db,
  input: { hypothesis?: string; measured_work?: string; evidence?: number[]; tier?: Tier; targets?: InterviewTarget[]; workspace?: string },
  assertWorkspaceKnown?: (name: string) => void,
): InterviewProposal {
  const { hypothesis, measured_work, evidence, tier, targets, workspace } = input;
  if (hypothesis === undefined || tier === undefined || !targets?.length || workspace === undefined || !evidence?.length) {
    throw new DomainError("op interview names the hypothesis, the tier it measures, at least one target, the workspace and at least one evidence worker_spawned event id");
  }
  assertKnownTier(db, "tier", tier);
  const episodes = new Map(loadEpisodes(db).map((e) => [e.worker_spawned_event_id, e]));
  // 根拠の pin は「表にあるか」の照合なので、Quarantine 中の行も含む生の表で引く
  const table = loadExecutionSettingTable(db);
  const rows = new Map<string, InterviewProposal["pin"]["rows"][number]>();
  const evidenceWorkspaces = new Set<string | null>();
  for (const id of evidence) {
    const episode = episodes.get(id);
    // 受験者の session は本番の観測ではない(学習器も数えない)—— 根拠にすると root が受験者の history を読める
    if (!episode || episode.interview) throw new DomainError(`evidence ${id} is not a worker_spawned event of a production work session`);
    const row = table.find((r) => matchesRowKey(r, episode.cell));
    if (!row) throw new DomainError(`evidence ${id} ran on ${rowName(episode.cell)}, which is no longer in the execution-setting table`);
    rows.set(rowName(row), { ...row, tier: tierIdOf(db, row.tier) });
    evidenceWorkspaces.add(episode.workspace);
  }
  assertInterviewFields(db, { type: "interview", hypothesis, measured_work, tier, interview_targets: targets });
  for (const target of targets) {
    if (!table.some((r) => r.provider === target.provider && r.model === target.model)) {
      throw new DomainError(`the execution-setting table has no row for ${target.provider} / ${target.model}: propose another effort or tier of a model in the table; a new model is the human's to bring in`);
    }
    if (table.some((r) => matchesRowKey(r, target) && r.tier === tier)) throw new DomainError(`target ${rowName(target)} is already a row of the table in tier ${tier}; there is nothing to measure`);
  }
  assertWorkspaceKnown?.(workspace);
  if (!evidenceWorkspaces.has(workspace)) {
    throw new DomainError(`workspace ${workspace} is not the workspace of any evidence session (${[...evidenceWorkspaces].map((w) => w ?? "none").join(", ")})`);
  }
  return {
    kind: "routing",
    op: "interview",
    hypothesis,
    // 空の測る仕事は「無し」—— 写しに空文字を残さない(normalizeText 済み)
    ...(measured_work && { measured_work }),
    evidence,
    tier: tierIdOf(db, tier),
    targets,
    workspace,
    pin: { rows: [...rows.values()] },
  };
}

/** 学習器の昇格 / 降格の根拠(ADR 0181 追記 #2438): 各 evidence は乖離した shadow 行の session の worker_spawned(行と session の結び方は
 *  list_routing_shadow と同じ shadowRows)で、昇格なら出所が学習器でない行、降格なら出所が学習器の行。 */
function learnerEvidenceLines(db: Db, op: "promote" | "demote", evidence: number[]): string[] {
  type Row = ReturnType<typeof shadowRows>[number];
  // 根拠の向き: 降格は学習器の選択が走った行(昇格後)、昇格はそれ以外(昇格前)
  const learnerRan = op === "demote";
  const rows = shadowRows(db, { after: 0 });
  const cited = new Set<number>();
  for (const id of evidence) {
    const row = rows.find((r) => r.worker_spawned_event_id === id);
    if (!row) {
      if (getEvent(db, id)?.payload.kind !== "worker_spawned") throw new DomainError(`evidence ${id} is not a worker_spawned event`);
      throw new DomainError(`evidence ${id} is not the session of any shadow row: only a work task's pickup writes one`);
    }
    if (!row.diverged) throw new DomainError(`evidence ${id} is the session of a shadow row where the learner recommended the cell that ran`);
    if (!learnerRan && row.source.provider === "learner") throw new DomainError(`evidence ${id} ran on the promoted learner's choice: op promote rests on rows from before promotion`);
    if (learnerRan && row.source.provider !== "learner") throw new DomainError(`evidence ${id} ran on the table's choice: op demote rests on rows where the promoted learner's choice ran`);
    cited.add(row.id);
  }
  // セルは列でなく出所で呼ぶ —— 昇格後は列の意味が反転する(ADR 0150 決定3)
  const bySource = <T>(recommended: T, actual: T) => (learnerRan ? { learner: actual, table: recommended } : { learner: recommended, table: actual });
  // 段は session が走った段(shadow 行は段を持たない)。session に辿り着かなかった行は段も workspace も無い
  const tiers = new Map(loadEpisodes(db).map((e) => [e.worker_spawned_event_id, e.tier_id]));
  const cell = (c: Cell) => `${rowName(c)}${c.advisor ? ` with advisor ${c.advisor}` : ""}`;
  const group = (grouped: Row[]) => {
    const groups = new Map<string, Row[]>();
    for (const row of grouped) {
      const tierId = row.worker_spawned_event_id === null ? undefined : tiers.get(row.worker_spawned_event_id);
      const { learner, table } = bySource(row.recommended, row.actual);
      const key = `tier ${tierId === undefined ? "none" : tierNameOf(db, tierId)}, workspace ${row.workspace ?? "none"}, learner ${cell(learner)}, table ${cell(table)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return groups;
  };
  const record = ({ board, workspace, seed }: TrackRecord) =>
    `board ${board.accepted}/${board.rejected}, workspace ${workspace.accepted}/${workspace.rejected}${seed ? `, seeded by ${seed.kind}` : ""}`;
  const lines = [...group(rows.filter((r) => cited.has(r.id)))].map(([key, members]) => {
    const latest = members.at(-1)!;
    const { learner, table } = bySource(latest.recommended_record, latest.actual_record);
    // 昇格前の outcome は表の結果なので、並べれば学習器の成績と読まれる(ADR 0181 決定6)—— 降格にだけ出す
    const count = (outcome: string) => members.filter((r) => r.outcome === outcome).length;
    const outcomes = learnerRan ? `; outcomes ${count("accepted")} accepted, ${count("rejected")} rejected, ${count("excluded")} excluded` : "";
    return `- ${key}: ${members.length} pickup(s) (tasks ${members.map((r) => r.task_id).join(", ")}); learner ${record(learner)}; table ${record(table)}${outcomes}`;
  });
  // 引用の外(ADR 0181 追記 決定3): フラグの最後の変更以降(無ければ全期間)の同じ向きの行。根拠は meta-review が選ぶので、引用されない組も人間に見せる
  const change = listEventsOfKinds(db, ["execution_settings_changed"]).filter(({ payload: p }) => p.setting === "learner_promoted").at(-1)?.id;
  const span = shadowRows(db, { after: change ?? 0 }).filter((r) => (r.source.provider === "learner") === learnerRan);
  const diverged = span.filter((r) => r.diverged);
  const divergedGroups = group(diverged);
  const uncited = [...divergedGroups].filter(([, members]) => !members.some((r) => cited.has(r.id)));
  return [
    `Evidence: ${cited.size} worker session(s) of diverged shadow rows, one line per tier, workspace, learner cell and table cell, with the track records (accepted/rejected production sessions) of both cells as of the line's latest cited pickup:`,
    ...lines,
    `All diverged pickups where the ${learnerRan ? "learner's" : "table's"} choice ran, ${change === undefined ? "over all time (the learner flag never changed)" : `since the learner flag last changed (event ${change})`}: ` +
      `${diverged.length} in ${divergedGroups.size} line(s), ${diverged.filter((r) => cited.has(r.id)).length} cited; ` +
      `lines not cited: ${uncited.map(([key, members]) => `${key}: ${members.length}`).join("; ") || "none"}. Pickups with two or more candidates in that span: ${span.filter((r) => r.candidates > 1).length}.`,
  ];
}

/** 提案 verb(issue #918 / #919 / #920 / #1424 / ADR 0150 決定1・2・4・5 / ADR 0200 決定7・8): 表の既存の1行の tier / effort の置換(op row)、
 *  学習器の昇格 / 降格、agent の既定 tier の1段引き下げ(op agent_tier)、段の説明の書き換え(op tier_description)、段の追加と
 *  行の移動(op add_tier)、または表に無い対象の Interview(op interview)を、meta-review(または routing_repair —— 門は requireRepairReach)の付帯子の question として立てる。pin は row ならその行の全欄、昇格 / 降格ならフラグの現在値、
 *  agent_tier なら (agent, tier) と根拠の行、tier_description なら説明のいまの文面、add_tier なら移す行の全欄と隣の段、interview なら根拠の行の全欄。
 *  同じ行への提案は重ねてよい —— 片方の承認が表を変えれば、もう片方は陳腐化の hook で決着する。
 *  `agents` は registry の agent 一覧(registry の無い盤面では無く、agent_tier は断る)。`assertWorkspaceKnown` は interview の実環境が
 *  registry にあるかの検査(approve の時点でも確かめ直す、ADR 0258 決定4)。 */
export function proposeRoutingChange(
  db: Db,
  metaReviewId: string,
  input: {
    op: (RoutingProposal | RegistryProposal)["op"];
    row?: { provider: string; model: string; effort: string | null };
    change?: unknown;
    agent?: string;
    to?: Tier;
    evidence?: number[];
    tier?: Tier;
    description?: string;
    position?: number;
    hypothesis?: string;
    measured_work?: string;
    targets?: InterviewTarget[];
    workspace?: string;
    rationale: string;
  },
  workerId: string,
  now: Date,
  agents?: () => readonly AgentView[],
  assertWorkspaceKnown?: (name: string) => void,
): { question_id: string } {
  input = { ...input, rationale: normalizeText(input.rationale) };
  if (whyBlank(input.rationale)) throw new DomainError("a routing proposal requires a rationale");
  for (const field of ["agent", "to", "tier", "description", "hypothesis", "measured_work", "workspace"] as const) {
    if (input[field] !== undefined) input[field] = normalizeText(input[field]);
  }
  const normalizeKey = (k: InterviewTarget) => ({ provider: normalizeText(k.provider), model: normalizeText(k.model), effort: k.effort && normalizeText(k.effort) });
  if (input.row) input.row = normalizeKey(input.row);
  if (input.targets) input.targets = input.targets.map(normalizeKey);
  if (input.op !== "interview" && [input.hypothesis, input.measured_work, input.targets, input.workspace].some((field) => field !== undefined)) {
    throw new DomainError(`op ${input.op} takes no hypothesis, measured_work, targets or workspace`);
  }
  // 修理子の提案は修理子の名で人間に出す(ADR 0279 決定4)
  const byRepair = getTask(db, metaReviewId)?.type === "routing_repair";
  const proposer = byRepair ? "The routing repair" : "The routing meta-review";
  let proposal: RoutingProposal | RegistryProposal;
  let title: string;
  let diff: string[];
  let purpose: string;
  if (input.op !== "agent_tier" && (input.agent !== undefined || input.to !== undefined)) throw new DomainError(`op ${input.op} takes no agent and no to`);
  if (input.op === "row" && input.evidence !== undefined) throw new DomainError("op row takes no evidence");
  if (input.op === "row" || input.op === "promote" || input.op === "demote") {
    if (input.tier !== undefined || input.description !== undefined) throw new DomainError(`op ${input.op} takes no tier or description`);
  }
  if (input.op !== "add_tier" && input.position !== undefined) throw new DomainError(`op ${input.op} takes no position`);
  if (input.op === "agent_tier" && (input.tier !== undefined || input.description !== undefined)) throw new DomainError("op agent_tier takes no tier or description");
  if (input.op === "interview") {
    if (input.row !== undefined || input.change !== undefined || input.description !== undefined) throw new DomainError("op interview takes no row, change or description");
    proposal = interviewProposal(db, input, assertWorkspaceKnown);
    const { tier, targets, workspace, hypothesis, measured_work, pin } = proposalTierNames(db, proposal) as InterviewProposal<Tier>;
    title = interviewTitle(targets, tier);
    diff = [
      `Hypothesis: ${hypothesis}`,
      ...(measured_work ? [`Work to measure: ${measured_work}`] : []),
      `Tier measured: ${tier}`,
      `Targets: ${targets.map(rowName).join("; ")}`,
      `Real environment (the workspace the Interview's root reads; examinees do not run there): ${workspace}`,
      `Evidence: ${proposal.evidence.length} worker session(s) on ${pin.rows.map((r) => `${rowName(r)} (${r.tier})`).join(", ")}`,
    ];
    purpose =
      `${proposer} proposes an Interview: measuring targets that are not rows of the execution-setting table, in one tier, before any row changes. ` +
      "Approve registers the Interview in your name, with your amendment of the hypothesis, the work to measure, the targets' efforts or the workspace if you give one; reject registers nothing.";
  } else if (input.op === "tier_description") {
    if (input.row !== undefined || input.change !== undefined) throw new DomainError("op tier_description takes no row and no change");
    proposal = tierDescriptionProposal(db, input);
    const tier = input.tier!;
    title = `Rewrite tier ${tier}'s description`;
    diff = [
      `Tier ${tier}, description:`,
      `current: ${proposal.pin.description}`,
      `proposed: ${proposal.description}`,
      `Evidence: ${proposal.evidence.length} worker session(s) whose floor the task's requested tier set`,
    ];
    purpose =
      `${proposer} proposes rewriting one tier's description, which defines the tier for everyone who requests it. ` +
      "Approve writes the new description, with your amendment (one line) if you give one; reject leaves the description as it is.";
  } else if (input.op === "agent_tier") {
    if (input.row !== undefined || input.change !== undefined) throw new DomainError("op agent_tier takes no row and no change");
    if (!agents) throw new DomainError("this board has no registry, so there is no agent definition to change");
    proposal = agentTierProposal(db, agents(), input);
    const { agent, to, pin } = proposalTierNames(db, proposal) as RegistryProposal<Tier>;
    title = `Lower agent ${agent}'s tier: ${pin.tier} -> ${to}`;
    diff = [
      `Agent ${agent} (registry definition), default tier: ${pin.tier} -> ${to}`,
      `Evidence: ${proposal.evidence.length} worker session(s) on ${pin.rows.map((r) => `${rowName(r)} (${r.tier})`).join(", ")}`,
    ];
    purpose =
      `${proposer} proposes lowering an agent's default tier by one step. Approve commits the new tier to the registry, ` +
      "with your amendment (any lower tier) if you give one; reject leaves the agent as it is.";
  } else if (input.op === "add_tier") {
    if (input.change !== undefined) throw new DomainError("op add_tier takes no change");
    proposal = addTierProposal(db, input);
    const { tier, pin } = proposalTierNames(db, proposal) as RoutingAddTierProposal<Tier>;
    const place = [pin.below && `above ${pin.below.name}`, pin.above && `below ${pin.above.name}`].filter(Boolean).join(" and ") || "as the only tier";
    title = `Add tier ${tier.name} and move ${pin.row.provider} / ${pin.row.model} into it`;
    diff = [
      `New tier ${tier.name}, ${place}: ${tier.description}`,
      `Execution-setting row ${rowName(pin.row)}, tier: ${pin.row.tier} -> ${tier.name}`,
      `Evidence: ${proposal.evidence.length} worker session(s)`,
    ];
    purpose =
      `${proposer} proposes adding a tier to the board's list and moving one row into it. Approve does both at once, ` +
      "with your amendment of the tier's name, description or position if you give one; reject leaves the tiers and the table as they are.";
  } else if (input.op === "row") {
    const key = input.row;
    if (!key) throw new DomainError("op row names the row to change (provider, model and effort)");
    const change = parseRoutingRowChange(tierNames(db), input.change);
    const table = loadExecutionSettingTable(db);
    const pin = table.find((row) => matchesRowKey(row, key));
    if (!pin) throw new DomainError(`the execution-setting table has no row for ${rowName(key)}`);
    const row = { provider: pin.provider, model: pin.model, effort: pin.effort };
    // 現在値と同じ欄を名指す change は欄を落とさず丸ごと拒む(issue #1666 / ADR 0218 決定7 と同じく拒否の文を meta-review に返す)。
    // 承認の修正値と共有する parseRoutingRowChange ではなくここで比べる。段は名前の一致(段名は一意)で、effort は null(「無い」)も1つの値として比べる。
    if (change.tier === pin.tier) throw new DomainError(`the row ${rowName(pin)} is already in tier ${pin.tier}; name a different tier or drop tier from the change`);
    if (change.effort !== undefined && change.effort === pin.effort) throw new DomainError(`the row ${rowName(pin)} already has effort ${pin.effort ?? "none"}; name a different effort or drop effort from the change`);
    // 承認の修正値は回答時に行を書く扉が同じ検査で拒む
    assertRowFits(table, composeRoutingRow({ kind: "routing", op: "row", row, change, pin }), row);
    const { tier, ...rest } = change;
    proposal = { kind: "routing", op: "row", row, change: { ...rest, ...(tier !== undefined && { tier: tierIdOf(db, tier) }) }, pin: { ...pin, tier: tierIdOf(db, pin.tier) } };
    title = `Change routing row: ${rowName(pin)}`;
    diff = [
      `Execution-setting row ${rowName(pin)} (price ${pin.price_in} / ${pin.price_out} USD per MTok):`,
      ...Object.entries(change).map(([field, to]) => `${field}: ${pin[field as keyof typeof change]} -> ${to}`),
    ];
    purpose = `${proposer} proposes changing one row of the execution-setting table. Approve applies it, with your amendment if you give one; reject leaves the table as is.`;
  } else {
    if (input.row !== undefined || input.change !== undefined) throw new DomainError(`op ${input.op} takes no row and no change`);
    const promoted = readExecutionSettings(db).learnerPromoted;
    const promote = input.op === "promote";
    if (promote === promoted) throw new DomainError(`the learner is already ${promoted ? "promoted" : "not promoted"}; op ${input.op} only applies while it is ${promoted ? "not promoted" : "promoted"}`);
    if (!input.evidence?.length) throw new DomainError(`op ${input.op} names at least one evidence worker_spawned event id: a session of a diverged shadow row`);
    const evidenceLines = learnerEvidenceLines(db, input.op, input.evidence);
    proposal = { kind: "routing", op: input.op, evidence: input.evidence, pin: { promoted } };
    title = promote ? "Promote the learner" : "Demote the learner";
    diff = [
      promote
        ? "Work tasks would run on the learner's recommendation instead of the execution-setting table's first choice. The shadow keeps what the table would have chosen."
        : "Work tasks would run on the execution-setting table's first choice again. The shadow keeps what the learner would have recommended.",
      ...evidenceLines,
    ];
    purpose = `${proposer} proposes to ${input.op} the learner. Approve applies it; reject leaves the learner as it is.`;
  }
  if (byRepair) requireRepairReach(db, metaReviewId, proposal);
  const detail = [...diff, "", `Rationale: ${input.rationale}`, "", "While this question is open, the next routing meta-review is not registered."].join("\n");
  const question = registerTask(
    db,
    {
      type: "question",
      title,
      purpose,
      completion_criteria: "a human answer is recorded",
      parent_id: metaReviewId,
      question: [{ title, detail, options: ["approve", "reject"], recommendation: "approve" }],
      question_kind: { kind: "proposal", proposal },
    },
    now,
    workerId,
    "worker",
  );
  return { question_id: question.id };
}
