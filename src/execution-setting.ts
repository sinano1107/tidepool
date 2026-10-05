import { z } from "zod";
import { claudeAdvisorFor, isClaudeModelAlias } from "./claude-model-alias.js";
import type { Db } from "./db.js";
import { appendEvent, type EventOrigin } from "./events.js";
import { PROVIDER_VALUES, type Provider } from "./provider.js";
import { openQuarantineQuestions, openQuarantineValues, tableRowValue } from "./quarantine.js";
import type { AgentDefinition } from "./registry.js";
import { DomainError, HUMAN_WORKER_ID, type RegistryProposal, type RoutingProposal, type RoutingRowProposal, settleQuestionAsObserved, type Task } from "./tasks.js";

/** 必要品質のティア(CONTEXT.md「要求」/ ADR 0200 決定1)の名前。段は盤面の DB が持つ順序付きの一覧で(`readTiers`)、
 *  コードは名前を列挙しない —— 型が言えるのは「段の名前」であることだけ。 */
export type Tier = string;

/** 要求のもう1列: 要求ティアの候補を並べる鍵(CONTEXT.md「要求」/ ADR 0114 決定1)。
 *  `quality` = Provider 順位 → 価格、`cost` = 価格 → Provider 順位。ティアは床
 *  なので、どちらも床を下回る許可ではない。`speed` は落とした —— 締め切りは
 *  ティアの申告で表し、所要時間は学習器の outcome として観測される。 */
export const PRIORITIES = ["quality", "cost"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 要求2列を受け取る入口(管理MCP の `register_task` / `decompose_task`、worker MCP の `decompose`)が
 *  エージェントへ見せる説明。**綴りは1つ** —— 入口ごとに書くと、片方だけが古い段や古い意味を喋り続ける。
 *  段は盤面の一覧から「名前 — 説明」を順序どおりに並べる(ADR 0200 決定3)。 */
export function tierFieldDescriptions(db: Db): { tier: string; review_tier: string } {
  const tiers = readTiers(db).map((t) => `${t.name} — ${t.description}`).join("\n");
  return {
    tier: `Required quality tier for this task, one of the board's tiers (lowest first):\n${tiers}\n` +
      "Omit to fall back to the agent's own tier, then the board default.",
    review_tier: `Quality tier for completion reviews, one of the board's tiers (lowest first):\n${tiers}\n` +
      "Overrides each reviewer's tier, then the board default.",
  };
}
export const PRIORITY_FIELD_DESCRIPTION =
  `How the models of the required tier are ordered: ${PRIORITIES.join(" / ")}. ` +
  "quality (default) picks by the board's Provider rank, then price; cost picks the cheapest model, then Provider rank.";

/** 解決されたティアが**誰の要求だったか**(ADR 0110 決定3)。events 側の
 *  `worker_spawned.source` と同じ union を2箇所に書くと必ず片方だけ動くので、
 *  綴りはここ1つにして events.ts は型として取り込む。 */
export type TierSource = "task" | "review_tier" | "agent" | "board";

/** 選ばれた Provider が**なぜその Provider だったか**(ADR 0110 決定3 / 決定5、
 *  ADR 0114 決定4)。`"only"` は agent が entry を1つしか宣言していなかった、
 *  `"rank"` は残った候補から Provider 順位で選んだ、`"cost"` は task の優先順位が
 *  cost で価格が Provider を決めた、`"learner"` は昇格した学習器が選んだ(ADR 0150 決定3)。 */
export type ProviderSource = "only" | "rank" | "cost" | "learner";

/** 優先順位の既定の、さらに既定(ADR 0114 決定1): 盤面設定 `execution_defaults.priority`
 *  が未設定のときの値。task の優先順位 → 盤面設定 → この定数の順に倒れる
 *  (`selectorInputFor` / `loadExecutionDefaults`)。 */
export const BOARD_DEFAULT_PRIORITY: Priority = "quality";

/** 表の1行 = モデル分類の行(ADR 0114 決定2): この model はこの provider のこの
 *  ティアの品質を満たす、という分類と、そこで使う effort・価格(USD per MTok)。
 *  同じ (provider, tier) に複数行あってよい。model は具体 id だけ —— 行を書く扉
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

/** 配布される種の段(ADR 0200 決定1・3)。表と同じく DB へ一度だけ初期化し、以後は DB が正本。説明は「1つ下の段では
 *  足りず、この段なら足りる仕事」を書く(文面は #1346 のコメント)。並びが段の順序である。 */
export const SEED_TIERS: readonly { name: string; description: string }[] = [
  { name: "economy", description: "Work that follows a pattern already in the codebase: adding tests, routine wiring, mechanical edits." },
  { name: "standard", description: "Work where the approach has to be worked out: a multi-file implementation or a larger refactor." },
  { name: "frontier", description: "A hard problem that has already resisted an attempt, or long autonomous work where a wrong call is expensive." },
];

/** 種の盤面設定が指す段(ADR 0200 決定4): 盤面既定(未指定の task と下書き)と、盤面自身の判断の段(振り返り Board call と
 *  周期 meta-review)。配布される既定は最小の床で、上げるのは運用者の判断である(ADR 0094 の線)。 */
export const SEED_BOARD_TIERS = { default_tier: "economy", retrospective_tier: "frontier" } as const;

/** 盤面の段の一覧を順序どおりに(ADR 0200 決定1)。 */
export function readTiers(db: Db): { name: Tier; description: string }[] {
  return db.prepare("SELECT name, description FROM tiers ORDER BY position").all() as { name: Tier; description: string }[];
}

/** 段の名前を順序どおりに。 */
export function tierNames(db: Db): Tier[] {
  return readTiers(db).map((tier) => tier.name);
}

/** 名前で喋る入口の検査(ADR 0200 決定2): 一覧に無い名前は、いまの一覧を添えて拒む。 */
export function assertKnownTier(db: Db, field: string, name: string): void {
  const names = tierNames(db);
  if (!names.includes(name)) throw new DomainError(`unknown ${field} "${name}" — one of ${names.join(", ")}`);
}

/** 盤面既定の段(ADR 0200 決定4): 要求が無い task と下書きが読む。 */
export function boardDefaultTier(db: Db): Tier {
  return (db.prepare("SELECT t.name FROM execution_defaults d JOIN tiers t ON t.id = d.default_tier_id").get() as { name: Tier }).name;
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
  /** ADR 0110 決定3: 選んだ値だけでなく**なぜその値になったか**を刻む。今は
   *  ティアの出所1つ —— `"task"` は task の要求列、`"agent"` は agent.md の
   *  `tier`、`"review_tier"` はレビュー専用の要求、`"board"` は盤面既定。未指定(列が null)と「既定を選んだ」が
   *  記録上区別されるのはこの1値による。 */
  source: { tier: TierSource; provider: ProviderSource };
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
   *  あること(`isProviderRank`)は書く口が保証する —— 欠けた Provider は
   *  `indexOf` が -1 になって**先頭**に並んでしまう。 */
  providerRank: readonly Provider[];
  /** task の要求ティア(CONTEXT.md「要求」)。省略 → agent の `tier`。 */
  taskTier: Tier | undefined;
  /** task の優先順位(CONTEXT.md「要求」/ ADR 0114 決定1)。省略 → 盤面既定
   *  (`selectorInputFor` が盤面設定の値を埋める。selector 自身の倒れ先
   *  `BOARD_DEFAULT_PRIORITY` は、それを通らない呼び手のためだけにある)。
   *  review の要求(`reviewTier`)があれば読まない —— review task に優先順位の列は
   *  無く、`quality` の並べ方で解決する(ADR 0111 決定3)。 */
  priority: Priority | undefined;
  /** ADR 0111: review tasks use this request instead of the work tier. */
  reviewTier?: Tier;
  /** agent.md の `tier`。省略 → 盤面既定。 */
  agentTier: Tier | undefined;
  /** 盤面既定の段(盤面設定、ADR 0200 決定4)。 */
  boardTier: Tier;
  /** 盤面設定:「main より序列が上の model を advisor に使ってよい」。立つまで advisor は
   *  main と同一に倒れる —— Fable の usage-credits 同意も org の `availableModels`
   *  も盤面からは読めず、不成立なら headless の CLI は exit せず advisor 無しで
   *  黙って起動する(2026-09-10 実測: stream-json は未 attach を通知しない)。 */
  advisorAboveMain: boolean;
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
 *  anthropic 固定、ティアは呼び手が決め、その最安の行(ADR 0192)。呼び出しごとに読むので書き換えは
 *  次の呼び出しから効く。行が無ければ投げ、呼び手が「撃てなかった」に畳む。 */
export function anthropicBoardCallRow(db: Db, tier: Tier): ExecutionSettingRow {
  const row = rowsFor(loadExecutionSettingTable(db), "anthropic", tier)[0];
  if (!row) throw new Error(`the board's execution-setting table has no row for anthropic / ${tier}`);
  return row;
}

/** 振り返り Board call(配分評価・帰責の判定・Behavior candidate の起草)の行。ティアは3用途が
 *  共有する盤面設定(ADR 0111 追記4)。 */
export function retrospectiveBoardCallRow(db: Db): ExecutionSettingRow {
  return anthropicBoardCallRow(db, loadExecutionDefaults(db).retrospectiveTier);
}

/** entry 集合から要求ティアの行を全部集め、優先順位の鍵で並べる(ADR 0110 決定3 /
 *  ADR 0114 決定3・4)。**除外は当てない** —— 除外は観測のたびに育つので、盤面境界が
 *  候補を1度作り、除外が増えるたびに `selectable` を引き直す形にしてある。
 *  要求ティアの行を持たない entry は候補に入らない(Throttle と同じ「除外」)。
 *
 *  advisor の model は agent.md には書かれない: 真のときだけ main の行から導出する
 *  (`claudeAdvisorFor`、ADR 0200 決定6 —— 表もティアも読まない)。advisor を宣言
 *  できるのは anthropic の entry だけで(ADR 0097)、adapter が系列を知らない行は
 *  advisor つきの entry の候補にしない —— advisor 無しで黙って走らせない。
 *
 *  kill switch(ADR 0043)はここでは見ない —— 「この session に advisor は無い」
 *  という盤面ホストの運用マスクは registry の宣言とは別の層で、選んだ**後**に
 *  被せる(claude-worker.ts の launch)。 */
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
  const priority: Priority =
    request.reviewTier !== undefined ? "quality" : request.priority ?? BOARD_DEFAULT_PRIORITY;
  const providerSource: ProviderSource =
    request.entries.length === 1 ? "only" : priority === "cost" ? "cost" : "rank";
  const byRank = (a: ExecutionSettingRow, b: ExecutionSettingRow) =>
    request.providerRank.indexOf(a.provider) - request.providerRank.indexOf(b.provider);
  return request.entries
    .flatMap((entry) =>
      rowsFor(table, entry.provider, tier).flatMap((main) => {
        const advisor = entry.advisor ? claudeAdvisorFor(main.model, request.advisorAboveMain) : undefined;
        return entry.advisor && advisor === undefined ? [] : [{ main, advisor }];
      }),
    )
    .sort((a, b) =>
      priority === "cost" ? byPrice(a.main, b.main) || byRank(a.main, b.main) : byRank(a.main, b.main) || byPrice(a.main, b.main),
    )
    .map(({ main, advisor }) => ({
      provider: main.provider,
      model: main.model,
      effort: main.effort,
      advisor,
      source: { tier: tierSource, provider: providerSource },
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
      !excluded.models.some(
        (window) =>
          window.provider === candidate.provider && windowMatchesModel(window.model, candidate.model),
      ),
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
       FROM execution_settings JOIN tiers t ON t.id = execution_settings.tier_id ORDER BY provider, model`,
    )
    .all() as ExecutionSettingRow[];
}

/** 盤面設定(ADR 0110 決定5): 「main より序列が上の model を advisor に使ってよい」、
 *  Provider 順位、優先順位の既定、学習器の昇格(ADR 0150 決定4)、盤面自身の判断の段(振り返り Board call と
 *  周期 meta-review が共有する、ADR 0200 決定4)。行は種で作られ、列が NULL = 未設定 = コードの既定。
 *  盤面既定の段(`boardDefaultTier`)はこの読み口に載せない —— 動かす口は #1421 が足す。 */
interface ExecutionDefaults {
  advisorAboveMain: boolean;
  providerRank: readonly Provider[];
  priority: Priority;
  learnerPromoted: boolean;
  retrospectiveTier: Tier;
}

/** settings タブ / 管理MCP の読み口(ADR 0110 決定5): 表と盤面設定4値を1往復で。
 *  表は (provider, model) 順 —— 主キーの順で、UI も MCP も同じ並びを見る。 */
export function readExecutionSettings(db: Db): ExecutionDefaults & { table: ExecutionSettingTable } {
  return { table: loadExecutionSettingTable(db), ...loadExecutionDefaults(db) };
}

/** 人間の2つの扉(settings タブ・管理MCP)の読み口: 各行に、開いている行の Quarantine の question id(無ければ null)を
 *  添える(ADR 0184 決定6)。meta-review の材料と worker の読み口は `readExecutionSettings` のまま。 */
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

/** Provider 順位として書けるのは `PROVIDER_VALUES` の**順列**だけ —— 欠けた Provider は
 *  selector の `indexOf` が -1 になって先頭に並び、重複は順位を二重に言う。 */
function isProviderRank(rank: readonly string[]): rank is Provider[] {
  return rank.length === PROVIDER_VALUES.length && PROVIDER_VALUES.every((provider) => rank.includes(provider));
}

/** settings タブ / 管理MCP が撃つ1つの変更(ADR 0110 決定5)。**綴りは1つ** —— /api と
 *  MCP tool が同じ schema を通り、同じ関数が書き、同じ payload が操作イベントになる。
 *  行の鍵は主キー (provider, model): `row` は upsert、`delete_row` は削除で、model 名の
 *  変更は「消して足す」。 */
export const executionSettingsChangeSchema = z.discriminatedUnion("setting", [
  z.object({
    setting: z.literal("row"),
    row: z.object({
      provider: z.enum(PROVIDER_VALUES),
      tier: z.string().min(1),
      model: z.string().min(1),
      effort: z.string().min(1),
      price_in: z.number().nonnegative(),
      price_out: z.number().nonnegative(),
    }),
  }),
  z.object({ setting: z.literal("delete_row"), provider: z.enum(PROVIDER_VALUES), model: z.string().min(1) }),
  z.object({ setting: z.literal("advisor_above_main"), value: z.boolean() }),
  z.object({
    setting: z.literal("provider_rank"),
    value: z.array(z.enum(PROVIDER_VALUES)).refine(isProviderRank, {
      message: `provider rank must list every provider exactly once (${PROVIDER_VALUES.join(" / ")})`,
    }),
  }),
  z.object({ setting: z.literal("priority"), value: z.enum(PRIORITIES) }),
  z.object({ setting: z.literal("retrospective_tier"), value: z.string().min(1) }),
  // 扉は降格だけを受ける。昇格は承認の適用が schema を通さず書く
  z.object({
    setting: z.literal("learner_promoted"),
    value: z.boolean().refine((value) => !value, {
      message: "the learner is promoted only by approving a routing meta-review's proposal question (ADR 0150 決定4); this door only demotes",
    }),
  }),
]);
export type ExecutionSettingsChange = z.infer<typeof executionSettingsChangeSchema>;

/** 行の提案の変更と、承認に添える修正値の形(ADR 0150 決定2): 動かせるのは分類と effort だけ。 */
const routingRowChangeSchema = z
  .object({ tier: z.string().min(1), effort: z.string().min(1) })
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
 *  行が消えていれば null。昇格 / 降格の提案の pin はフラグの現在値。tier の提案は根拠の行を (provider, model) の tier / effort で
 *  比べる(消えた行も `rows` —— agent の側の pin は表からは見えないので `registryPinChanges` が言う)。 */
export function routingPinChanges(
  proposal: RoutingProposal | RegistryProposal,
  settings: { table: ExecutionSettingTable; learnerPromoted: boolean },
): Array<"tier" | "effort" | "price_in" | "price_out" | "learner_promoted" | "rows"> | null {
  if (proposal.kind === "registry") {
    const held = proposal.pin.rows.every((pinned) =>
      settings.table.some((row) => row.provider === pinned.provider && row.model === pinned.model && row.tier === pinned.tier && row.effort === pinned.effort),
    );
    return held ? [] : ["rows"];
  }
  if (proposal.op !== "row") return proposal.pin.promoted === settings.learnerPromoted ? [] : ["learner_promoted"];
  const { pin } = proposal;
  const current = settings.table.find((row) => row.provider === pin.provider && row.model === pin.model);
  if (!current) return null;
  return (["tier", "effort", "price_in", "price_out"] as const).filter((field) => current[field] !== pin[field]);
}

/** 修正値の合成(ADR 0150 決定2): 適用する行 = pin の行に提案の変更、その上に人間の修正値を重ねたもの。 */
export function composeRoutingRow(proposal: RoutingRowProposal, amendment?: RoutingRowChange): ExecutionSettingRow {
  return { ...proposal.pin, ...proposal.change, ...amendment };
}

/** tier の提案の agent 側の pin(issue #920): registry の agent の tier が焼いた値のままか。agent が消えていても崩れている。 */
export function registryPinChanges(proposal: RegistryProposal, agent: { tier?: string } | undefined): Array<"agent_tier"> {
  return agent?.tier === proposal.pin.tier ? [] : ["agent_tier"];
}

/** 下げ先の検査(spec #916 B): 対象ティアに agent の entry のいずれかの行があるか。無ければ下げた agent は skipped になる。
 *  提案 verb と回答時(修正後の値)の両方が呼ぶ。 */
export function tierHasRowFor(table: ExecutionSettingTable, providers: readonly string[], tier: Tier): boolean {
  return table.some((row) => row.tier === tier && providers.includes(row.provider));
}

/** tier の提案の修正値の検査(ADR 0150 決定2): `to` だけで、pin の tier より下の任意のティア(段の順序は盤面の一覧)。 */
export function parseAgentTierAmendment(tiers: readonly Tier[], proposal: RegistryProposal, amendment: unknown): Tier {
  const parsed = z.object({ to: z.string() }).strict().safeParse(amendment);
  if (!parsed.success || !tiers.includes(parsed.data.to) || tiers.indexOf(parsed.data.to) >= tiers.indexOf(proposal.pin.tier)) {
    throw new DomainError(`an agent tier amendment takes only to, a tier below ${proposal.pin.tier}`);
  }
  return parsed.data.to;
}

/** 変更を書き、操作イベントとして経路つきで残す(CONTEXT.md「管理MCP」)。task を
 *  持たない盤面イベントなので task_id は NULL、帰属は人間。表を書くのはこの1本なので、routing の提案の陳腐化の hook
 *  (ADR 0150 決定1)もここに置く。`questionId` は提案 question への回答で適用したときの印で、meta-review の材料と「人間が変えた行」から外れる(ADR 0151)。
 *  返り値は execution_settings_changed の event id(何も変わらなければ null)。 */
export function applyExecutionSettingsChange(db: Db, change: ExecutionSettingsChange, origin: EventOrigin, at: Date, questionId?: string): number | null {
  return db.transaction(() => {
    switch (change.setting) {
      case "row": {
        const { provider, tier, model, effort, price_in, price_out } = change.row;
        if (provider === "anthropic" && isClaudeModelAlias(model)) {
          throw new DomainError(`"${model}" is a Claude CLI alias whose target moves with CLI updates; a table row takes a concrete model id (e.g. claude-opus-5-5)`);
        }
        assertKnownTier(db, "tier", tier);
        db.prepare(
          `INSERT INTO execution_settings (provider, tier_id, model, effort, price_in, price_out)
           VALUES (?, (SELECT id FROM tiers WHERE name = ?), ?, ?, ?, ?)
           ON CONFLICT(provider, model) DO UPDATE SET tier_id = excluded.tier_id, effort = excluded.effort,
             price_in = excluded.price_in, price_out = excluded.price_out`,
        ).run(provider, tier, model, effort, price_in, price_out);
        break;
      }
      case "retrospective_tier":
        assertKnownTier(db, "retrospective_tier", change.value);
        db.prepare("UPDATE execution_defaults SET retrospective_tier_id = (SELECT id FROM tiers WHERE name = ?)").run(change.value);
        break;
      case "delete_row":
        // 消す行が無ければ何も変わっていないので、操作イベントも残さない
        if (db.prepare("DELETE FROM execution_settings WHERE provider = ? AND model = ?").run(change.provider, change.model).changes === 0) return null;
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

/** 行の Quarantine の解除の門1(ADR 0184 決定5): その (provider, model) の行が表から無くなった Quarantine の question を、
 *  回答なしで盤面名義に決着させる。誰も判断していないので decision log には載せない(CONTEXT.md「Decision log」)。 */
function settleRemovedRowQuarantines(db: Db, at: Date, observedEventId: number): void {
  const rows = new Set(loadExecutionSettingTable(db).map((row) => tableRowValue(row.provider, row.model)));
  for (const [value, id] of openQuarantineQuestions(db, "tableRow")) {
    if (rows.has(value!)) continue;
    settleQuestionAsObserved(db, id, { kind: "quarantine_released", quarantine: "tableRow", value, observed_event_id: observedEventId }, at);
  }
}

/** registry の agent 一覧を読む口(registry の無い盤面では無い)。registry の提案の (agent, tier) の照合が読む。 */
export type ListAgentTiers = () => readonly { name: string; tier?: string }[];

/** 陳腐化の決着(ADR 0150 決定1): open な routing / registry の提案の pin を表・フラグの現在値と照合し、崩れた question を
 *  observed で決着させる。表の書き口は書いた event を `observedEventId` に渡す。`listAgents` を渡せば registry の提案の
 *  (agent, tier) も照合する —— routing の due 判定の直前(issue #920)で、registry の変更は盤面の event ではないので
 *  observed_event_id は null。 */
export function settleStaleProposals(db: Db, at: Date, observedEventId: number | null, listAgents?: ListAgentTiers): void {
  const settings = readExecutionSettings(db);
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
      changed = registryPinChanges(proposal, agents.find((agent) => agent.name === proposal.agent));
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
      `SELECT advisor_above_main, provider_rank, priority, learner_promoted, t.name AS retrospective_tier
       FROM execution_defaults JOIN tiers t ON t.id = execution_defaults.retrospective_tier_id`,
    )
    .get() as { advisor_above_main: number; provider_rank: string | null; priority: Priority | null; learner_promoted: number; retrospective_tier: Tier };
  return {
    advisorAboveMain: row.advisor_above_main === 1,
    providerRank: row.provider_rank ? (JSON.parse(row.provider_rank) as Provider[]) : PROVIDER_VALUES,
    priority: row.priority ?? BOARD_DEFAULT_PRIORITY,
    learnerPromoted: row.learner_promoted === 1,
    retrospectiveTier: row.retrospective_tier,
  };
}

/** selector が読む task の断面(要求の列と、review か否か)。 */
type SelectorTask = Pick<Task, "type" | "tier" | "priority" | "review_tier">;

/** 盤面境界の1行: この agent の定義から selector の入力を組む。Claude / Codex 両
 *  アダプタと、pickup の除外判定・queue の skipped 表示が**同じこの1本**を通る ——
 *  「その agent は何のモデルで走るのか」の答えが2つあってはならない(モデル窓の
 *  除外は、答えがずれた瞬間に全テスト緑のまま黙って効かなくなる面である)。
 *
 *  Provider 順位・優先順位の既定・advisor above main は盤面設定(`execution_defaults`、
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
    priority: task?.priority ?? defaults.priority,
    reviewTier: task?.type === "review" ? task.review_tier ?? undefined : undefined,
    agentTier: definition.tier,
    boardTier: boardDefaultTier(db),
    advisorAboveMain: defaults.advisorAboveMain,
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

/** 表から、行の Quarantine(行の拒否、ADR 0184 決定2)が開いている行を外したもの。main の候補はこの1本から
 *  引くので、走れない行は main にならない。advisor は行でないのでこれを読まない(ADR 0200 決定6)。照合は (provider, model) の
 *  完全一致 —— Throttle の窓の部分一致(`windowMatchesModel`)は使わない(ADR 0182 決定3 と同じ理由)。 */
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
