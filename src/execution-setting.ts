import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ADVISOR_CEILINGS, type AdvisorCeiling, type AdvisorSource, claudeAdvisorFor, isClaudeModelAlias } from "./claude-model-alias.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, type EventOrigin } from "./events.js";
import { whyInvalidPrice } from "./price.js";
import { PROVIDER_VALUES, type Provider, whyInvalidProviderRank } from "./provider.js";
import { openQuarantineQuestions, openQuarantineValues, tableRowValue } from "./quarantine.js";
import type { AgentDefinition } from "./registry.js";
import { RegistryFetchFailedError, RegistryPushFailedError } from "./registry-write.js";
import { normalizeText, whyBlank } from "./required-text.js";
import { requiredTextSchema } from "./required-text-schema.js";
import {
  type RegistryProposal,
  type RoutingProposal,
  type RoutingRowProposal,
  settleQuestionAsObserved,
  type Task,
  type TierNeighbour,
} from "./tasks.js";
import {
  assertKnownTier,
  liveTierId,
  liveTierRows,
  PRIORITIES,
  type Priority,
  readTiers,
  type Tier,
  type TierId,
  tierIdOf,
  tierNames,
} from "./tier.js";
import { HUMAN_WORKER_ID } from "./worker-id.js";

/** 要求2列を受け取る入口(管理MCP の `register_task` / `decompose_task`、worker MCP の `decompose`)が
 *  エージェントへ見せる説明。**綴りは1つ** —— 入口ごとに書くと、片方だけが古い段や古い意味を喋り続ける。
 *  段は盤面の一覧から「名前 — 説明」を順序どおりに並べる(ADR 0200 決定3)。 */
export function tierFieldDescriptions(db: Db): { tier: string; review_tier: string; review_tier_choices: string } {
  const tiers = readTiers(db).map((t) => `${t.name} — ${t.description}`).join("\n");
  // review task も登録する入口(register_task)は書き出しを type ごとの説明に差し替えるので、段の一覧以降を分けて渡す
  const reviewTierChoices = `One of the board's tiers (lowest first):\n${tiers}\n` +
    "Overrides each reviewer's tier, then the board default.";
  return {
    tier: `Required quality tier for this task, one of the board's tiers (lowest first):\n${tiers}\n` +
      "Omit to fall back to the agent's own tier, then the board default.",
    review_tier: `Quality tier for completion reviews. ${reviewTierChoices}`,
    review_tier_choices: reviewTierChoices,
  };
}
export const PRIORITY_FIELD_DESCRIPTION =
  `How the models of the required tier are ordered: ${PRIORITIES.join(" / ")}. ` +
  "quality picks by the board's Provider rank, then price; cost picks the cheapest model, then Provider rank. " +
  "Omit to fall back to the board's default priority for work tasks.";

/** 解決されたティアが**誰の要求だったか**(ADR 0110 決定3)。events 側の
 *  `worker_spawned.source` と同じ union を2箇所に書くと必ず片方だけ動くので、
 *  綴りはここ1つにして events.ts は型として取り込む。 */
export type TierSource = "task" | "review_tier" | "agent" | "board";

/** 選ばれた Provider が**なぜその Provider だったか**(ADR 0110 決定3 / 決定5、
 *  ADR 0114 決定4)。`"only"` は agent が entry を1つしか宣言していなかった、
 *  `"rank"` は残った候補から Provider 順位で選んだ、`"cost"` は優先順位(task の、または盤面の
 *  既定)が cost で価格が Provider を決めた、`"learner"` は昇格した学習器が選んだ(ADR 0150 決定3)。 */
export type ProviderSource = "only" | "rank" | "cost" | "learner";

/** 優先順位の既定の、さらに既定(ADR 0114 決定1): 盤面設定 `execution_defaults.priority`
 *  が未設定のときの値。work task の優先順位 → 盤面設定の work 用の既定 → この定数の順に倒れる
 *  (`selectorInputFor` / `loadExecutionDefaults`)。 */
export const BOARD_DEFAULT_PRIORITY: Priority = "quality";

/** 表の1行 = モデル分類の行(ADR 0114 決定2): この model はこの provider のこの
 *  ティアの品質を満たす、という分類と、そこで使う effort・価格(USD per MTok)。
 *  同じ (provider, tier) に複数行あってよい。行の鍵は (provider, model, effort) で、1つの段に
 *  同じ model は1行まで(ADR 0200 決定5)。model は具体 id だけ —— 行を書く扉
 *  (`applyExecutionSettingsChange`)が anthropic の adapter の拒否一覧で alias を
 *  拒む(ADR 0182 決定1)。 */
export interface ExecutionSettingRow {
  provider: Provider;
  tier: Tier;
  model: string;
  effort: string;
  price_in: number;
  price_out: number;
}

/** 盤面設定の表(CONTEXT.md「Selector」)。種の既定から DB へ初期化され、以後は
 *  DB が正本。 */
export type ExecutionSettingTable = readonly ExecutionSettingRow[];

/** moonshot 向きの spawn と auth probe が env に載せるモデル表記(ADR 0097 決定4
 *  の注入一式の3つ目)。probe は agent の定義も要求も持たない**盤面自身の**呼び
 *  出しなので、表を引かずこの定数を読む —— 表は agent の実行設定を決めるもので、
 *  盤面が自分の probe を走らせる向き先ではない。 */
export const MOONSHOT_DEFAULT_MODEL = "kimi-k3[1m]";

/** 盤面既定の段(ADR 0200 決定4): 要求が無い task と下書きが読む。 */
export function boardDefaultTier(db: Db): Tier {
  return loadExecutionDefaults(db).defaultTier;
}

/** 段の名前の線(ADR 0200 決定2): agent.md の `tier` に書ける文字列 —— 英小文字で始まり英小文字・数字・`-`・`_` だけで、
 *  YAML が同じ文字列として読み戻すもの(`true` / `null` は YAML では文字列でない)。 */
export function assertTierName(db: Db, name: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(name) || parseYaml(name) !== name) {
    throw new DomainError(`tier name "${name}" must start with a lowercase letter and use only a-z, 0-9, - and _ (and not be a YAML keyword such as true / null), so agent.md can write it as its tier`);
  }
  if (tierNames(db).includes(name)) throw new DomainError(`the board already has a tier named "${name}"`);
}

/** 段の説明の線(ADR 0200 決定3): 必須の1行。 */
export function assertTierDescription(description: string): void {
  if (whyBlank(description) || /[\r\n]/.test(normalizeText(description))) throw new DomainError("a tier's description is one non-empty line");
}

/** 生きている段の id を順序どおりに。 */
function liveTierIds(db: Db): number[] {
  return (db.prepare("SELECT id FROM tiers WHERE position IS NOT NULL ORDER BY position").all() as { id: number }[]).map((row) => row.id);
}

/** 一覧の位置は生きている段の中の添字で、`max` までを受ける。 */
export function assertPosition(position: number, max: number): void {
  if (position > max) throw new DomainError(`a tier position is an index into the board's list, 0 to ${max}`);
}

/** 段 `id` を、ほかの生きている段 `others`(順序どおり)の `position` 番目に置いて順序を書き直す。position は UNIQUE で、
 *  SQLite は UPDATE の行ごとに一意を検査するので、いったん全部を負に退けてから 0.. を振る(途中で衝突しない)。 */
function placeTier(db: Db, others: readonly number[], id: number, position: number): void {
  db.prepare("UPDATE tiers SET position = -position - 1 WHERE position IS NOT NULL").run();
  const set = db.prepare("UPDATE tiers SET position = ? WHERE id = ?");
  [...others.slice(0, position), id, ...others.slice(position)].forEach((tier, index) => set.run(index, tier));
}

/** 段を消せない理由(ADR 0200 決定2 / 追記 2026-10-06): 行がある・盤面設定が指す・未決着の task が要求している・registry の
 *  agent.md が名指している。空 = 消せる。`listAgents` は手元の clone を同期で読む(fetch しない)。無い = registry の無い盤面で、
 *  照合しない。読めなければ「名指していない」と見なさず削除ごと拒む。 */
function tierDeletionBlockers(db: Db, id: number, name: Tier, listAgents?: ListAgentTiers): string[] {
  const reasons: string[] = [];
  const rows = loadExecutionSettingTable(db).filter((row) => row.tier === name);
  if (rows.length > 0) reasons.push(`it has execution-setting rows: ${rows.map(rowName).join(", ")}`);
  const defaults = db.prepare("SELECT default_tier_id, judgement_tier_id FROM execution_defaults").get() as { default_tier_id: number; judgement_tier_id: number };
  if (defaults.default_tier_id === id) reasons.push("it is the board's default tier");
  if (defaults.judgement_tier_id === id) reasons.push("it is the board's judgement tier");
  const tasks = db
    .prepare("SELECT id FROM tasks WHERE status NOT IN ('done', 'cancelled') AND (tier_id = ? OR review_tier_id = ?) ORDER BY rowid")
    .all(id, id) as { id: string }[];
  if (tasks.length > 0) reasons.push(`unsettled tasks request it: ${tasks.map((task) => task.id).join(", ")}`);
  if (listAgents) {
    let agents: ReturnType<ListAgentTiers>;
    try {
      agents = listAgents();
    } catch (err) {
      throw new DomainError(`tier "${name}" cannot be deleted: the registry could not be read to check its agent.md tiers: ${String(err)}`);
    }
    const naming = agents.filter((agent) => agent.tier === name);
    if (naming.length > 0) reasons.push(`agents name it in agent.md: ${naming.map((agent) => agent.name).join(", ")}`);
  }
  return reasons;
}

/** 段の1つの操作を書く(挿入・説明と位置の編集・改名・論理削除)。 */
function applyTierChange(
  db: Db,
  change: Extract<ExecutionSettingsChange, { setting: "insert_tier" | "edit_tier" | "rename_tier" | "delete_tier" }>,
  listAgents?: ListAgentTiers,
): void {
  const ids = liveTierIds(db);
  if (change.setting === "insert_tier") {
    assertTierName(db, change.name);
    assertTierDescription(change.description);
    assertPosition(change.position, ids.length);
    const id = Number(db.prepare("INSERT INTO tiers (name, description) VALUES (?, ?)").run(change.name, change.description).lastInsertRowid);
    placeTier(db, ids, id, change.position);
    return;
  }
  assertKnownTier(db, "tier", change.name);
  const id = tierIdOf(db, change.name);
  if (change.setting === "rename_tier") {
    assertTierName(db, change.to);
    db.prepare("UPDATE tiers SET name = ? WHERE id = ?").run(change.to, id);
    return;
  }
  if (change.setting === "delete_tier") {
    const reasons = tierDeletionBlockers(db, id, change.name, listAgents);
    if (reasons.length > 0) throw new DomainError(`tier "${change.name}" cannot be deleted: ${reasons.join("; ")}`);
    db.prepare("UPDATE tiers SET position = NULL WHERE id = ?").run(id);
    return;
  }
  if (change.description !== undefined) {
    assertTierDescription(change.description);
    db.prepare("UPDATE tiers SET description = ? WHERE id = ?").run(change.description, id);
  }
  if (change.position !== undefined) {
    assertPosition(change.position, ids.length - 1);
    placeTier(db, ids.filter((other) => other !== id), id, change.position);
  }
}

/** 配布される種の表。`/implementation-delegation` §4 / §5 の表と**同じ内容・同じ
 *  鮮度管理**で、ズレたら片方を直す(ADR 0110 / spec #541)。
 *
 *  anthropic も openai も具体 id 行で、世代交代のたびに手入れが要る —— anthropic の
 *  alias は扉が拒む(ADR 0182 決定1)。openai は 2026-09-10 の実測で Codex の `-m` が
 *  `Astra` / `Sol` / `Terra` / `Luna` を alias として受けない(ChatGPT account では
 *  API が 400 を返し `turn.failed` で終わる)。moonshot は kimi-k3 を economy に1行 —— 分類は価格帯では
 *  なく性能で行い(第三者の同一ハーネス測定はすべて Sonnet 5 / Terra の帯)、
 *  「moonshot に frontier 級は無い」は表の穴として正直に書く(ADR 0114 決定2)。
 *  effort が全行 `high` なのは、fallback の出所が adapter 定数から表へ移った結果
 *  として既定が `medium` から上がったということである。価格の根拠と出典は #556。 */
export const SEED_EXECUTION_SETTINGS: ExecutionSettingTable = [
  { provider: "anthropic", tier: "economy", model: "claude-sonnet-5-5", effort: "high", price_in: 2, price_out: 10 },
  { provider: "anthropic", tier: "standard", model: "claude-opus-5-5", effort: "high", price_in: 5, price_out: 25 },
  { provider: "anthropic", tier: "frontier", model: "claude-fable-5-1", effort: "high", price_in: 10, price_out: 50 },
  { provider: "moonshot", tier: "economy", model: MOONSHOT_DEFAULT_MODEL, effort: "high", price_in: 3, price_out: 15 },
  { provider: "openai", tier: "economy", model: "gpt-5.6-terra", effort: "high", price_in: 2, price_out: 12 },
  { provider: "openai", tier: "standard", model: "gpt-5.6-sol", effort: "high", price_in: 4, price_out: 20 },
  { provider: "openai", tier: "frontier", model: "gpt-6-astra", effort: "high", price_in: 10, price_out: 50 },
];

/** worker session が実際に走る計算資源の組(CONTEXT.md「実行設定」)と、その出所。
 *  `advisor` が undefined であって null でないのは、消費する側 ——
 *  `advisorSpawnFlags` と `workerSpawnEnv`(claude-worker.ts)—— が「不在」を
 *  undefined で綴るため。`worker_spawned.advisor` の null はイベント層の綴りで
 *  ある。 */
export interface ExecutionSetting {
  provider: Provider;
  model: string;
  effort: string;
  advisor: string | undefined;
  /** 解決した段(ADR 0210 決定1)。候補は要求ティアの行だけなので、走った段 = pickup が解決した段。 */
  tier_id: TierId;
  /** ADR 0110 決定3: 選んだ値だけでなく**なぜその値になったか**を刻む。今は
   *  ティアの出所1つ —— `"task"` は task の要求列、`"agent"` は agent.md の
   *  `tier`、`"review_tier"` はレビュー専用の要求、`"board"` は盤面既定。未指定(列が null)と「既定を選んだ」が
   *  記録上区別されるのはこの1値による。`advisor` は advisor を有効にした entry の候補だけが持つ advisor の出所
   *  (ADR 0208 決定6)—— pin の綴りだけでは、上限から下がった理由を記録から区別できない。 */
  source: { tier: TierSource; provider: ProviderSource; advisor?: AdvisorSource };
}

/** entry を候補から外す資源(CONTEXT.md「Selector」/ ADR 0110 決定3)。Throttle の
 *  Provider 窓・model 窓、Provider 認証の quarantine、Harness の封じ込め —— 出所は
 *  違っても、selector から見ればどれも「この Provider は今使えない」「この model は
 *  今使えない」の2つに畳める。**agent 名の集合ではない**のが #544 の要点で、
 *  provider 全体の窓は agent を丸ごと外すのではなくその entry を外す。 */
export interface ExecutionExclusions {
  providers: readonly Provider[];
  /** `model` は窓の綴り。Throttle の窓は系列単位の枠なので、`"fable"` の窓は
   *  `claude-fable-5-1` の行に部分一致で当たる(ADR 0182 決定3)。 */
  models: readonly { provider: Provider; model: string }[];
}

/** 何も除外されていない(今日の spawn 経路の既定)。 */
const NO_EXCLUSIONS: ExecutionExclusions = { providers: [], models: [] };

/** 観測された1つの窓が、この model に当たるか。**綴りはここ1つ**(issue #544):
 *  除外を当てる `firstSelectable` と、scheduler が「この設定に関係する窓」を絞る
 *  filter が別々の式を持つと、保存された観測を読む表示と同じ poll で観測し直す
 *  ゲートが、全テスト緑のまま非 fable の model 名でズレる。
 *
 *  部分一致を持つのは、Throttle の窓が系列単位の枠だから —— `fable` の窓は
 *  `claude-fable-5-1` の行に当たる。学習器の行との照合は完全一致で、この式を
 *  使わない(ADR 0182 決定3)。 */
export function windowMatchesModel(windowModel: string, model: string): boolean {
  return windowModel === model || model.toLowerCase().includes(windowModel.toLowerCase());
}

/** 観測された1つの窓が、この実行設定に当たるか —— main の model か advisor の model のどちらか(ADR 0208 決定5:
 *  advisor は自分の model の枠を消費する)。除外の式(`selectable`)と、scheduler が観測から関係する窓を絞る filter の
 *  両方がこれを通る。 */
export function windowMatchesSetting(windowModel: string, setting: Pick<ExecutionSetting, "model" | "advisor">): boolean {
  return windowMatchesModel(windowModel, setting.model) || (setting.advisor !== undefined && windowMatchesModel(windowModel, setting.advisor));
}

/** 1回の pickup が決める実行設定の入力(CONTEXT.md「Selector」)。
 *
 *  **`ExecutionRequest` とは呼ばない**: CONTEXT.md の「要求(Execution request)」は
 *  task が持つ2列のことで、この型はそれに盤面設定と agent の宣言を足した selector
 *  の入力である。用語は CONTEXT.md が正本(docs/agents/domain.md)なので、別物に
 *  同じ名前を当てない。
 *
 *  ティアの要求元が2つになったので、どちらの `tier` かは**フィールド名で**言う
 *  (`tier` 1つのままでは解決済みの値と生の要求が同じ綴りになる)。どちらも省略可
 *  だが省略を `undefined` として**明示させる** —— 任意フィールドにすると、新しい
 *  呼び手が task の要求を渡し忘れても型が通り、要求が黙って落ちる。 */
export interface SelectorInput {
  /** この agent が走ってよい Provider entry(ADR 0110 決定1)。長さ1なら今日の
   *  単一 Provider の agent で、選択は「それしか無かった」になる。 */
  entries: readonly { provider: Provider; advisor: boolean }[];
  /** Provider 順位(盤面設定 `execution_defaults.provider_rank`、未設定 = 盤面が知る Provider の
   *  宣言順 `PROVIDER_VALUES`)。**入力であって定数ではない** —— 盤面境界の薄い
   *  ラッパ(`selectorInputFor`)が DB から読んで渡す。`PROVIDER_VALUES` の順列で
   *  あること(`whyInvalidProviderRank`)は書く口が保証する —— 欠けた Provider は
   *  `indexOf` が -1 になって**先頭**に並んでしまう。 */
  providerRank: readonly Provider[];
  /** task の要求ティア(CONTEXT.md「要求」)。省略 → agent の `tier`。 */
  taskTier: Tier | undefined;
  /** 候補を並べる鍵(CONTEXT.md「要求」/ ADR 0114 決定1)。selector はこの欄だけを読み、task の type を見ない ——
   *  埋めるのは `selectorInputFor` で、work は task の優先順位 → 盤面設定の work 用の既定、review は盤面設定の
   *  review 用の既定(review task の要求は `review_tier` だけ —— ADR 0114 退けた案、ADR 0111 追記10)。
   *  selector 自身の倒れ先 `BOARD_DEFAULT_PRIORITY` は、それを通らない呼び手のためだけにある。 */
  priority: Priority | undefined;
  /** ADR 0111: review tasks use this request instead of the work tier. */
  reviewTier?: Tier;
  /** agent.md の `tier`。省略 → 盤面既定。 */
  agentTier: Tier | undefined;
  /** 盤面既定の段(盤面設定、ADR 0200 決定4)。 */
  boardTier: Tier;
  /** 盤面の生きている段(`liveTierRows`): 解決した段の名前を候補が運ぶ id に引く(ADR 0210 決定1)。 */
  tiers: readonly { id: TierId; name: Tier }[];
  /** 盤面設定: advisor の上限(ADR 0208 決定1)。`off` なら advisor を有効にした entry を advisor の無い entry
   *  として選ぶ(決定3)。 */
  advisorCeiling: AdvisorCeiling;
}

/** 価格の鍵(ADR 0114 決定4): out 単価、同額なら in 単価。 */
function byPrice(a: ExecutionSettingRow, b: ExecutionSettingRow): number {
  return a.price_out - b.price_out || a.price_in - b.price_in;
}

/** この provider のこのティアの行を安い順に。行が無ければ空 —— 表の穴は設定漏れ
 *  ではなく事実で(「moonshot に frontier 級は無い」)、selector は entry を除外する
 *  (ADR 0114 決定3)。 */
function rowsFor(table: ExecutionSettingTable, provider: Provider, tier: Tier): ExecutionSettingRow[] {
  return table.filter((row) => row.provider === provider && row.tier === tier).sort(byPrice);
}

/** 表の行で走る Board call(振り返り・下書き)の行。selector を通らず(ADR 0111 決定4)、Provider は
 *  anthropic 固定、ティアは呼び手が決め、その走れる行のうち窓の閉じていない行の最安(ADR 0192 / ADR 0184 追記 /
 *  #1445)。窓は走れる行の表に入れず、ここでだけ当てる —— 判定は Throttle の観測を読む側が渡す(throttle.ts が
 *  このモジュールを import するので、直接読むと循環になる)。呼び出しごとに読むので書き換えは次の呼び出しから効く。
 *  撃てる行が無ければ投げ、呼び手が「撃てなかった」に畳む —— 理由は行が無い → すべて Quarantine 中 → 窓の順で分ける。 */
export function anthropicBoardCallRow(db: Db, tier: Tier, windowClosed: (model: string) => boolean): ExecutionSettingRow {
  const runnable = rowsFor(runnableTable(db), "anthropic", tier);
  if (!runnable.length) {
    if (rowsFor(loadExecutionSettingTable(db), "anthropic", tier).length) {
      throw new Error(`every row for anthropic / ${tier} in the board's execution-setting table is under a row quarantine`);
    }
    throw new Error(`the board's execution-setting table has no row for anthropic / ${tier}`);
  }
  const row = runnable.find((r) => !windowClosed(r.model));
  // 窓の閉鎖は throttle だけでなく Provider 認証の除外でも起きるので、原因は名乗らない
  if (!row) throw new Error("the Anthropic window is closed");
  return row;
}

/** entry 集合から要求ティアの行を全部集め、優先順位の鍵で並べる(ADR 0110 決定3 /
 *  ADR 0114 決定3・4)。**除外は当てない** —— 除外は観測のたびに育つので、盤面境界が
 *  候補を1度作り、除外が増えるたびに `selectable` を引き直す形にしてある。
 *  要求ティアの行を持たない entry は候補に入らない(Throttle と同じ「除外」)。
 *
 *  advisor の model は agent.md には書かれない: 真のときだけ main の行と盤面の上限から導出する
 *  (`claudeAdvisorFor`、ADR 0208 —— 表もティアも読まない)。advisor を宣言
 *  できるのは anthropic の entry だけで(ADR 0097)、adapter が候補にしない行(知らない系列、
 *  advisor を受けられない世代 —— ADR 0200 追記 2026-10-07)は advisor つきの entry の候補にしない —— advisor 無しで黙って走らせず、
 *  CLI が起動時に断る組も pin しない。上限が `off` のときと main が上限より上のときの advisor 無しは除外ではなく、
 *  候補に残る(ADR 0208 決定2・3)。 */
function executionSettingCandidates(
  request: SelectorInput,
  table: ExecutionSettingTable,
): ExecutionSetting[] {
  const tier = request.reviewTier ?? request.taskTier ?? request.agentTier ?? request.boardTier;
  // 解決順のどの段で決まったか。値の一致では畳まない —— agent と同じティアを
  // task が要求しても出所は "task" で、それが学習の文脈変数になる。
  const tierSource: TierSource =
    request.reviewTier !== undefined ? "review_tier" :
    request.taskTier !== undefined ? "task" : request.agentTier !== undefined ? "agent" : "board";
  const priority = request.priority ?? BOARD_DEFAULT_PRIORITY;
  const tierId = request.tiers.find((t) => t.name === tier)!.id;
  const providerSource: ProviderSource =
    request.entries.length === 1 ? "only" : priority === "cost" ? "cost" : "rank";
  const byRank = (a: ExecutionSettingRow, b: ExecutionSettingRow) =>
    request.providerRank.indexOf(a.provider) - request.providerRank.indexOf(b.provider);
  return request.entries
    .flatMap((entry) =>
      rowsFor(table, entry.provider, tier).flatMap((main) => {
        const derived: { advisor: string | undefined; source?: AdvisorSource } | undefined = entry.advisor
          ? claudeAdvisorFor(main.model, request.advisorCeiling)
          : { advisor: undefined };
        if (!derived) return [];
        // fable_then_opus: `fable` の advisor の隣に、Fable の窓で外れたときの下げ先を並べる(ADR 0208 決定5)。
        // どちらが残るかは除外の式(`selectable`)が決める —— 候補は除外を知らずに1度だけ作られる
        const downgraded =
          request.advisorCeiling === "fable_then_opus" && derived.advisor === "fable" && claudeAdvisorFor(main.model, "opus");
        return [{ main, ...derived }, ...(downgraded ? [{ main, advisor: downgraded.advisor, source: "window_downgraded" as const }] : [])];
      }),
    )
    .sort((a, b) =>
      priority === "cost" ? byPrice(a.main, b.main) || byRank(a.main, b.main) : byRank(a.main, b.main) || byPrice(a.main, b.main),
    )
    .map(({ main, advisor, source }) => ({
      provider: main.provider,
      model: main.model,
      effort: main.effort,
      advisor,
      tier_id: tierId,
      source: { tier: tierSource, provider: providerSource, ...(source && { advisor: source }) },
    }));
}

/** 除外を当てて残った先頭を採る。scheduler のゲートも queue の skipped 表示も
 *  Pickable head の判定もここを通るので、「走る」と「skipped と表示する」が退化して
 *  ズレることがない。 */
export function firstSelectable(
  candidates: readonly ExecutionSetting[],
  excluded: ExecutionExclusions,
): ExecutionSetting | null {
  return selectable(candidates, excluded)[0] ?? null;
}

/** **除外の式はこの1つ**(issue #544)。除外を当てて残った候補を selector の並びの
 *  まま返す(`firstSelectable` の先頭と、学習器が推薦する母集団 ——
 *  除外された行は誰にも選べないので、推薦もその外では出さない)。 */
export function selectable(
  candidates: readonly ExecutionSetting[],
  excluded: ExecutionExclusions,
): ExecutionSetting[] {
  return candidates.filter(
    (candidate) =>
      !excluded.providers.includes(candidate.provider) &&
      !excluded.models.some((window) => window.provider === candidate.provider && windowMatchesSetting(window.model, candidate)) &&
      // 窓で下げた候補は、Fable の窓が `fable` の advisor を外しているあいだだけ選べる(ADR 0208 決定5)
      (candidate.source.advisor !== "window_downgraded" ||
        excluded.models.some((window) => window.provider === candidate.provider && windowMatchesModel(window.model, "fable"))),
  );
}

/** pickup 1回ぶんの実行設定を決める決定論の規則(CONTEXT.md「Selector」/ ADR 0110
 *  決定3)。「誰が走るか」(Assignee)は選ばない —— 選ぶのは、その agent が走る
 *  計算資源だけである。
 *
 *  全 entry が除外されたら `null`: 例外ではない —— 全除外は既存の skipped の枝
 *  (Provider / model throttle)であって、設定の穴ではない。 */
export function selectExecutionSetting(
  request: SelectorInput,
  table: ExecutionSettingTable,
  excluded: ExecutionExclusions = NO_EXCLUSIONS,
): ExecutionSetting | null {
  return firstSelectable(executionSettingCandidates(request, table), excluded);
}

/** 盤面の表を DB から読む(ADR 0110 決定3: 種から初期化された後は DB が正本)。
 *  表は数行の定数サイズなので pickup ごとに読み直してよく、settings タブ / 管理MCP の
 *  編集(#545)が次の pickup から効くのはそのおかげである。 */
export function loadExecutionSettingTable(db: Db): ExecutionSettingTable {
  return db
    .prepare(
      `SELECT provider, t.name AS tier, model, effort, price_in, price_out
       FROM execution_settings JOIN tiers t ON t.id = execution_settings.tier_id ORDER BY provider, model, effort`,
    )
    .all() as ExecutionSettingRow[];
}

/** 盤面設定(ADR 0110 決定5): advisor の上限(ADR 0208)、
 *  Provider 順位、優先順位の既定、学習器の昇格(ADR 0150 決定4)、盤面自身の判断の段(振り返り Board call と
 *  周期 meta-review が共有する、ADR 0200 決定4)と盤面既定の段。行は種で作られ、列が NULL = 未設定 = コードの既定。 */
interface ExecutionDefaults {
  advisorCeiling: AdvisorCeiling;
  providerRank: readonly Provider[];
  priority: Priority;
  /** review task の並べ方(ADR 0111 追記10)。`priority` は work 用。 */
  reviewPriority: Priority;
  learnerPromoted: boolean;
  defaultTier: Tier;
  judgementTier: Tier;
}

/** settings タブ / 管理MCP の読み口(ADR 0110 決定5): 表と段の一覧(説明つき、順序どおり —— ADR 0200 決定3)と盤面設定を1往復で。
 *  表は (provider, model, effort) 順 —— 主キーの順で、UI も MCP も同じ並びを見る。 */
export function readExecutionSettings(db: Db) {
  return { table: loadExecutionSettingTable(db), tiers: readTiers(db), ...loadExecutionDefaults(db) };
}

/** 人間の2つの扉(settings タブ・管理MCP)の読み口: 各行に、開いている行の Quarantine の question id(無ければ null)を
 *  添える(ADR 0184 決定6)。meta-review の材料と worker の読み口は Quarantine を添えない `readExecutionSettings`。 */
export function readExecutionSettingsWithQuarantine(db: Db) {
  const settings = readExecutionSettings(db);
  const open = openQuarantineQuestions(db, "tableRow");
  return {
    ...settings,
    table: settings.table.map((row) => ({
      ...row,
      quarantine_question_id: open.get(tableRowValue(row.provider, row.model)) ?? null,
    })),
  };
}

/** 表の行の鍵 = 主キー (provider, model, effort)(ADR 0200 決定5)。行を名指す面はこの3欄で名指す。 */
const rowKeySchema = z.object({ provider: z.enum(PROVIDER_VALUES), model: requiredTextSchema, effort: requiredTextSchema });
type RowKey = z.infer<typeof rowKeySchema>;

/** 鍵として読める3欄(提案の行・spawn の記録も同じ3欄を持つ)。 */
type RowKeyFields = { provider: string; model: string; effort: string };

/** この行が鍵の行か。 */
export const matchesRowKey = (row: ExecutionSettingRow, key: RowKeyFields) =>
  row.provider === key.provider && row.model === key.model && row.effort === key.effort;

/** 行を文面で名指す綴り(エラー・question の diff)。 */
export const rowName = (key: RowKeyFields) => `${key.provider} / ${key.model} at effort ${key.effort}`;

/** `row` を表に書けるか(ADR 0200 決定5): 1つの (model, effort) の組が属する段は1つ、1つの段に同じ model は1行まで。
 *  `key` は編集で置き換わる行で、照合から外す。行を書く扉と routing の行の提案が同じこの1本を通る。 */
export function assertRowFits(table: ExecutionSettingTable, row: ExecutionSettingRow, key?: RowKey): void {
  for (const other of table) {
    if ((key && matchesRowKey(other, key)) || other.provider !== row.provider || other.model !== row.model) continue;
    const name = `${rowName(other)} in tier ${other.tier}`;
    if (other.effort === row.effort) throw new DomainError(`the execution-setting table already has the row ${name}; a (model, effort) pair belongs to one tier, so edit that row instead`);
    if (other.tier === row.tier) throw new DomainError(`the execution-setting table already has the row ${name}; a tier holds at most one row per model`);
  }
}

/** 足す段の名前・説明・位置。段の挿入と、段を足す提案の修正値が同じ形を通る。 */
const newTierSchema = z.object({ name: requiredTextSchema, description: requiredTextSchema, position: z.number().int().nonnegative() });

/** settings タブ / 管理MCP が撃つ1つの変更(ADR 0110 決定5)。**綴りは1つ** —— /api と
 *  MCP tool が同じ schema を通り、同じ関数が書き、同じ payload が操作イベントになる。
 *  `key` の無い `row` は追加、`key` つきの `row` はその行の編集、`delete_row` は削除。段は `insert_tier`(一覧の添字の位置へ)・
 *  `edit_tier`(名前で名指し、説明と位置)・`rename_tier`(`changeExecutionSettings` が agent.md を書き換えてから)・`delete_tier`(論理削除)。 */
export const executionSettingsChangeSchema = z.discriminatedUnion("setting", [
  z.object({
    setting: z.literal("row"),
    key: rowKeySchema.optional(),
    row: z.object({
      provider: z.enum(PROVIDER_VALUES),
      tier: requiredTextSchema,
      model: requiredTextSchema,
      effort: requiredTextSchema,
      price_in: z.number().superRefine((value, ctx) => {
        const reason = whyInvalidPrice(value);
        if (reason) ctx.addIssue({ code: "custom", message: reason });
      }),
      price_out: z.number().superRefine((value, ctx) => {
        const reason = whyInvalidPrice(value);
        if (reason) ctx.addIssue({ code: "custom", message: reason });
      }),
    }),
  }),
  z.object({ setting: z.literal("delete_row"), ...rowKeySchema.shape }),
  z.object({ setting: z.literal("advisor_ceiling"), value: z.enum(ADVISOR_CEILINGS) }),
  z.object({
    setting: z.literal("provider_rank"),
    value: z.array(z.enum(PROVIDER_VALUES)).superRefine((value, ctx) => {
      const reason = whyInvalidProviderRank(value);
      if (reason) ctx.addIssue({ code: "custom", message: reason });
    }),
  }),
  z.object({ setting: z.literal("priority"), value: z.enum(PRIORITIES) }),
  z.object({ setting: z.literal("review_priority"), value: z.enum(PRIORITIES) }),
  newTierSchema.extend({ setting: z.literal("insert_tier") }),
  z.object({
    setting: z.literal("edit_tier"),
    name: requiredTextSchema,
    description: requiredTextSchema.optional(),
    position: z.number().int().nonnegative().optional(),
  }).refine((change) => change.description !== undefined || change.position !== undefined, { message: "edit_tier takes description and/or position" }),
  z.object({ setting: z.literal("rename_tier"), name: requiredTextSchema, to: requiredTextSchema }),
  z.object({ setting: z.literal("delete_tier"), name: requiredTextSchema }),
  z.object({ setting: z.literal("default_tier"), value: requiredTextSchema }),
  z.object({ setting: z.literal("judgement_tier"), value: requiredTextSchema }),
  // 扉は降格だけを受ける。昇格は承認の適用が schema を通さず書く(ADR 0150 決定4)。
  // 拒否文は盤面のコードが発する文なので、ADR の引用は文でなくここに置く(ADR 0207)
  z.object({
    setting: z.literal("learner_promoted"),
    value: z.boolean().refine((value) => !value, {
      message: "the learner is promoted only by approving a routing meta-review's proposal question; this door only demotes",
    }),
  }),
]);
export type ExecutionSettingsChange = z.infer<typeof executionSettingsChangeSchema>;

/** 行の提案の変更と、承認に添える修正値の形(ADR 0150 決定2): 動かせるのは分類と effort だけ。 */
const routingRowChangeSchema = z
  .object({ tier: requiredTextSchema, effort: requiredTextSchema })
  .partial()
  .strict()
  .refine((change) => Object.keys(change).length > 0, { message: "name at least one of tier / effort" });
export type RoutingRowChange = z.infer<typeof routingRowChangeSchema>;

/** 提案 verb の `change` と回答の `amendment` の検査。schema 違反と一覧に無い段は DomainError(扉は形を緩く受ける)。 */
export function parseRoutingRowChange(tiers: readonly Tier[], input: unknown): RoutingRowChange {
  const parsed = routingRowChangeSchema.safeParse(input);
  if (!parsed.success || (parsed.data.tier !== undefined && !tiers.includes(parsed.data.tier))) {
    const problem = parsed.success ? `unknown tier "${parsed.data.tier}"` : parsed.error.issues.map((i) => i.message).join("; ");
    throw new DomainError(`a row change takes tier (${tiers.join(" / ")}) and/or effort, nothing else: ${problem}`);
  }
  return parsed.data;
}

/** pin の照合(ADR 0150 決定1): 提案が焼いた行と表の現在の行を全欄で比べ、崩れた欄の名前を返す(空 = pin は生きている)。
 *  行は鍵 (provider, model, effort) で引き、消えていれば(effort の書き換えも含む)null。変更の行き先の段が消えていれば `target_tier`(issue #1458)。昇格 / 降格の提案の pin はフラグの現在値。
 *  tier の提案は根拠の行を全欄で比べる(消えた行も `rows` —— agent の側の pin は表からは見えないので `registryPinChanges` が言う)。
 *  `to` が pin の段のいまの1段下でなくなれば(挿入・並べ替え・削除)`tier_order`(ADR 0200 決定4 / issue #1438)。
 *  段を足す提案は移す行を行の提案と同じに比べ、隣の段が入れ替わっていれば `neighbours`(issue #1424)。
 *  段の説明の提案は id で引いた生きている段の説明を比べ、段が消えていれば null(ADR 0200 決定7)。
 *  段は id で比べる(issue #1436)—— 改名はどの pin も崩さない。消した段の id は生きている段に引けないので崩れる。 */
export function routingPinChanges(
  proposal: RoutingProposal | RegistryProposal,
  settings: { table: ExecutionSettingTable; learnerPromoted: boolean; tiers: readonly { id: TierId; name: Tier; description: string }[] },
): Array<"tier" | "price_in" | "price_out" | "learner_promoted" | "rows" | "tier_order" | "description" | "neighbours" | "target_tier"> | null {
  const liveName = (id: TierId) => settings.tiers.find((t) => t.id === id)?.name;
  if (proposal.kind === "registry") {
    const held = proposal.pin.rows.every((pinned) =>
      settings.table.some((row) => matchesRowKey(row, pinned) && row.tier === liveName(pinned.tier)),
    );
    const adjacent = settings.tiers[settings.tiers.findIndex((t) => t.id === proposal.pin.tier) - 1]?.id === proposal.to;
    return [...(held ? [] : (["rows"] as const)), ...(adjacent ? [] : (["tier_order"] as const))];
  }
  if (proposal.op === "tier_description") {
    const tier = settings.tiers.find((t) => t.id === proposal.tier);
    return tier ? (tier.description === proposal.pin.description ? [] : ["description"]) : null;
  }
  if (proposal.op !== "row" && proposal.op !== "add_tier") return proposal.pin.promoted === settings.learnerPromoted ? [] : ["learner_promoted"];
  const pin = proposal.op === "row" ? proposal.pin : proposal.pin.row;
  const current = settings.table.find((row) => matchesRowKey(row, pin));
  if (!current) return null;
  const changed: Array<"tier" | "price_in" | "price_out" | "neighbours" | "target_tier"> = (["tier", "price_in", "price_out"] as const).filter(
    (field) => current[field] !== (field === "tier" ? liveName(pin.tier) : pin[field]),
  );
  if (proposal.op === "row" && proposal.change.tier !== undefined && liveName(proposal.change.tier) === undefined) changed.push("target_tier");
  if (proposal.op === "add_tier") {
    // 隣は提案時点の添字にいまいる段 —— 説明の編集・移動・挿入・削除のどれで入れ替わっても崩れる(改名は同じ段のまま)
    const { position } = proposal.tier;
    const same = (pinned: TierNeighbour | null, now: { id: TierId; description: string } | undefined) =>
      pinned?.id === now?.id && pinned?.description === now?.description;
    if (!same(proposal.pin.below, settings.tiers[position - 1]) || !same(proposal.pin.above, settings.tiers[position])) changed.push("neighbours");
  }
  return changed;
}

/** 修正値の合成(ADR 0150 決定2): 適用する行 = pin の行に提案の変更、その上に人間の修正値を重ねたもの。段は名前へ引いた提案で合成する。 */
export function composeRoutingRow(proposal: RoutingRowProposal<Tier>, amendment?: RoutingRowChange): ExecutionSettingRow {
  return { ...proposal.pin, ...proposal.change, ...amendment };
}

/** tier の提案の agent 側の pin(issue #920): registry の agent の tier が焼いた段のままか。agent.md は段を名前で書くので、
 *  生きている段の名前から id に引いて比べる(issue #1436)。agent が消えていても崩れている。 */
export function registryPinChanges(proposal: RegistryProposal, agent: { tier?: string } | undefined, tiers: readonly { id: TierId; name: Tier }[]): Array<"agent_tier"> {
  return tiers.some((t) => t.id === proposal.pin.tier && t.name === agent?.tier) ? [] : ["agent_tier"];
}

/** 段を足す提案の修正値(ADR 0200 決定8 / ADR 0150 決定2): 名前・説明・位置の少なくとも1つ。値の検査(名前の一意など)は
 *  回答時に段の挿入の扉がやり直す。 */
const addTierAmendmentSchema = newTierSchema
  .partial()
  .strict()
  .refine((amendment) => Object.keys(amendment).length > 0, { message: "give at least one of name / description / position" });
export type AddTierAmendment = z.infer<typeof addTierAmendmentSchema>;

export function parseAddTierAmendment(amendment: unknown): AddTierAmendment {
  const parsed = addTierAmendmentSchema.safeParse(amendment);
  if (!parsed.success) throw new DomainError(`an add-tier amendment takes name, description and/or position, nothing else: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return parsed.data;
}

/** 対象ティアに agent の entry のいずれかの行があるか(spec #916 B)。 */
function tierHasRowFor(table: ExecutionSettingTable, providers: readonly string[], tier: Tier): boolean {
  return table.some((row) => row.tier === tier && providers.includes(row.provider));
}

/** 下げ先の門(提案 verb と回答時の修正後の値の検査): 下げ先に agent の entry の走れる行が無ければ、下げた agent は
 *  skipped になるので断る(spec #916 B / ADR 0184 追記)。行が無いのか、すべて Quarantine 中なのかを文面で分ける。 */
export function assertTierRunnableFor(db: Db, agent: string, providers: readonly string[], tier: Tier): void {
  if (tierHasRowFor(runnableTable(db), providers, tier)) return;
  const where = `at ${tier} for ${agent}'s providers (${providers.join(", ")})`;
  const why = tierHasRowFor(loadExecutionSettingTable(db), providers, tier) ? `every row ${where} is under a row quarantine` : `no row ${where}`;
  throw new DomainError(`the execution-setting table has ${why}, so the agent would be skipped`);
}

/** tier の提案の修正値の検査(ADR 0150 決定2): `to` だけで、pin の tier より下の任意のティア(段の順序は盤面の一覧)。 */
export function parseAgentTierAmendment(tiers: readonly Tier[], proposal: RegistryProposal<Tier>, amendment: unknown): Tier {
  const parsed = z.object({ to: requiredTextSchema }).strict().safeParse(amendment);
  if (!parsed.success || !tiers.includes(parsed.data.to) || tiers.indexOf(parsed.data.to) >= tiers.indexOf(proposal.pin.tier)) {
    throw new DomainError(`an agent tier amendment takes only to, a tier below ${proposal.pin.tier}`);
  }
  return parsed.data.to;
}

/** 段の説明の提案の修正値の検査(ADR 0200 決定7): `description` だけで、段の説明の線に収まる文面。 */
export function parseTierDescriptionAmendment(amendment: unknown): string {
  const parsed = z.object({ description: requiredTextSchema }).strict().safeParse(amendment);
  if (!parsed.success) throw new DomainError("a tier description amendment takes only description");
  assertTierDescription(parsed.data.description);
  return parsed.data.description;
}

/** 変更を書き、操作イベントとして経路つきで残す(CONTEXT.md「管理MCP」)。task を
 *  持たない盤面イベントなので task_id は NULL、帰属は人間。表を書くのはこの1本なので、routing の提案の陳腐化の hook
 *  (ADR 0150 決定1)もここに置く。`questionId` は提案 question への回答で適用したときの印で、meta-review の材料と「人間が変えた行」から外れる(ADR 0151)。
 *  返り値は execution_settings_changed の event id(何も変わらなければ null)。`listAgents` は段の削除の照合が読む(`tierDeletionBlockers`)。 */
export function applyExecutionSettingsChange(
  db: Db,
  change: ExecutionSettingsChange,
  origin: EventOrigin,
  at: Date,
  questionId?: string,
  listAgents?: ListAgentTiers,
): number | null {
  if ((change.setting === "insert_tier" || change.setting === "edit_tier") && change.description !== undefined) {
    change = { ...change, description: normalizeText(change.description) };
  }
  return db.transaction(() => {
    switch (change.setting) {
      case "row": {
        const { provider, tier, model, effort, price_in, price_out } = change.row;
        if (provider === "anthropic" && isClaudeModelAlias(model)) {
          throw new DomainError(`"${model}" is a Claude CLI alias whose target moves with CLI updates; a table row takes a concrete model id (e.g. claude-opus-5-5)`);
        }
        assertKnownTier(db, "tier", tier);
        const { key } = change;
        const table = loadExecutionSettingTable(db);
        if (key && !table.some((row) => matchesRowKey(row, key))) {
          throw new DomainError(`the execution-setting table has no row ${rowName(key)} to edit`);
        }
        assertRowFits(table, change.row, key);
        if (key) {
          db.prepare(
            `UPDATE execution_settings SET provider = ?, tier_id = ${liveTierId("?")}, model = ?, effort = ?, price_in = ?, price_out = ?
             WHERE provider = ? AND model = ? AND effort = ?`,
          ).run(provider, tier, model, effort, price_in, price_out, key.provider, key.model, key.effort);
        } else {
          db.prepare(`INSERT INTO execution_settings (provider, tier_id, model, effort, price_in, price_out) VALUES (?, ${liveTierId("?")}, ?, ?, ?, ?)`).run(
            provider, tier, model, effort, price_in, price_out,
          );
        }
        break;
      }
      case "default_tier":
      case "judgement_tier":
        assertKnownTier(db, change.setting, change.value);
        db.prepare(`UPDATE execution_defaults SET ${change.setting}_id = ${liveTierId("?")}`).run(change.value);
        break;
      case "insert_tier":
      case "edit_tier":
      case "rename_tier":
      case "delete_tier":
        applyTierChange(db, change, listAgents);
        break;
      case "delete_row":
        // 消す行が無ければ何も変わっていないので、操作イベントも残さない
        if (db.prepare("DELETE FROM execution_settings WHERE provider = ? AND model = ? AND effort = ?").run(change.provider, change.model, change.effort).changes === 0) return null;
        break;
      default: {
        const column = change.setting;
        const value =
          typeof change.value === "boolean" ? Number(change.value)
          : change.setting === "provider_rank" ? JSON.stringify(change.value) : change.value;
        db.prepare(`UPDATE execution_defaults SET ${column} = ?`).run(value);
      }
    }
    const eventId = appendEvent(db, {
      taskId: null,
      workerId: HUMAN_WORKER_ID,
      origin,
      payload: { kind: "execution_settings_changed", ...change, ...(questionId && { question_id: questionId }) },
      at,
    });
    // 回答中の question は answerQuestion が先に done にしているので、承認した提案が自分自身を決着させることは無い
    settleStaleProposals(db, at, eventId);
    settleRemovedRowQuarantines(db, at, eventId);
    return eventId;
  })();
}

/** registry の agent.md の `tier` を旧い名前から新しい名前へ書き換えて着地させる口(registry の無い盤面では無い)。 */
export interface RenameAgentTiersInput {
  from: Tier;
  to: Tier;
  message: string;
}
export type RenameAgentTiers = (input: RenameAgentTiersInput) => Promise<void>;

/** 扉(settings タブ / 管理MCP)が撃つ1つの変更。段の改名だけは、agent.md の `tier` が名前で書かれているので、先に registry へ
 *  書き換えを着地させてから盤面の名前を変える(ADR 0200 決定2)。push は DB transaction の外なので、着地できなければ改名ごと
 *  拒む(ADR 0150 決定5 と同じ扉)。書き換えの前に名前を検査する —— 拒む改名で registry を動かさない。
 *  ponytail: 着地と transaction の間に別の変更が名前を取ると、registry だけ新しい名前になる。扉が増えて競合が見えたら直す。 */
export async function changeExecutionSettings(
  db: Db,
  change: ExecutionSettingsChange,
  origin: EventOrigin,
  at: Date,
  renameAgentTiers?: RenameAgentTiers,
  listAgents?: ListAgentTiers,
): Promise<void> {
  if (change.setting === "rename_tier") {
    assertKnownTier(db, "tier", change.name);
    assertTierName(db, change.to);
    try {
      await renameAgentTiers?.({ from: change.name, to: change.to, message: `rename tier ${change.name} to ${change.to}` });
    } catch (err) {
      if (err instanceof RegistryPushFailedError || err instanceof RegistryFetchFailedError) throw new DomainError(err.message);
      throw err;
    }
  }
  applyExecutionSettingsChange(db, change, origin, at, undefined, listAgents);
}

/** 行の Quarantine の解除の門1(ADR 0184 決定5): その (provider, model) の行が表から無くなった Quarantine の question を、
 *  回答なしで盤面名義に決着させる。誰も判断していないので decision log には載せない(CONTEXT.md「Decision log」)。 */
function settleRemovedRowQuarantines(db: Db, at: Date, observedEventId: number): void {
  const rows = new Set(loadExecutionSettingTable(db).map((row) => tableRowValue(row.provider, row.model)));
  for (const [value, id] of openQuarantineQuestions(db, "tableRow")) {
    if (rows.has(value!)) continue;
    settleQuestionAsObserved(db, id, { kind: "quarantine_released", quarantine: "tableRow", value, observed_event_id: observedEventId }, at);
  }
}

/** registry の agent 一覧を読む口(registry の無い盤面では無い)。registry の提案の (agent, tier) の照合と、段の削除の照合(`tierDeletionBlockers`)が読む。 */
export type ListAgentTiers = () => readonly { name: string; tier?: string }[];

/** 陳腐化の決着(ADR 0150 決定1): open な routing / registry の提案の pin を表・フラグの現在値と照合し、崩れた question を
 *  observed で決着させる。表の書き口は書いた event を `observedEventId` に渡す。`listAgents` を渡せば registry の提案の
 *  (agent, tier) も照合する —— routing の due 判定の直前(issue #920)で、registry の変更は盤面の event ではないので
 *  observed_event_id は null。 */
export function settleStaleProposals(db: Db, at: Date, observedEventId: number | null, listAgents?: ListAgentTiers): void {
  const settings = { ...readExecutionSettings(db), tiers: liveTierRows(db) };
  // registry を読むのは registry の提案が open なときだけ(poll ごとに registry を読まない)。読めなければこの回は照合しない
  // —— due 判定は scheduler の poll の中なので、registry が読めないことで pickup を止めない
  let agents: readonly { name: string; tier?: string }[] | null | undefined;
  const readAgents = (list: ListAgentTiers) => {
    try {
      return list();
    } catch (err) {
      console.warn(`[execution-setting] registry pins not checked: ${String(err)}`);
      return null;
    }
  };
  const open = db
    .prepare("SELECT id, question_proposal FROM tasks WHERE status = 'todo' AND json_extract(question_proposal, '$.kind') IN ('routing', 'registry')")
    .all() as Array<{ id: string; question_proposal: string }>;
  for (const { id, question_proposal } of open) {
    const proposal = JSON.parse(question_proposal) as RoutingProposal | RegistryProposal;
    let changed: ReturnType<typeof routingPinChanges> | ReturnType<typeof registryPinChanges>;
    if (proposal.kind === "registry" && listAgents) {
      agents = agents === undefined ? readAgents(listAgents) : agents;
      if (agents === null) continue;
      changed = registryPinChanges(proposal, agents.find((agent) => agent.name === proposal.agent), settings.tiers);
    } else {
      changed = routingPinChanges(proposal, settings);
    }
    if (changed?.length === 0) continue;
    settleQuestionAsObserved(db, id, { kind: "routing_proposal_stale", question_id: id, proposal_kind: proposal.kind, changed, observed_event_id: observedEventId }, at);
  }
}

function loadExecutionDefaults(db: Db): ExecutionDefaults {
  const row = db
    .prepare(
      `SELECT advisor_ceiling, provider_rank, priority, review_priority, learner_promoted, d.name AS default_tier, j.name AS judgement_tier
       FROM execution_defaults JOIN tiers d ON d.id = default_tier_id JOIN tiers j ON j.id = judgement_tier_id`,
    )
    .get() as {
    advisor_ceiling: AdvisorCeiling;
    provider_rank: string | null;
    priority: Priority | null;
    review_priority: Priority;
    learner_promoted: number;
    default_tier: Tier;
    judgement_tier: Tier;
  };
  return {
    advisorCeiling: row.advisor_ceiling,
    providerRank: row.provider_rank ? (JSON.parse(row.provider_rank) as Provider[]) : PROVIDER_VALUES,
    priority: row.priority ?? BOARD_DEFAULT_PRIORITY,
    reviewPriority: row.review_priority,
    learnerPromoted: row.learner_promoted === 1,
    defaultTier: row.default_tier,
    judgementTier: row.judgement_tier,
  };
}

/** selector が読む task の断面(要求の列と、review か否か)。 */
type SelectorTask = Pick<Task, "type" | "tier" | "priority" | "review_tier">;

/** 盤面境界の1行: この agent の定義から selector の入力を組む。Claude / Codex 両
 *  アダプタと、pickup の除外判定・queue の skipped 表示が**同じこの1本**を通る ——
 *  「その agent は何のモデルで走るのか」の答えが2つあってはならない(モデル窓の
 *  除外は、答えがずれた瞬間に全テスト緑のまま黙って効かなくなる面である)。
 *
 *  Provider 順位・優先順位の既定・advisor の上限は盤面設定(`execution_defaults`、
 *  settings タブと管理MCP が書く —— ADR 0110 決定5)。pickup ごとに読み直すので、
 *  書いた値は次の pickup / skipped 表示から効く。
 *
 *  `provider` / `tier` の文字列が列挙・盤面の段の一覧に収まっていることは、定義を受け入れる門
 *  (`assertValidAgentDefinition`)が既に保証している。 */
function selectorInputFor(
  db: Db,
  definition: Pick<AgentDefinition, "provider" | "tier">,
  task: SelectorTask | undefined,
): SelectorInput {
  const defaults = loadExecutionDefaults(db);
  return {
    entries: definition.provider.map((entry) => ({
      provider: entry.name as Provider,
      advisor: entry.advisor,
    })),
    providerRank: defaults.providerRank,
    taskTier: task?.type === "review" ? undefined : task?.tier ?? undefined,
    priority: task?.type === "review" ? defaults.reviewPriority : task?.priority ?? defaults.priority,
    reviewTier: task?.type === "review" ? task.review_tier ?? undefined : undefined,
    agentTier: definition.tier,
    boardTier: defaults.defaultTier,
    tiers: liveTierRows(db),
    advisorCeiling: defaults.advisorCeiling,
  };
}

/** この agent の候補を Provider 順位で並べる(除外は当てない)。pickup の除外判定と
 *  queue の skipped 表示が、観測で育つ除外集合に対して selector を引き直すための口。 */
export function executionSettingsFor(
  db: Db,
  definition: Pick<AgentDefinition, "provider" | "tier">,
  task: SelectorTask | undefined,
): ExecutionSetting[] {
  return executionSettingCandidates(selectorInputFor(db, definition, task), runnableTable(db));
}

/** 表から、行の Quarantine(行の拒否、ADR 0184 決定2)が開いている行を外したもの。「この行で走れるか」の
 *  読み手(main の候補・Board call の行・下げ先の門)はこの1本を通り、生の表は「表にあるか」の読み手だけが読む
 *  (ADR 0184 追記)。advisor は行でないのでこれを読まない(ADR 0200 決定6)。照合は (provider, model) の
 *  完全一致で、effort 違いの行もまとめて外れる(ADR 0200 決定5)—— Throttle の窓の部分一致(`windowMatchesModel`)は使わない(ADR 0182 決定3 と同じ理由)。 */
function runnableTable(db: Db): ExecutionSettingTable {
  const refused = new Set(openQuarantineValues(db, "tableRow"));
  return loadExecutionSettingTable(db).filter((row) => !refused.has(tableRowValue(row.provider, row.model)));
}

/** 除外を当てずに1つ選ぶ —— Provider 順位の先頭 entry の設定である。除外を当てた
 *  選択は pickup の側にあり、そちらは育った除外集合を `selectable` へ渡す。 */
export function resolveExecutionSetting(
  db: Db,
  definition: Pick<AgentDefinition, "provider" | "tier">,
  task: SelectorTask | undefined,
): ExecutionSetting | null {
  return selectExecutionSetting(selectorInputFor(db, definition, task), runnableTable(db));
}
