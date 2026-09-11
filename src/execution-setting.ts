import type { Db } from "./db.js";
import type { AgentDefinition, Provider } from "./registry.js";

/** 必要品質のティア(CONTEXT.md「要求」)—— 廉価 / 主力 / 上位。**順序を持つ配列**
 *  であることがこの定数の内容で、advisor の pairing はこの並びの添字だけで判定する
 *  (ADR 0042 は生きている —— 盤面が順序を主張してよいのは自分の表のティア行に
 *  対してだけで、alias が実際にどのモデルへ解決されるかは今も judge しない)。 */
export const TIERS = ["economy", "standard", "frontier"] as const;
export type Tier = (typeof TIERS)[number];

/** 要求のもう1列: 同点候補の並べ替えの基準(CONTEXT.md「要求」)。**selector は
 *  今これを読まない** —— 単一 Provider の agent しか居ない間は候補が1つしか無く、
 *  通しても効かない値が1つ増えるだけである。列に入るところまでが #543 で、
 *  Provider 順位と候補集合が来る #544 が並べ替えの読み手になる。 */
export const PRIORITIES = ["quality", "cost", "speed"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 要求2列を受け取る入口(管理MCP の `register_task`、worker MCP の `decompose`)が
 *  エージェントへ見せる説明。**綴りは1つ** —— 入口ごとに書くと、片方だけが古い
 *  ティア名や古い意味を喋り続ける。`priority` の文面が「並べ替える」ではなく
 *  「記録される」なのは実態どおりで、selector は今この列を読まない(上記)——
 *  効きもしない設定をエージェントに書かせない。 */
export const TIER_FIELD_DESCRIPTION =
  `Required quality tier for this task: ${TIERS.join(" / ")}. ` +
  "Omit to fall back to the agent's own tier, then the board default.";
export const PRIORITY_FIELD_DESCRIPTION =
  `Recorded on this task: ${PRIORITIES.join(" / ")}. ` +
  "It orders tied candidates once more than one Provider can run the task; with a single Provider it has no effect yet.";

/** 解決されたティアが**誰の要求だったか**(ADR 0110 決定3)。events 側の
 *  `worker_spawned.source` と同じ union を2箇所に書くと必ず片方だけ動くので、
 *  綴りはここ1つにして events.ts は型として取り込む。 */
export type TierSource = "task" | "agent" | "board";

/** task にも agent にも要求が無いときのティア。**配布される既定は最小の床**で
 *  あり、上げるのは運用者の判断である(ADR 0094 の advisor と同じ線 ——「既定は
 *  最小の床と、運用者が足せる余地を提供するもの」)。`/implementation-delegation`
 *  §1 の「既定は主力ティア」は別の軸 —— 人間が tidepool の実装 issue を委任する
 *  ときの好みであって、盤面が全 workspace の全 agent に配る床の根拠ではない。
 *  この値のおかげで、ADR 0110 が動かしたのは fallback の**出所**(adapter 定数 →
 *  盤面の表)であって model そのものではない、という決定文どおりになる。
 *  #545 が設定面を開くまでは盤面設定に出さない —— 動かす口が無い値を DB に置いても、
 *  定数に手順が1つ増えるだけである。 */
export const BOARD_DEFAULT_TIER: Tier = "economy";

/** 表の1行: この provider のこのティアの現 champion と、そこで使う effort。
 *  「alias か具体 id か」の判別子は**持たない** —— どちらも CLI に渡す文字列で
 *  あることに変わりはなく、区別が要る場面が盤面には無い(anthropic は alias 行、
 *  openai は具体 id 行という実測の帰結は、値そのものに現れている)。 */
export interface ExecutionSettingRow {
  provider: Provider;
  tier: Tier;
  model: string;
  effort: string;
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
 *  たびに手入れが要る。moonshot は3ティアとも同じ model —— ティアの選択肢が
 *  無いからで、行を欠かすと既定ティアの解決が moonshot agent の spawn を全部
 *  倒す。effort が全行 `high` なのは、fallback の出所が adapter 定数から表へ
 *  移った結果として既定が `medium` から上がったということである。 */
export const SEED_EXECUTION_SETTINGS: ExecutionSettingTable = [
  { provider: "anthropic", tier: "economy", model: "sonnet", effort: "high" },
  { provider: "anthropic", tier: "standard", model: "opus", effort: "high" },
  { provider: "anthropic", tier: "frontier", model: "fable", effort: "high" },
  { provider: "moonshot", tier: "economy", model: MOONSHOT_DEFAULT_MODEL, effort: "high" },
  { provider: "moonshot", tier: "standard", model: MOONSHOT_DEFAULT_MODEL, effort: "high" },
  { provider: "moonshot", tier: "frontier", model: MOONSHOT_DEFAULT_MODEL, effort: "high" },
  { provider: "openai", tier: "economy", model: "gpt-5.6-terra", effort: "high" },
  { provider: "openai", tier: "standard", model: "gpt-5.6-sol", effort: "high" },
  { provider: "openai", tier: "frontier", model: "gpt-6-astra", effort: "high" },
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
   *  `tier`、`"board"` は盤面既定。未指定(列が null)と「既定を選んだ」が
   *  記録上区別されるのはこの1値による。 */
  source: { tier: TierSource };
}

/** 1回の pickup が決める実行設定の入力(CONTEXT.md「Selector」)。Provider entry
 *  の配列(#544)はまだここに無い —— 今日の agent は単一 Provider である。
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
  provider: Provider;
  /** task の要求ティア(CONTEXT.md「要求」)。省略 → agent の `tier`。 */
  taskTier: Tier | undefined;
  /** agent.md の `tier`。省略 → 盤面既定。 */
  agentTier: Tier | undefined;
  /** agent.md の `advisor`(真偽)。model 名は書かれない —— 導出は下記。 */
  advisor: boolean;
  /** 盤面設定:「上位ティアの行を advisor に使ってよい」。立つまで advisor は
   *  main と同一に倒れる —— Fable の usage-credits 同意も org の `availableModels`
   *  も盤面からは読めず、不成立なら headless の CLI は exit せず advisor 無しで
   *  黙って起動する(2026-09-10 実測: stream-json は未 attach を通知しない)。 */
  frontierAdvisor: boolean;
}

/** 要求されたティアの行が表に無い。ADR 0005 の明示ピン留めは「値が無ければ既定へ
 *  倒す」を許すが、**倒す先は表**であって adapter 定数ではなくなった —— 行が無い
 *  まま別のモデルで走らせれば、記録された実行設定が嘘になる。表の穴は運用者の
 *  設定漏れなので、agent の quarantine ではなく spawn の失敗として上げる。 */
export class IncompleteExecutionSettingTableError extends Error {
  constructor(provider: Provider, tier: Tier) {
    super(
      `the board's execution-setting table has no row for ${provider} / ${tier} — ` +
        "add it before a task can run there (ADR 0110 決定3)",
    );
    this.name = "IncompleteExecutionSettingTableError";
  }
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

function rowFor(table: ExecutionSettingTable, provider: Provider, tier: Tier): ExecutionSettingRow {
  const row = table.find((entry) => entry.provider === provider && entry.tier === tier);
  if (!row) throw new IncompleteExecutionSettingTableError(provider, tier);
  return row;
}

/** pickup 1回ぶんの実行設定を決める決定論の規則(CONTEXT.md「Selector」/ ADR 0110
 *  決定3)。「誰が走るか」(Assignee)は選ばない —— 選ぶのは、その agent が走る
 *  計算資源だけである。
 *
 *  advisor の model は agent.md には書かれない: 真のときだけ表から導出し、上位
 *  ティアの行(main が既に上位ならその行そのもの)を採る。main が selector で
 *  動く以上、固定した model 名は書いた時点でしか正しくない。
 *
 *  kill switch(ADR 0043)はここでは見ない —— 「この session に advisor は無い」
 *  という盤面ホストの運用マスクは registry の宣言とは別の層で、選んだ**後**に
 *  被せる(claude-worker.ts の launch)。 */
export function selectExecutionSetting(
  request: SelectorInput,
  table: ExecutionSettingTable,
): ExecutionSetting {
  const tier = request.taskTier ?? request.agentTier ?? BOARD_DEFAULT_TIER;
  const main = rowFor(table, request.provider, tier);
  let advisor: string | undefined;
  if (request.advisor) {
    const advisorTier: Tier = request.frontierAdvisor ? "frontier" : tier;
    advisor = rowFor(table, request.provider, advisorTier).model;
    assertAdvisorPairing(tier, advisorTier);
  }
  return {
    provider: request.provider,
    model: main.model,
    effort: main.effort,
    advisor,
    // 解決順のどの段で決まったか。値の一致では畳まない —— agent と同じティアを
    // task が要求しても出所は "task" で、それが学習の文脈変数になる。
    source: { tier: request.taskTier !== undefined ? "task" : request.agentTier !== undefined ? "agent" : "board" },
  };
}

/** 盤面の表を DB から読む(ADR 0110 決定3: 種から初期化された後は DB が正本)。
 *  表は9行の定数サイズなので pickup ごとに読み直してよく、#545 の編集が次の
 *  pickup から効くのはそのおかげである。 */
function loadExecutionSettingTable(db: Db): ExecutionSettingTable {
  return db
    .prepare("SELECT provider, tier, model, effort FROM execution_settings")
    .all() as ExecutionSettingRow[];
}

/** 「上位ティアの行を advisor に使ってよい」(SelectorInput.frontierAdvisor)。
 *  行が無い = 未設定 = false —— display_language と同じ「行が無ければ既定」の形。 */
function isFrontierAdvisorEnabled(db: Db): boolean {
  const row = db.prepare("SELECT frontier_advisor FROM execution_defaults WHERE id = 1").get() as
    | { frontier_advisor: number }
    | undefined;
  return row?.frontier_advisor === 1;
}

/** 盤面境界の1行: この agent の定義から、盤面の表と設定を読んで実行設定を決める。
 *  Claude / Codex 両アダプタと、Throttle のモデル窓・usage 資源を解決する
 *  server-options の resolver たちが**同じこの1本**を通る —— 「その agent は
 *  何のモデルで走るのか」の答えが2つあってはならない(モデル窓の除外は、答えが
 *  ずれた瞬間に全テスト緑のまま黙って効かなくなる面である)。
 *
 *  `provider` / `tier` の文字列が列挙に収まっていることは、定義を受け入れる門
 *  (`assertValidAgentDefinition`)が既に保証している。 */
export function resolveExecutionSetting(
  db: Db,
  definition: Pick<AgentDefinition, "provider" | "tier" | "advisor">,
  /** task の要求ティア。`null` は行の綴りのまま受ける —— 呼び手は3つとも
   *  `task.tier` を持っており、各々で undefined へ直させる理由が無い。 */
  taskTier: Tier | null | undefined,
): ExecutionSetting {
  return selectExecutionSetting(
    {
      provider: definition.provider as Provider,
      taskTier: taskTier ?? undefined,
      agentTier: definition.tier as Tier | undefined,
      advisor: definition.advisor,
      frontierAdvisor: isFrontierAdvisorEnabled(db),
    },
    loadExecutionSettingTable(db),
  );
}
