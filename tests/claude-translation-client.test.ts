import { describe, expect, it, vi } from "vitest";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";

const RESULT_ENVELOPE = (result: string) =>
  JSON.stringify({
    result,
    total_cost_usd: 0.000586,
    usage: {
      input_tokens: 506,
      output_tokens: 16,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });

describe("ClaudeTranslationClient", () => {
  it("CLI の JSON エンベロープから訳文とトークン使用量を組み立てて返す", async () => {
    const client = new ClaudeTranslationClient({
      exec: async () => RESULT_ENVELOPE("盤面は決着したツリーを退ける"),
    });

    await expect(client.translate("the board retires a settled tree", "Japanese")).resolves.toEqual(
      {
        text: "盤面は決着したツリーを退ける",
        usage: {
          input_tokens: 506,
          output_tokens: 16,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          estimated_cost_usd: 0.000586,
        },
      },
    );
  });

  it("--model haiku を固定指定する(issue #47: draft の sonnet より軽い一発翻訳)", async () => {
    const calls: string[][] = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, args) => {
        calls.push(args);
        return RESULT_ENVELOPE("t");
      },
    });

    await client.translate("s", "Japanese");

    expect(calls[0]!.join(" ")).toContain("--model haiku");
  });

  // ADR 0044: 翻訳は Board call であり advisor を持たない。`--safe-mode` も
  // `--model haiku` も守りにならない —— 実測(2026-08-04)では haiku main のまま
  // ホストの `advisorModel` が opus を attach し、翻訳提示1回あたり $0.19 焼けた。
  it("advisor を閉じる env を渡す(Board call / ADR 0044)", async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, _args, env) => {
        envs.push(env);
        return RESULT_ENVELOPE("t");
      },
    });

    await client.translate("s", "Japanese");

    expect(envs[0]!.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
    expect(envs[0]!.PATH).toBe(process.env.PATH);
  });

  // ADR 0062 決定1/2: 空のツール面と推論の不在を、呼び出しごとに明示的に宣言する。
  // 実測(本番 Pi / 2026-08-10)ではこの2つで $0.0163 → $0.0021、14.0s → 7.4s。
  it("--tools \"\" と推論を閉じる env を渡す(ADR 0062 決定1/2)", async () => {
    const calls: string[][] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, args, env) => {
        calls.push(args);
        envs.push(env);
        return RESULT_ENVELOPE("t");
      },
    });

    await client.translate("s", "Japanese");

    const args = calls[0]!;
    const at = args.indexOf("--tools");
    expect(args[at + 1]).toBe("");
    // `--tools <tools...>` は可変長 —— 値を空にした分だけ次の引数を食う余地がある
    expect(args[at + 2]).toMatch(/^--/);
    expect(envs[0]!.MAX_THINKING_TOKENS).toBe("0");
  });

  it("--max-turns 1 と --safe-mode を指定する(MCPツールを持たない単発呼び出し)", async () => {
    const calls: string[][] = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, args) => {
        calls.push(args);
        return RESULT_ENVELOPE("t");
      },
    });

    await client.translate("s", "Japanese");

    const argLine = calls[0]!.join(" ");
    expect(argLine).toContain("--max-turns 1");
    expect(argLine).toContain("--safe-mode");
  });

  // ADR 0062 決定3: 翻訳の要求は自前のシステムプロンプトが持ち、user prompt は
  // 対象言語と原文だけの薄いものになる。既定のシステムプロンプトはコーディング
  // エージェントの人格であり翻訳者としては雑音で、3,600 トークン払って翻訳に不利な
  // 指示を積んでいた(実測: 訳文の質も書き下し版のほうが上)。
  it("翻訳の要求はシステムプロンプトに載り、user prompt は対象言語と原文だけになる(ADR 0062 決定3)", async () => {
    const calls: string[][] = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, args) => {
        calls.push(args);
        return RESULT_ENVELOPE("t");
      },
    });
    const source = "the board retires a settled tree";

    await client.translate(source, "French");

    const args = calls[0]!;
    const systemPrompt = args[args.indexOf("--system-prompt") + 1]!;
    const userPrompt = args[1]!;
    // markdown 構造の保持は要求のひとつ —— それが綴られる場所がシステムプロンプト側
    expect(systemPrompt).toMatch(/markdown/i);
    expect(userPrompt).not.toMatch(/markdown/i);
    expect(userPrompt).toContain("French");
    expect(userPrompt).toContain(source);
    // 「薄い」を額面どおり見る: 原文と言語名のほかに載るものはほとんど無い
    expect(userPrompt.length).toBeLessThan(source.length + 80);
  });

  it("プロンプトに翻訳先言語と原文が含まれる", async () => {
    const calls: string[][] = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, args) => {
        calls.push(args);
        return RESULT_ENVELOPE("t");
      },
    });

    await client.translate("the board retires a settled tree", "French");

    const prompt = calls[0]![1]!;
    expect(prompt).toContain("French");
    expect(prompt).toContain("the board retires a settled tree");
  });

  it("日本語への翻訳時、渡された用語集がプロンプトに埋め込まれる(issue #47)", async () => {
    const calls: string[][] = [];
    const client = new ClaudeTranslationClient({
      glossary: [{ term: "Settled", ja: "決着" }, { term: "Held", ja: "保留" }],
      exec: async (_command, args) => {
        calls.push(args);
        return RESULT_ENVELOPE("t");
      },
    });

    await client.translate("s", "Japanese");

    const prompt = calls[0]![1]!;
    expect(prompt).toContain("Settled = 決着");
    expect(prompt).toContain("Held = 保留");
  });

  it("正規値 'Japanese' との完全一致でのみ用語集を埋め込む(表記ゆれは入口の displayLanguageSchema で 400 になり、ここには届かない — issue #115)", async () => {
    const calls: string[][] = [];
    const client = new ClaudeTranslationClient({
      glossary: [{ term: "Settled", ja: "決着" }],
      exec: async (_command, args) => {
        calls.push(args);
        return RESULT_ENVELOPE("t");
      },
    });

    await client.translate("s", "japanese");

    const prompt = calls[0]![1]!;
    expect(prompt).not.toContain("決着");
  });

  it("日本語以外への翻訳では用語集を埋め込まない(対訳が日本語専用のため)", async () => {
    const calls: string[][] = [];
    const client = new ClaudeTranslationClient({
      glossary: [{ term: "Settled", ja: "決着" }],
      exec: async (_command, args) => {
        calls.push(args);
        return RESULT_ENVELOPE("t");
      },
    });

    await client.translate("s", "French");

    const prompt = calls[0]![1]!;
    expect(prompt).not.toContain("決着");
  });

  // ADR 0063 決定2: 盤面が守るのは Pi のメモリである。CLI プロセス1本の peak RSS は
  // ~300MB で ADR 0062 のトークン削減後も変わらず(302MB)、Pi の空きは ~2,980MB ——
  // 単純計算で10本前後で OOM する。呼び出し元の行儀とは独立した床なので、seam から
  // 「同時に何本立ったか」を直接見る。
  it("同時に立てる CLI プロセスは2本まで(ADR 0063 決定2)", async () => {
    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const client = new ClaudeTranslationClient({
      exec: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => release.push(resolve));
        running -= 1;
        return RESULT_ENVELOPE("t");
      },
    });

    const calls = [
      client.translate("a", "Japanese"),
      client.translate("b", "Japanese"),
      client.translate("c", "Japanese"),
    ];
    await Promise.resolve();
    expect(release.length).toBe(2);

    // 1本ぶん空ければ、待っていた3本目が入る
    release.shift()!();
    await vi.waitFor(() => expect(release.length).toBe(2));
    for (const done of release.splice(0)) done();
    await Promise.all(calls);

    expect(peak).toBe(2);
  });

  // ADR 0063 決定2: 待ちに上限を置くのは、HTTP のタイムアウト —— 盤面が決めていない、
  // 将来黙って変わりうる外部の値 —— に寄りかからないためである。諦めた答えは
  // reject として上へ抜け、API 層の既存の 503 に乗る。
  it("床が30秒空かなければ諦めて reject する(ADR 0063 決定2)", async () => {
    vi.useFakeTimers();
    try {
      const client = new ClaudeTranslationClient({
        exec: () => new Promise<string>(() => {}),
      });

      void client.translate("a", "Japanese");
      void client.translate("b", "Japanese");
      const gaveUp = client.translate("c", "Japanese");
      // 諦める前に reject しないこと —— そこが「待つ」の中身である
      const settledEarly = vi.advanceTimersByTimeAsync(29_000).then(() => "still waiting");
      await expect(Promise.race([gaveUp.catch(() => "gave up"), settledEarly])).resolves.toBe(
        "still waiting",
      );

      const rejected = expect(gaveUp).rejects.toThrow(/30s/);
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("CLI 出力が不正な JSON エンベロープの場合、translate は reject する", async () => {
    const client = new ClaudeTranslationClient({
      exec: async () => JSON.stringify({ result: "no usage field here" }),
    });

    await expect(client.translate("s", "Japanese")).rejects.toThrow();
  });
});
