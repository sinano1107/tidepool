import { describe, expect, it } from "vitest";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { openDb } from "../src/db.js";
import { boardCallStream, boardCallSystemPrompt, CLI_ENVELOPE_USAGE } from "./fakes.js";

const db = openDb(":memory:");

describe("ClaudeDraftClient.draftHandoff(issue #13)", () => {
  it("CLI の JSON エンベロープ内から6項目ハンドオフの部分集合を組み立てて返す", async () => {
    const draftJson = JSON.stringify({
      outcome: "sensor mounted and reading",
      deliverables: "greenhouse, north wall",
      resume_context: "spare bracket left in the shed if it falls again",
    });
    const client = new ClaudeDraftClient({
      db,
      exec: async () => boardCallStream({ ...CLI_ENVELOPE_USAGE, result: draftJson }),
    });

    await expect(
      client.draftHandoff("mounted the sensor on the north wall, used the spare bracket", "English"),
    ).resolves.toHaveProperty("output", {
      outcome: "sensor mounted and reading",
      deliverables: "greenhouse, north wall",
      resume_context: "spare bracket left in the shed if it falls again",
    });
  });

  it("CLI 出力が JSON でない場合、draftHandoff は reject する", async () => {
    const client = new ClaudeDraftClient({
      db,
      exec: async () => boardCallStream({ ...CLI_ENVELOPE_USAGE, result: "not actually JSON" }),
    });

    await expect(client.draftHandoff("mounted the sensor", "English")).rejects.toThrow();
  });

  it("プロンプトにフラグメント保存 + 指定言語での散文指示が注入される(issue #46)", async () => {
    const calls: (string | undefined)[] = [];
    const client = new ClaudeDraftClient({
      db,
      exec: async (_command, _args, _env, input) => {
        calls.push(input);
        return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify({ outcome: "done" }) });
      },
    });

    await client.draftHandoff("mounted the sensor", "Japanese");

    const prompt = calls[0];
    expect(prompt).toContain(
      "Preserve the language of the dump: keep each fragment in the language it was written in — " +
        "English technical terms, quoted error messages, and criteria stay exactly as given. Any " +
        "connective prose you add yourself, write in Japanese.",
    );
  });

  it("用途に依らない盤面の system prompt を --system-prompt で渡す(ADR 0296 決定6)", async () => {
    const calls: string[][] = [];
    const client = new ClaudeDraftClient({
      db,
      exec: async (_command, args) => {
        calls.push(args);
        return boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify({ outcome: "o" }) });
      },
    });

    await client.draftHandoff("mounted the sensor", "English");

    const args = calls[0]!;
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(await boardCallSystemPrompt());
  });
});
