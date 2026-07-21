import { describe, expect, it } from "vitest";
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

  it("CLI 出力が不正な JSON エンベロープの場合、translate は reject する", async () => {
    const client = new ClaudeTranslationClient({
      exec: async () => JSON.stringify({ result: "no usage field here" }),
    });

    await expect(client.translate("s", "Japanese")).rejects.toThrow();
  });
});
