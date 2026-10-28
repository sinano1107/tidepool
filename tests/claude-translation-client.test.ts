import { describe, expect, it, vi } from "vitest";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";
import { boardCallStream } from "./fakes.js";

const ENVELOPE = (result: string) =>
  boardCallStream({
    result,
    total_cost_usd: 0.000586,
    usage: {
      input_tokens: 506,
      output_tokens: 16,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });

/** 断片 i に id i で答える封筒 */
const RESULT_ENVELOPE = (texts: string[]) => ENVELOPE(JSON.stringify({ items: texts.map((text, id) => ({ id, text })) }));

describe("ClaudeTranslationClient", () => {
  it("断片の配列を id 付きの JSON で1回の CLI 呼び出しに載せ、同じ順の訳文と呼び出し1回の使用量と走った設定を返す", async () => {
    const prompts: string[] = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, _args, _env, input) => {
        prompts.push(input!);
        // 順を入れ替えて答えても id で元の順に戻る
        return ENVELOPE(JSON.stringify({ items: [{ id: 1, text: "訳B" }, { id: 0, text: "訳A" }, { id: 2, text: "訳C" }] }));
      },
    });

    await expect(client.translate(["a", "b", "c"], "Japanese")).resolves.toEqual({
      texts: ["訳A", "訳B", "訳C"],
      model_swaps: [],
      refusals: [],
      usage: {
        input_tokens: 506,
        output_tokens: 16,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        estimated_cost_usd: 0.000586,
      },
      setting: { provider: "anthropic", model: "haiku", effort: "low" },
    });
    expect(prompts).toHaveLength(1);
    // user prompt に載った id 付きの断片
    expect(JSON.parse(prompts[0]!.slice(prompts[0]!.indexOf("{")))).toEqual({
      items: [
        { id: 0, text: "a" },
        { id: 1, text: "b" },
        { id: 2, text: "c" },
      ],
    });
  });

  it("``` で包まれた応答からも JSON を取り出す", async () => {
    const client = new ClaudeTranslationClient({
      exec: async () => ENVELOPE(`\`\`\`json\n${JSON.stringify({ items: [{ id: 0, text: "訳" }] })}\n\`\`\``),
    });

    expect((await client.translate(["s"], "Japanese")).texts).toEqual(["訳"]);
  });

  it.each([
    ["欠け", [{ id: 0, text: "訳A" }]],
    ["重複", [{ id: 0, text: "訳A" }, { id: 0, text: "訳A'" }]],
    ["余計", [{ id: 0, text: "訳A" }, { id: 1, text: "訳B" }, { id: 2, text: "訳?" }]],
    ["範囲外", [{ id: 0, text: "訳A" }, { id: 5, text: "訳B" }]],
  ])("応答の id が入力と一致しない(%s)と呼び出しごと reject する", async (_, items) => {
    const client = new ClaudeTranslationClient({ exec: async () => ENVELOPE(JSON.stringify({ items })) });

    await expect(client.translate(["a", "b"], "Japanese")).rejects.toThrow(/ids/);
  });

  it("--model haiku を固定指定する(issue #47: draft の sonnet より軽い一発翻訳)", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, args, _env, input) => {
        calls.push({ args, input });
        return RESULT_ENVELOPE(["t"]);
      },
    });

    await client.translate(["s"], "Japanese");

    expect(calls[0]!.args.join(" ")).toContain("--model haiku");
  });

  // ADR 0044: 翻訳は Board call であり advisor を持たない。`--safe-mode` も
  // `--model haiku` も守りにならない —— 実測(2026-08-04)では haiku main のまま
  // ホストの `advisorModel` が opus を attach し、翻訳提示1回あたり $0.19 焼けた。
  it("advisor を閉じる env を渡す(Board call / ADR 0044)", async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, _args, env) => {
        envs.push(env);
        return RESULT_ENVELOPE(["t"]);
      },
    });

    await client.translate(["s"], "Japanese");

    expect(envs[0]!.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
    expect(envs[0]!.PATH).toBe(process.env.PATH);
  });

  // ADR 0062 決定1/2: 空のツール面と推論の不在を、呼び出しごとに明示的に宣言する。
  // 実測(本番 Pi / 2026-08-10)ではこの2つで $0.0163 → $0.0021、14.0s → 7.4s。
  it("--tools \"\" と推論を閉じる env を渡す(ADR 0062 決定1/2)", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, args, env, input) => {
        calls.push({ args, input });
        envs.push(env);
        return RESULT_ENVELOPE(["t"]);
      },
    });

    await client.translate(["s"], "Japanese");

    const args = calls[0]!.args;
    const at = args.indexOf("--tools");
    expect(args[at + 1]).toBe("");
    // `--tools <tools...>` は可変長 —— 値を空にした分だけ次の引数を食う余地がある
    expect(args[at + 2]).toMatch(/^--/);
    expect(envs[0]!.MAX_THINKING_TOKENS).toBe("0");
  });

  it("--max-turns 1 と --safe-mode / --setting-sources \"\" を指定する(MCPツールを持たない単発呼び出し、ADR 0303 決定1)", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, args, _env, input) => {
        calls.push({ args, input });
        return RESULT_ENVELOPE(["t"]);
      },
    });

    await client.translate(["s"], "Japanese");

    const argLine = calls[0]!.args.join(" ");
    expect(argLine).toContain("--max-turns 1");
    expect(argLine).toContain("--safe-mode");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--setting-sources") + 1]).toBe("");
  });

  // ADR 0062 決定3: 翻訳の要求は自前のシステムプロンプトが持ち、user prompt は
  // 対象言語と id 付きの断片だけの薄いものになる。既定のシステムプロンプトはコーディング
  // エージェントの人格であり翻訳者としては雑音で、3,600 トークン払って翻訳に不利な
  // 指示を積んでいた(実測: 訳文の質も書き下し版のほうが上)。答えの形(id 付きの JSON)も
  // 要求の1行としてシステムプロンプト側に綴られる(ADR 0296 決定4)。
  it("翻訳の要求と答えの形はシステムプロンプトに載り、user prompt は対象言語と id 付きの断片だけになる(ADR 0062 決定3)", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const client = new ClaudeTranslationClient({
      exec: async (_command, args, _env, input) => {
        calls.push({ args, input });
        return RESULT_ENVELOPE(["t"]);
      },
    });

    await client.translate(["the board retires a settled tree"], "French");

    const args = calls[0]!.args;
    const systemPrompt = args[args.indexOf("--system-prompt") + 1]!;
    const userPrompt = calls[0]!.input!;
    // markdown 構造の保持は要求のひとつ —— それが綴られる場所がシステムプロンプト側
    expect(systemPrompt).toMatch(/markdown/i);
    expect(systemPrompt).toContain('{"items": [{"id"');
    expect(userPrompt).not.toMatch(/markdown/i);
    expect(userPrompt).toContain("French");
    // 「薄い」を額面どおり見る: 断片の JSON の手前には言語名ほどしか載らない
    expect(userPrompt.slice(0, userPrompt.indexOf("{")).length).toBeLessThan(80);
  });

  it("日本語への翻訳時、渡された用語集がプロンプトに埋め込まれる(issue #47)", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const client = new ClaudeTranslationClient({
      glossary: [{ term: "Settled", ja: "決着" }, { term: "Held", ja: "保留" }],
      exec: async (_command, args, _env, input) => {
        calls.push({ args, input });
        return RESULT_ENVELOPE(["t"]);
      },
    });

    await client.translate(["s"], "Japanese");

    const prompt = calls[0]!.input!;
    expect(prompt).toContain("Settled = 決着");
    expect(prompt).toContain("Held = 保留");
  });

  it("正規値 'Japanese' との完全一致でのみ用語集を埋め込む(表記ゆれは入口の displayLanguageSchema で 400 になり、ここには届かない — issue #115)", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const client = new ClaudeTranslationClient({
      glossary: [{ term: "Settled", ja: "決着" }],
      exec: async (_command, args, _env, input) => {
        calls.push({ args, input });
        return RESULT_ENVELOPE(["t"]);
      },
    });

    await client.translate(["s"], "japanese");

    const prompt = calls[0]!.input!;
    expect(prompt).not.toContain("決着");
  });

  it("日本語以外への翻訳では用語集を埋め込まない(対訳が日本語専用のため)", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const client = new ClaudeTranslationClient({
      glossary: [{ term: "Settled", ja: "決着" }],
      exec: async (_command, args, _env, input) => {
        calls.push({ args, input });
        return RESULT_ENVELOPE(["t"]);
      },
    });

    await client.translate(["s"], "French");

    const prompt = calls[0]!.input!;
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
        return RESULT_ENVELOPE(["t"]);
      },
    });

    const calls = [
      client.translate(["a"], "Japanese"),
      client.translate(["b"], "Japanese"),
      client.translate(["c"], "Japanese"),
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

      void client.translate(["a"], "Japanese");
      void client.translate(["b"], "Japanese");
      const gaveUp = client.translate(["c"], "Japanese");
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
});
