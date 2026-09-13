import { z } from "zod";
import type { Db } from "./db.js";
import { appendEvent, type EventOrigin } from "./events.js";
import { PROVIDER_VALUES, type Provider } from "./provider.js";
import type { AgentDefinition } from "./registry.js";
import { HUMAN_WORKER_ID, type Task } from "./tasks.js";

/** 必要品質のティア(CONTEXT.md「要求」)—— 廉価 / 主力 / 上位。**順序を持つ配列**
 *  であることがこの定数の内容で、advisor の pairing はこの並びの添字だけで判定する
 *  (ADR 0042 は生きている —— 盤面が順序を主張してよいのは自分の表のティア行に
 *  対してだけで、alias が実際にどのモデルへ解決されるかは今も judge しない)。 */
export const TIERS = ["economy", "standard", "frontier"] as const;
export type Tier = (typeof TIERS)[number];

/** 要求のもう1列: 要求ティアの候補を並べる鍵(CONTEXT.md「要求」/ ADR 0114 決定1)。
 *  `quality` = Provider 順位 → 価格、`cost` = 価格 → Provider 順位。ティアは床
 *  なので、どちらも床を下回る許可ではない。`speed` は落とした —— 締め切りは
 *  ティアの申告で表し、所要時間は学習器の outcome として観測される。 */
export const PRIORITIES = ["quality", "cost"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 要求2列を受け取る入口(管理MCP の `register_task`、worker MCP の `decompose`)が
 *  エージェントへ見せる説明。**綴りは1つ** —— 入口ごとに書くと、片方だけが古い
 *  ティア名や古い意味を喋り続ける。 */
export const TIER_FIELD_DESCRIPTION =
  `Required quality tier for this task: ${TIERS.join(" / ")}. ` +
  "Omit to fall back to the agent's own tier, then the board default.";
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
 *  cost で価格が Provider を決めた。 */
export type ProviderSource = "only" | "rank" | "cost";

/** task にも agent にも要求が無いときのティア。**配布される既定は最小の床**で
 *  あり、上げるのは運用者の判断である(ADR 0094 の advisor と同じ線 ——「既定は
 *  最小の床と、運用者が足せる余地を提供するもの」)。`/implementation-delegation`
 *  §1 の「既定は主力ティア」は別の軸 —— 人間が tidepool の実装 issue を委任する
 *  ときの好みであって、盤面が全 workspace の全 agent に配る床の根拠ではない。
 *  この値のおかげで、ADR 0110 が動かしたのは fallback の**出所**(adapter 定数 →
 *  盤面の表)であって model そのものではない、という決定文どおりになる。
 *  **盤面設定ではない**(#545 は Provider 順位と優先順位の既定を設定面に出したが、
 *  ティアの既定は出していない)—— 動かす口が無い値を DB に置いても、定数に手順が
 *  1つ増えるだけである。 */
export const BOARD_DEFAULT_TIER: Tier = "economy";

/** 優先順位の既定の、さらに既定(ADR 0114 決定1): 盤面設定 `execution_defaults.priority`
 *  が未設定のときの値。task の優先順位 → 盤面設定 → この定数の順に倒れる
 *  (`selectorInputFor` / `loadExecutionDefaults`)。 */
export const BOARD_DEFAULT_PRIORITY: Priority = "quality";

/** 表の1行 = モデル分類の行(ADR 0114 決定2): この model はこの provider のこの
 *  ティアの品質を満たす、という分類と、そこで使う effort・価格(USD per MTok)。
 *  同じ (provider, tier) に複数行あってよい。「alias か具体 id か」の判別子は
 *  **持たない** —— どちらも CLI に渡す文字列であることに変わりはなく、区別が要る
 *  場面が盤面には無い。 */
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

/** 配布される種の表。`/implementation-delegation` §4 / §5 の表と**同じ内容・同じ
 *  鮮度管理**で、ズレたら片方を直す(ADR 0110 / spec #541)。
 *
 *  anthropic は alias 行 —— `sonnet` / `opus` / `fable` は CLI の更新で世代が
 *  前進するので手入れが要らない。openai は具体 id 行 —— 2026-09-10 の実測で
 *  Codex の `-m` は `Astra` / `Sol` / `Terra` / `Luna` を alias として受けず
 *  (ChatGPT account では API が 400 を返し `turn.failed` で終わる)、世代交代の
 *  たびに手入れが要る。moonshot は kimi-k3 を economy に1行 —— 分類は価格帯では
 *  なく性能で行い(第三者の同一ハーネス測定はすべて Sonnet 5 / Terra の帯)、
 *  「moonshot に frontier 級は無い」は表の穴として正直に書く(ADR 0114 決定2)。
 *  effort が全行 `high` なのは、fallback の出所が adapter 定数から表へ移った結果
 *  として既定が `medium` から上がったということである。価格の根拠と出典は #556。 */
export const SEED_EXECUTION_SETTINGS: ExecutionSettingTable = [
  { provider: "anthropic", tier: "economy", model: "sonnet", effort: "high", price_in: 2, price_out: 10 },
  { provider: "anthropic", tier: "standard", model: "opus", effort: "high", price_in: 5, price_out: 25 },
  { provider: "anthropic", tier: "frontier", model: "fable", effort: "high", price_in: 10, price_out: 50 },
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
  /** `model` は表が返す綴り。`"fable"` のような alias 行は、解決された model 名の
   *  部分一致でも当たる(ADR 0030: CLI の `--model` は開かれた文字列で、世代が
   *  進めば `claude-fable-5` のような具体 id になる)。 */
  models: readonly { provider: Provider; model: string }[];
}

/** 何も除外されていない(今日の spawn 経路の既定)。 */
const NO_EXCLUSIONS: ExecutionExclusions = { providers: [], models: [] };

/** 観測された1つの窓が、この model に当たるか。**綴りはここ1つ**(issue #544):
 *  除外を当てる `firstSelectable` と、scheduler が「この設定に関係する窓」を絞る
 *  filter が別々の式を持つと、保存された観測を読む表示と同じ poll で観測し直す
 *  ゲートが、全テスト緑のまま非 fable の model 名でズレる。
 *
 *  部分一致を持つのは ADR 0030 の線 —— CLI の `--model` は開かれた文字列で、
 *  表の `fable` のような alias 行は世代が進めば `claude-fable-5` のような具体 id
 *  として観測される。 */
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
  /** Provider 順位(盤面設定 `execution_defaults.provider_rank`、未設定 = 資格情報の
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
  /** 盤面設定:「上位ティアの行を advisor に使ってよい」。立つまで advisor は
   *  main と同一に倒れる —— Fable の usage-credits 同意も org の `availableModels`
   *  も盤面からは読めず、不成立なら headless の CLI は exit せず advisor 無しで
   *  黙って起動する(2026-09-10 実測: stream-json は未 attach を通知しない)。 */
  frontierAdvisor: boolean;
}

/** advisor のティアが main 未満。headless の CLI はこの組み合わせを exit ではなく
 *  **advisor 無しの完走**で返すので(2026-09-10 実測: stderr に警告1行、stream-json
 *  には何も出ない)、盤面から見て成功セッションと区別が付かない。黙って advisor
 *  無しで走らせないために spawn 前に倒す。 */
export class AdvisorPairingError extends Error {
  constructor(mainTier: Tier, advisorTier: Tier) {
    super(
      `advisor tier ${advisorTier} cannot advise a ${mainTier} main model ` +
        "(the advisor must be at least as capable), so the session would run with no advisor at all (ADR 0110 決定3)",
    );
    this.name = "AdvisorPairingError";
  }
}

/** advisor のティアが main 以上であることの検査(ADR 0110 決定3)。**judge するのは
 *  ティアの水準だけ** —— model 文字列の意味は判定に入らない。ADR 0042 が却下した
 *  のは「盤面が知らない文字列(alias の解決先)を表で judge すること」であって、
 *  盤面が自分で組んだ表の行の順序を読むことではない。 */
export function assertAdvisorPairing(mainTier: Tier, advisorTier: Tier): void {
  if (TIERS.indexOf(advisorTier) < TIERS.indexOf(mainTier)) {
    throw new AdvisorPairingError(mainTier, advisorTier);
  }
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

/** Board call(ADR 0111 決定4)のように Provider / ティアが盤面設定の固定値で
 *  selector を通らない呼び手の口: 最安の行。行が無ければ「撃てなかった」として
 *  呼び手が畳む。 */
export function rowFor(table: ExecutionSettingTable, provider: Provider, tier: Tier): ExecutionSettingRow {
  const row = rowsFor(table, provider, tier)[0];
  if (!row) throw new Error(`the board's execution-setting table has no row for ${provider} / ${tier}`);
  return row;
}

/** entry 集合から要求ティアの行を全部集め、優先順位の鍵で並べる(ADR 0110 決定3 /
 *  ADR 0114 決定3・4)。**除外は当てない** —— 除外は観測のたびに育つので、盤面境界が
 *  候補を1度作り、除外が増えるたびに `firstSelectable` を引き直す形にしてある。
 *  要求ティアの行を持たない entry は候補に入らない(Throttle と同じ「除外」)。
 *
 *  advisor の model は agent.md には書かれない: 真のときだけ表から導出し、同
 *  Provider の frontier 行(複数なら最安、main が既に frontier ならその行そのもの)
 *  を採る。frontier 行が無ければその entry は除外 —— advisor 無しで黙って走らせない。
 *
 *  kill switch(ADR 0043)はここでは見ない —— 「この session に advisor は無い」
 *  という盤面ホストの運用マスクは registry の宣言とは別の層で、選んだ**後**に
 *  被せる(claude-worker.ts の launch)。 */
function executionSettingCandidates(
  request: SelectorInput,
  table: ExecutionSettingTable,
): ExecutionSetting[] {
  const tier = request.reviewTier ?? request.taskTier ?? request.agentTier ?? BOARD_DEFAULT_TIER;
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
  const advisorTier: Tier = request.frontierAdvisor ? "frontier" : tier;
  assertAdvisorPairing(tier, advisorTier);
  return request.entries
    .flatMap((entry) => {
      const frontier = entry.advisor ? rowsFor(table, entry.provider, advisorTier)[0]?.model : undefined;
      if (entry.advisor && frontier === undefined) return [];
      // advisor のティアが main と同じなら main の行そのもの —— 同ティアに複数行あっても別の行へ割れない
      return rowsFor(table, entry.provider, tier).map((main) => ({
        main,
        advisor: entry.advisor && advisorTier === tier ? main.model : frontier,
      }));
    })
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
    .prepare("SELECT provider, tier, model, effort, price_in, price_out FROM execution_settings")
    .all() as ExecutionSettingRow[];
}

/** 盤面設定の3値(ADR 0110 決定5): 「上位ティアの行を advisor に使ってよい」、
 *  Provider 順位、優先順位の既定。行が無い / 列が NULL = 未設定 = コードの既定
 *  —— display_language と同じ「行が無ければ既定」の形。 */
export interface ExecutionDefaults {
  frontierAdvisor: boolean;
  providerRank: readonly Provider[];
  priority: Priority;
}

/** settings タブ / 管理MCP の読み口(ADR 0110 決定5): 表と盤面設定3値を1往復で。
 *  表は (provider, model) 順 —— 主キーの順で、UI も MCP も同じ並びを見る。 */
export function readExecutionSettings(db: Db): ExecutionDefaults & { table: ExecutionSettingTable } {
  return {
    table: db
      .prepare("SELECT provider, tier, model, effort, price_in, price_out FROM execution_settings ORDER BY provider, model")
      .all() as ExecutionSettingRow[],
    ...loadExecutionDefaults(db),
  };
}

/** Provider 順位として書けるのは `PROVIDER_VALUES` の**順列**だけ —— 欠けた Provider は
 *  selector の `indexOf` が -1 になって先頭に並び、重複は順位を二重に言う。 */
export function isProviderRank(rank: readonly string[]): rank is Provider[] {
  return rank.length === PROVIDER_VALUES.length && PROVIDER_VALUES.every((provider) => rank.includes(provider));
}

/** settings タブ / 管理MCP が撃つ1つの変更(ADR 0110 決定5)。**綴りは1つ** —— /api と
 *  MCP tool が同じ schema を通り、同じ関数が書き、同じ payload が操作イベントになる。
 *  行の鍵は主キー (provider, model): `row` は upsert、`row_deleted` は削除で、model 名の
 *  変更は「消して足す」。 */
export const executionSettingsChangeSchema = z.discriminatedUnion("setting", [
  z.object({
    setting: z.literal("row"),
    row: z.object({
      provider: z.enum(PROVIDER_VALUES),
      tier: z.enum(TIERS),
      model: z.string().min(1),
      effort: z.string().min(1),
      price_in: z.number().nonnegative(),
      price_out: z.number().nonnegative(),
    }),
  }),
  z.object({ setting: z.literal("row_deleted"), provider: z.enum(PROVIDER_VALUES), model: z.string().min(1) }),
  z.object({ setting: z.literal("frontier_advisor"), value: z.boolean() }),
  z.object({
    setting: z.literal("provider_rank"),
    value: z.array(z.enum(PROVIDER_VALUES)).refine(isProviderRank, {
      message: `provider rank must list every provider exactly once (${PROVIDER_VALUES.join(" / ")})`,
    }),
  }),
  z.object({ setting: z.literal("priority"), value: z.enum(PRIORITIES) }),
]);
export type ExecutionSettingsChange = z.infer<typeof executionSettingsChangeSchema>;

/** 変更を書き、操作イベントとして経路つきで残す(CONTEXT.md「管理MCP」)。task を
 *  持たない盤面イベントなので task_id は NULL、帰属は人間。 */
export function applyExecutionSettingsChange(db: Db, change: ExecutionSettingsChange, origin: EventOrigin, at: Date): void {
  db.transaction(() => {
    switch (change.setting) {
      case "row": {
        const { provider, tier, model, effort, price_in, price_out } = change.row;
        db.prepare(
          `INSERT INTO execution_settings (provider, tier, model, effort, price_in, price_out) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, model) DO UPDATE SET tier = excluded.tier, effort = excluded.effort,
             price_in = excluded.price_in, price_out = excluded.price_out`,
        ).run(provider, tier, model, effort, price_in, price_out);
        break;
      }
      case "row_deleted":
        db.prepare("DELETE FROM execution_settings WHERE provider = ? AND model = ?").run(change.provider, change.model);
        break;
      default: {
        const column = change.setting;
        const value =
          change.setting === "frontier_advisor" ? Number(change.value)
          : change.setting === "provider_rank" ? JSON.stringify(change.value) : change.value;
        db.prepare(
          `INSERT INTO execution_defaults (id, ${column}) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET ${column} = excluded.${column}`,
        ).run(value);
      }
    }
    appendEvent(db, {
      taskId: null,
      workerId: HUMAN_WORKER_ID,
      origin,
      payload: { kind: "execution_settings_changed", ...change },
      at,
    });
  })();
}

export function loadExecutionDefaults(db: Db): ExecutionDefaults {
  const row = db
    .prepare("SELECT frontier_advisor, provider_rank, priority FROM execution_defaults WHERE id = 1")
    .get() as { frontier_advisor: number; provider_rank: string | null; priority: Priority | null } | undefined;
  return {
    frontierAdvisor: row?.frontier_advisor === 1,
    providerRank: row?.provider_rank ? (JSON.parse(row.provider_rank) as Provider[]) : PROVIDER_VALUES,
    priority: row?.priority ?? BOARD_DEFAULT_PRIORITY,
  };
}

/** selector が読む task の断面(要求の列と、review か否か)。 */
type SelectorTask = Pick<Task, "type" | "tier" | "priority" | "review_tier">;

/** 盤面境界の1行: この agent の定義から selector の入力を組む。Claude / Codex 両
 *  アダプタと、pickup の除外判定・queue の skipped 表示が**同じこの1本**を通る ——
 *  「その agent は何のモデルで走るのか」の答えが2つあってはならない(モデル窓の
 *  除外は、答えがずれた瞬間に全テスト緑のまま黙って効かなくなる面である)。
 *
 *  Provider 順位・優先順位の既定・frontier advisor は盤面設定(`execution_defaults`、
 *  settings タブと管理MCP が書く —— ADR 0110 決定5)。pickup ごとに読み直すので、
 *  書いた値は次の pickup / skipped 表示から効く。
 *
 *  `provider` / `tier` の文字列が列挙に収まっていることは、定義を受け入れる門
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
    agentTier: definition.tier as Tier | undefined,
    frontierAdvisor: defaults.frontierAdvisor,
  };
}

/** この agent の候補を Provider 順位で並べる(除外は当てない)。pickup の除外判定と
 *  queue の skipped 表示が、観測で育つ除外集合に対して selector を引き直すための口。 */
export function executionSettingsFor(
  db: Db,
  definition: Pick<AgentDefinition, "provider" | "tier">,
  task: SelectorTask | undefined,
): ExecutionSetting[] {
  return executionSettingCandidates(
    selectorInputFor(db, definition, task),
    loadExecutionSettingTable(db),
  );
}

/** 盤面境界の選択そのもの: 除外を当てずに1つ選ぶ —— spawn 側にとっての「今日の
 *  挙動」= Provider 順位の先頭 entry の設定である。除外を当てた選択は pickup の
 *  側にあり、そちらは育った除外集合を `firstSelectable` へ渡す。 */
export function resolveExecutionSetting(
  db: Db,
  definition: Pick<AgentDefinition, "provider" | "tier">,
  task: SelectorTask | undefined,
): ExecutionSetting | null {
  return selectExecutionSetting(
    selectorInputFor(db, definition, task),
    loadExecutionSettingTable(db),
  );
}
