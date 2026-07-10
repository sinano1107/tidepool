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
      client.draftHandoff("mounted the sensor on the north wall, used the spare bracket"),
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

    await expect(client.draftHandoff("mounted the sensor")).rejects.toThrow();
  });
});
