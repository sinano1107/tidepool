import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  answerBoardCallEnv,
  boardCallEnv,
  boardCallEnvWithoutThinking,
  claudeMcpReachabilityThrough,
  moonshotCliAuthEnv,
  usageScrapeEnv,
} from "../src/claude-worker.js";
import { specRecordingCall } from "./fakes.js";
import { HOST_ENV_DECOYS, stubHostEnvDecoys } from "./harness.js";
import { tempDir } from "./temp-dir.js";

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

  // ADR 0186 決定4: 盤面が起こす `claude` は自分で更新しない(`DISABLE_UPDATES` ではない)
  it("CLI の自動更新を閉じる", () => {
    expect(boardCallEnv().DISABLE_AUTOUPDATER).toBe("1");
  });

  // 差分ではなく完全な env を返す契約(ADR 0044 決定3)は保ったまま、中身は盤面が列挙したものだけ(ADR 0358 決定1・2)。
  // 答えの Board call も anthropic を喋る(ADR 0096)ので盤面 env の token を受け取り、API key は列挙に無い(ADR 0070 決定1)。
  // TMPDIR は持たない(OS 既定)。
  it("答えの Board call の env は列挙と完全一致し、host の囮は届かない", () => {
    stubHostEnvDecoys();
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "board-oauth-token");

    expect(answerBoardCallEnv()).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/board",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "board-oauth-token",
      CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_PROMPT_CACHING: "1",
    });
  });

  // worker の形の Board call(ADR 0341)は盤面所有の config dir(ADR 0354 決定1)を運び、MCP 到達性 probe だけは
  // 使い捨て dir を TMPDIR に渡す(sandbox の proxy socket を閉じた /tmp に置かない)
  it("worker の形の Board call の env は列挙と完全一致し、host の囮は届かない", async () => {
    stubHostEnvDecoys();
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "board-oauth-token");
    const { call, specs } = specRecordingCall();

    await claudeMcpReachabilityThrough(call)("http://localhost:4589/mcp");

    const { env, cwd } = specs[0]!;
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/board",
      TMPDIR: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "board-oauth-token",
      CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
    });
    expect(env.CLAUDE_CONFIG_DIR).toEqual(expect.any(String));
  });

  // Moonshot の認証 probe は Moonshot の worker spawn と同じ組み立て: Claude の subscription は列挙に無く、
  // routing 一式は key file から(ADR 0097 決定2)
  it("Moonshot の認証 probe の env は列挙と完全一致し、host の囮も Claude の token も届かない", async () => {
    stubHostEnvDecoys();
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "board-oauth-token");
    const keyFile = join(await tempDir("tidepool-moonshot-key-"), "moonshot-api-key");
    await writeFile(keyFile, "sk-moonshot-test-key\n", { mode: 0o600 });

    expect(moonshotCliAuthEnv(keyFile)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/board",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
      DISABLE_AUTOUPDATER: "1",
      ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-moonshot-test-key",
      ANTHROPIC_MODEL: "kimi-k3[1m]",
    });
  });

  // ADR 0358 決定1 の外(pty の TUI が TERM 等に依るかが未測): 盤面の env を継ぐのが意図である釘
  it("/usage scrape の env は host の env をそのまま継ぐ(列挙の外)", () => {
    stubHostEnvDecoys();

    expect(usageScrapeEnv()).toMatchObject({ ...HOST_ENV_DECOYS, PATH: "/usr/bin:/bin", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1", DISABLE_AUTOUPDATER: "1" });
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

  // issue #2351: Board call も --model / --effort をフラグで pin するが、翻訳と probe の --model は
  // `haiku` の alias で、CLAUDE_CODE_EFFORT_LEVEL は --effort に勝つ(2.1.286 実測)。host の値は
  // ここでも消す —— 盤面側の値は入れず「無い」を固定する(ADR 0005)。
  it("Board call の env からは main の pin を上書きする host env(effort / alias 差し替え)が除去される", () => {
    const names = ["CLAUDE_CODE_EFFORT_LEVEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];
    for (const name of names) vi.stubEnv(name, "low");
    try {
      const env = boardCallEnv();
      for (const name of names) expect(env[name]).toBeUndefined();
      const noThinking = boardCallEnvWithoutThinking();
      for (const name of names) expect(noThinking[name]).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("host が止めていても refusal の再試行と model の差し替えを許す(ADR 0323)", () => {
    const names = ["CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK", "CLAUDE_CODE_NO_MODEL_FALLBACK", "CLAUDE_CODE_DISABLE_REFUSAL_RETRY"];
    for (const name of names) vi.stubEnv(name, "1");
    try {
      for (const name of names) {
        expect(boardCallEnv()[name]).toBeUndefined();
        expect(boardCallEnvWithoutThinking()[name]).toBeUndefined();
        expect(process.env[name]).toBe("1");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // ADR 0062 決定2: 「推論しない」は全 Board call について真ではないので
  // `boardCallEnv()` には畳み込まず、上に重ねる形で綴る。重ねる側が advisor の
  // 宣言を落とせば ADR 0044 が黙って失効するので、そこをここで見張る。
  it("推論を閉じる env は Board call の env の上に重なる(advisor の宣言を落とさない)", () => {
    expect(boardCallEnvWithoutThinking().MAX_THINKING_TOKENS).toBe("0");
    expect(boardCallEnvWithoutThinking().CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
    expect(boardCallEnvWithoutThinking().PATH).toBe(process.env.PATH);
  });
});
