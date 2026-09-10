import type { AgentDefinition, Provider } from "./registry.js";

/** worker session が実際に走る計算資源の組(CONTEXT.md「実行設定」)。
 *  `provider` は誰が課金元かで、`model` / `effort` はその provider 自身の表記
 *  (ADR 0005 の明示ピン留め — 値が無くてもフラグは常に渡す)、`advisor` は
 *  盤面がピン留めする相談先で、能力が無ければ undefined。
 *
 *  undefined であって null でないのは、消費する側 —— `advisorSpawnFlags` と
 *  `workerSpawnEnv`(claude-worker.ts)—— が「不在」を undefined で綴るため。
 *  `worker_spawned.advisor` の null はイベント層の綴りで、ここではない。 */
export interface ExecutionSetting {
  provider: Provider;
  model: string;
  effort: string;
  advisor: string | undefined;
}

/** provider ごとの `--model` の fallback(ADR 0005 のピン留め規則を、その
 *  provider 自身のモデル表記で綴ったもの —— moonshot の spawn に "sonnet" を
 *  渡すと model-not-found で死ぬ)。`kimi-k3[1m]` は Moonshot 公式の Claude Code
 *  ガイドの既定(platform.kimi.ai, 2026-08)、`gpt-5.6-sol` は Codex の既定。 */
const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "sonnet",
  moonshot: "kimi-k3[1m]",
  openai: "gpt-5.6-sol",
};

/** moonshot 向きの spawn と auth probe が env に載せるモデル表記(ADR 0097
 *  決定4 の注入一式の3つ目)。上の表と同じ値を指すが、probe は agent の定義を
 *  持たない盤面自身の呼び出しなので、解決関数ではなくこの定数を読む。 */
export const MOONSHOT_DEFAULT_MODEL = PROVIDER_DEFAULT_MODEL.moonshot;

/** Codex 経路の `-m` の fallback。server-options の usage 資源解決が「openai の
 *  agent が実際に焼くモデル」を言うのにも要る(ADR 0098 の窓は provider × model
 *  で数えられる)。 */
export const CODEX_DEFAULT_MODEL = PROVIDER_DEFAULT_MODEL.openai;

/** spawn 1回ぶんの実行設定を決める1つの場所。Claude / Codex どちらのアダプタも
 *  ここを通す —— 「値が無ければ既定」という規則が adapter ごとに1つずつ書かれて
 *  いると、片方だけが動いたときに気づけない(ADR 0005 の明示ピン留めは、どの
 *  provider でも同じ強さで効いていなければ意味を成さない)。
 *
 *  kill switch(ADR 0043)はここでは見ない —— 「この session に advisor は無い」
 *  という盤面ホストの運用マスクは registry の宣言とは別の層で、解決の**後**に
 *  被せる(claude-worker.ts の launch)。 */
export function resolveExecutionSetting(
  provider: Provider,
  definition: Pick<AgentDefinition, "model" | "effort" | "advisor">,
): ExecutionSetting {
  return {
    provider,
    model: definition.model ?? PROVIDER_DEFAULT_MODEL[provider],
    effort: definition.effort ?? "medium",
    advisor: definition.advisor,
  };
}
