import { describe, expect, it } from "vitest";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";

describe("ClaudeDraftClient.draftHandoff(issue #13)", () => {
  it("CLI の JSON エンベロープ内から6項目ハンドオフの部分集合を組み立てて返す", async () => {
    const draftJson = JSON.stringify({
      outcome: "sensor mounted and reading",
      deliverables: "greenhouse, north wall",
      resume_context: "spare bracket left in the shed if it falls again",
    });
    const client = new ClaudeDraftClient({
      exec: async () => JSON.stringify({ result: draftJson }),
    });

    await expect(
      client.draftHandoff("mounted the sensor on the north wall, used the spare bracket", "English"),
    ).resolves.toEqual({
      outcome: "sensor mounted and reading",
      deliverables: "greenhouse, north wall",
      resume_context: "spare bracket left in the shed if it falls again",
    });
  });

  it("CLI 出力が JSON でない場合、draftHandoff は reject する", async () => {
    const client = new ClaudeDraftClient({
      exec: async () => JSON.stringify({ result: "not actually JSON" }),
    });

    await expect(client.draftHandoff("mounted the sensor", "English")).rejects.toThrow();
  });

  it("プロンプトにフラグメント保存 + 指定言語での散文指示が注入される(issue #46)", async () => {
    const calls: string[][] = [];
    const client = new ClaudeDraftClient({
      exec: async (_command, args) => {
        calls.push(args);
        return JSON.stringify({ result: JSON.stringify({ outcome: "done" }) });
      },
    });

    await client.draftHandoff("mounted the sensor", "Japanese");

    const prompt = calls[0]!.join(" ");
    expect(prompt).toContain(
      "Preserve the language of the dump: keep each fragment in the language it was written in — " +
        "English technical terms, quoted error messages, and criteria stay exactly as given. Any " +
        "connective prose you add yourself, write in Japanese.",
    );
  });
});
