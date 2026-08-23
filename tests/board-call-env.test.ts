import { describe, expect, it, vi } from "vitest";
import { boardCallEnv, boardCallEnvWithoutThinking, initPingSpawnOptions } from "../src/claude-worker.js";

/** Board call(盤面呼び出し / ADR 0044): 盤面が自分の機能のために回す CLI 呼び出しは
 *  worker session ではなく、したがって advisor を持たない。ここが見張るのは
 *  「不在がホストの設定に委ねられていないこと」—— issue #174 の実測(2026-08-04)では、
 *  下書き・翻訳が既に渡していた `--safe-mode` も `--max-turns 1` も advisor を塞がず、
 *  ホストの `advisorModel` が opus を焼いていた。
 *
 *  各呼び出しが実際にこの env を渡していることは、それぞれの seam のテストが見る
 *  (claude-draft-client / claude-translation-client / claude-worker の checkUsage)。 */
describe("Board call の env", () => {
  it("advisor を明示的に閉じる", () => {
    expect(boardCallEnv().CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
  });

  // 差分ではなく完全な env を返す契約(ADR 0044 決定3)。呼び出し側が
  // `{ ...process.env, ...boardCallEnv() }` と綴る形にすると、`...process.env` を
  // 書き忘れたサイトが PATH も認証も失って壊れる —— 書き忘れられる余地を残さない。
  it("ホストの env を丸ごと引き継ぐ(差分ではなく完全形)", () => {
    const previous = process.env.TIDEPOOL_BOARD_CALL_ENV_PROBE;
    process.env.TIDEPOOL_BOARD_CALL_ENV_PROBE = "carried";
    try {
      expect(boardCallEnv().TIDEPOOL_BOARD_CALL_ENV_PROBE).toBe("carried");
      expect(boardCallEnv().PATH).toBe(process.env.PATH);
    } finally {
      if (previous === undefined) delete process.env.TIDEPOOL_BOARD_CALL_ENV_PROBE;
      else process.env.TIDEPOOL_BOARD_CALL_ENV_PROBE = previous;
    }
  });

  // 盤面プロセスの env に立てる案を採らなかったことの裏返し —— それを採ると
  // worker spawn が `process.env` ごと継承して advisor を持つはずの全 worker が
  // 黙って advisor を失う(ADR 0044)。ここで閉じるのは呼び出し1回ぶんだけである。
  it("盤面プロセス自身の env は汚さない", () => {
    // 「呼んでも変わらない」を見る —— `undefined` であることを直接主張すると、それは
    // コードではなく**テストホストの性質**の検査になり、まさに決定4 が想定した
    // 「env を export しているホスト」で偽陽性になる。
    const before = process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL;
    boardCallEnv();
    expect(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe(before);
  });

  // Board call は anthropic 固定(ADR 0096)なので、anthropic の worker spawn と
  // 同じ双方向 scrub がこちらにも掛かる(ADR 0097 決定4 / issue #445)—— 盤面 env
  // に Moonshot 系があっても、下書き・翻訳・probe が静かに Moonshot へ流れない。
  // ANTHROPIC_MODEL を含めて一式除去できるのは、モデルを伴う全 Board call が
  // --model をフラグでピン留めしており(下書き sonnet・翻訳/probe/ping haiku)、
  // 唯一フラグを持たない /usage スクレイプはモデルターンを一切起こさないから —
  // env の ANTHROPIC_MODEL はどの Board call でも legitimate には効いていない。
  it("Board call の env からは Moonshot 注入一式(向き先・トークン・モデル)が除去される(双方向 scrub — Board call は anthropic 固定)", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.moonshot.ai/anthropic");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "sk-leaked-moonshot-token");
    vi.stubEnv("ANTHROPIC_MODEL", "kimi-k3[1m]");
    try {
      const env = boardCallEnv();
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_MODEL).toBeUndefined();
      // 上に重ねる形の no-thinking 版も同じ scrub の上に載る
      const noThinking = boardCallEnvWithoutThinking();
      expect(noThinking.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(noThinking.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(noThinking.ANTHROPIC_MODEL).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // ADR 0025 / 0039 の2本の `/usage` ping は、注入 seam(EnumerateSkillsFn /
  // EnumerateToolsFn)が probe 全体を差し替える高さにあるため、テストからは
  // 子プロセスに渡した物が見えない。spawn オプションを純粋関数として名前を与えた
  // のはそのためで、残る review 依存は runInitPing の1行の配線だけになる。
  // ADR 0062 決定2: 「推論しない」は全 Board call について真ではないので
  // `boardCallEnv()` には畳み込まず、上に重ねる形で綴る。重ねる側が advisor の
  // 宣言を落とせば ADR 0044 が黙って失効するので、そこをここで見張る。
  it("推論を閉じる env は Board call の env の上に重なる(advisor の宣言を落とさない)", () => {
    expect(boardCallEnvWithoutThinking().MAX_THINKING_TOKENS).toBe("0");
    expect(boardCallEnvWithoutThinking().CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
    expect(boardCallEnvWithoutThinking().PATH).toBe(process.env.PATH);
  });

  it("/usage ping の spawn オプションが Board call の env を運ぶ", () => {
    const options = initPingSpawnOptions("/tmp/some-workspace");
    expect(options.cwd).toBe("/tmp/some-workspace");
    expect(options.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
  });
});
