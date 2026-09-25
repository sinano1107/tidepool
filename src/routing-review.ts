import type { AgentView } from "./agent-create.js";
import type { Db } from "./db.js";
import type { EventPayload } from "./events.js";
import {
  BOARD_DEFAULT_TIER,
  type ExecutionSettingsChange,
  loadExecutionSettingTable,
  parseRoutingRowChange,
  readExecutionSettings,
  TIERS,
  type Tier,
  tierHasRowFor,
  windowMatchesModel,
} from "./execution-setting.js";
import { type Cell, cellJson, loadEpisodes, type RoutingEpisode } from "./learner.js";
import { paged, previousMetaReviewWatermark } from "./meta-review.js";
import { DomainError, type RegistryProposal, type RoutingProposal, registerTask } from "./tasks.js";

/** 主題 routing の meta-review の読み口(issue #917 / spec #916 C)。どれも既定の `since_watermark` は読み手と同主題の
 *  前回の登録の watermark(event id)で、ページ長は memory の読み口と同じ定数。 */

interface ReadWindow {
  since_watermark?: number;
  page?: number;
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
 *  settings タブ / 管理MCP から書かれた表の行(`execution_settings_changed` の `row`)。提案 question への approve の適用は
 *  read_routing_settings が読むので含まない(ADR 0151 決定2)。 */
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
          WHERE kind = 'execution_settings_changed' AND json_extract(payload, '$.setting') = 'row' AND json_extract(payload, '$.question_id') IS NULL
            AND id > ? ORDER BY id`,
      )
      .all(from) as Array<{ id: number; origin: string; payload: string; created_at: string }>
  ).map((r) => ({ event_id: r.id, origin: r.origin, created_at: r.created_at, row: (JSON.parse(r.payload) as Extract<ExecutionSettingsChange, { setting: "row" }>).row }));
  // 人間の行の編集は数件なのでページに割らず全部返す
  const { rows: cells, truncated } = paged([...firstSeen.values()].filter((c) => c.first_observed_event_id > from), input.page);
  return { cells, rows: changed, truncated };
}

/** 過去の routing / registry の提案(spec #916 C): 提案、回答(question_answered の答え・修正値・コメント)、observed の理由
 *  (routing_proposal_stale)、registry へ適用した tier の提案なら着地した commit(agent_tier_changed)。提案の表は持たず question と
 *  event から組む。窓で切らない —— 退けられた提案を繰り返さないための読み物なので、全期間を返す。 */
export function listRoutingProposals(db: Db) {
  const rows = db
    .prepare(
      `SELECT t.id, t.question_proposal,
         (SELECT payload FROM events WHERE task_id = t.id AND kind = 'question_answered') AS answered,
         (SELECT payload FROM events WHERE task_id = t.id AND kind = 'routing_proposal_stale') AS stale,
         (SELECT payload FROM events WHERE kind = 'agent_tier_changed' AND json_extract(payload, '$.question_id') = t.id) AS applied
       FROM tasks t WHERE json_extract(t.question_proposal, '$.kind') IN ('routing', 'registry') ORDER BY t.rowid`,
    )
    .all() as Array<{ id: string; question_proposal: string; answered: string | null; stale: string | null; applied: string | null }>;
  return rows.map((row) => {
    const answered = row.answered === null ? null : (JSON.parse(row.answered) as Extract<EventPayload, { kind: "question_answered" }>);
    const stale = row.stale === null ? null : (JSON.parse(row.stale) as Extract<EventPayload, { kind: "routing_proposal_stale" }>);
    const applied = row.applied === null ? null : (JSON.parse(row.applied) as Extract<EventPayload, { kind: "agent_tier_changed" }>);
    return {
      question_id: row.id,
      proposal: JSON.parse(row.question_proposal) as RoutingProposal | RegistryProposal,
      answer: answered?.answers[0]?.answer ?? null,
      amendment: answered?.amendment ?? null,
      comment: answered?.comment ?? null,
      observed: stale && { changed: stale.changed, observed_event_id: stale.observed_event_id },
      ...(applied && { applied: { registry_commit: applied.registry_commit, from: applied.from, to: applied.to } }),
    };
  });
}

/** agent の tier の提案の門と pin(issue #920 / spec #916 B・C): 組み込みでない agent を、今の tier(省略は盤面既定)のちょうど
 *  1段下へ。下げ先に agent の entry の行が無ければ下げた agent は skipped になるので断る。根拠はその agent の worker_spawned で、
 *  pin の行はそれらが走った表の行の現在値。 */
function agentTierProposal(db: Db, agents: readonly AgentView[], input: { agent?: string; to?: Tier; evidence?: number[] }): RegistryProposal {
  const { agent: name, to, evidence } = input;
  if (!name || !to || !evidence?.length) throw new DomainError("op agent_tier names the agent, the target tier (to) and at least one evidence worker_spawned event id");
  const agent = agents.find((a) => a.name === name);
  if (!agent) throw new DomainError(`unknown agent: ${name}`);
  if (agent.builtin) throw new DomainError(`agent ${name} is built-in; its definition is the board's code, not a registry file`);
  const from = (agent.tier ?? BOARD_DEFAULT_TIER) as Tier;
  const below = TIERS[TIERS.indexOf(from) - 1];
  if (to !== below) throw new DomainError(`an agent's tier is lowered by exactly one step: ${name} is at ${from}, so the only target is ${below ?? "none (already the lowest tier)"}`);
  const table = loadExecutionSettingTable(db);
  if (!tierHasRowFor(table, agent.provider.split(", "), to)) {
    throw new DomainError(`the execution-setting table has no execution-setting row at ${to} for ${name}'s providers (${agent.provider}), so the agent would be skipped`);
  }
  const rows = new Map<string, RegistryProposal["pin"]["rows"][number]>();
  for (const id of evidence) {
    const event = db.prepare("SELECT worker_id, payload FROM events WHERE id = ? AND kind = 'worker_spawned'").get(id) as { worker_id: string; payload: string } | undefined;
    if (event?.worker_id !== name) throw new DomainError(`evidence ${id} is not a worker_spawned event of ${name}`);
    const spawned = JSON.parse(event.payload) as Extract<EventPayload, { kind: "worker_spawned" }>;
    const row = table.find((r) => r.provider === spawned.provider && r.model === spawned.model);
    if (!row) throw new DomainError(`evidence ${id} ran on ${spawned.provider} / ${spawned.model}, which is no longer in the execution-setting table`);
    rows.set(`${row.provider}/${row.model}`, { provider: row.provider, model: row.model, tier: row.tier, effort: row.effort });
  }
  // agent が tier を書いていれば from はその値(書いていなければ economy で、下げ先が無く上で断っている)
  return { kind: "registry", op: "agent_tier", agent: name, to, pin: { tier: from, rows: [...rows.values()] }, evidence };
}

/** 提案 verb(issue #918 / #919 / #920 / ADR 0150 決定1・2・4・5): 表の既存の1行の tier / effort の置換(op row)、学習器の
 *  昇格 / 降格、または agent の既定 tier の1段引き下げ(op agent_tier)を、meta-review の付帯子の question として立てる。pin は
 *  row ならその行の全欄、昇格 / 降格ならフラグの現在値、agent_tier なら (agent, tier) と根拠の行。
 *  同じ行への提案は重ねてよい —— 片方の承認が表を変えれば、もう片方は陳腐化の hook で決着する。
 *  `agents` は registry の agent 一覧(registry の無い盤面では無く、agent_tier は断る)。 */
export function proposeRoutingChange(
  db: Db,
  metaReviewId: string,
  input: {
    op: (RoutingProposal | RegistryProposal)["op"];
    row?: { provider: string; model: string };
    change?: unknown;
    agent?: string;
    to?: Tier;
    evidence?: number[];
    rationale: string;
  },
  workerId: string,
  now: Date,
  agents?: () => readonly AgentView[],
): { question_id: string } {
  let proposal: RoutingProposal | RegistryProposal;
  let title: string;
  let diff: string[];
  let purpose: string;
  if (input.op === "agent_tier") {
    if (input.row !== undefined || input.change !== undefined) throw new DomainError("op agent_tier takes no row and no change");
    if (!agents) throw new DomainError("this board has no registry, so there is no agent definition to change");
    proposal = agentTierProposal(db, agents(), input);
    const { agent, to, pin } = proposal;
    title = `Lower agent ${agent}'s tier: ${pin.tier} -> ${to}`;
    diff = [
      `Agent ${agent} (registry definition), default tier: ${pin.tier} -> ${to}`,
      `Evidence: ${proposal.evidence.length} worker session(s) on ${pin.rows.map((r) => `${r.provider} / ${r.model} (${r.tier}, ${r.effort})`).join(", ")}`,
    ];
    purpose =
      "The routing meta-review proposes lowering an agent's default tier by one step. Approve commits the new tier to the registry, " +
      "with your amendment (any lower tier) if you give one; reject leaves the agent as it is.";
  } else if (input.op === "row") {
    if (!input.row) throw new DomainError("op row names the row to change (provider and model)");
    const change = parseRoutingRowChange(input.change);
    const { provider, model } = input.row;
    const pin = loadExecutionSettingTable(db).find((row) => row.provider === provider && row.model === model);
    if (!pin) throw new DomainError(`the execution-setting table has no row for ${provider} / ${model}`);
    proposal = { kind: "routing", op: "row", row: { provider: pin.provider, model: pin.model }, change, pin };
    title = `Change routing row: ${pin.provider} / ${pin.model}`;
    diff = [
      `Execution-setting row ${pin.provider} / ${pin.model} (price ${pin.price_in} / ${pin.price_out} USD per MTok):`,
      ...Object.entries(change).map(([field, to]) => `${field}: ${pin[field as keyof typeof change]} -> ${to}`),
    ];
    purpose = "The routing meta-review proposes changing one row of the execution-setting table. Approve applies it, with your amendment if you give one; reject leaves the table as is.";
  } else {
    if (input.row !== undefined || input.change !== undefined) throw new DomainError(`op ${input.op} takes no row and no change`);
    const promoted = readExecutionSettings(db).learnerPromoted;
    const promote = input.op === "promote";
    if (promote === promoted) throw new DomainError(`the learner is already ${promoted ? "promoted" : "not promoted"}; op ${input.op} only applies while it is ${promoted ? "not promoted" : "promoted"}`);
    proposal = { kind: "routing", op: input.op, pin: { promoted } };
    title = promote ? "Promote the learner" : "Demote the learner";
    diff = [
      promote
        ? "Work tasks would run on the learner's recommendation instead of the execution-setting table's first choice. The shadow keeps what the table would have chosen."
        : "Work tasks would run on the execution-setting table's first choice again. The shadow keeps what the learner would have recommended.",
    ];
    purpose = `The routing meta-review proposes to ${input.op} the learner. Approve applies it; reject leaves the learner as it is.`;
  }
  const detail = [...diff, "", `Rationale: ${input.rationale}`].join("\n");
  const question = registerTask(
    db,
    {
      type: "question",
      title,
      purpose,
      completion_criteria: "a human answer is recorded",
      parent_id: metaReviewId,
      question: [{ title, detail, options: ["approve", "reject"], recommendation: "approve" }],
      proposal,
    },
    now,
    workerId,
    "worker",
  );
  return { question_id: question.id };
}
