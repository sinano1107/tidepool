import { describe, expect, it } from "vitest";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";

describe("ClaudeDraftClient", () => {
  it("draftTask は CLI の JSON エンベロープ内から TaskDraft を組み立てて返す", async () => {
    const draftJson = JSON.stringify({
      title: "set up the greenhouse sensor",
      purpose: "know soil moisture without walking out",
      completion_criteria: "dashboard shows a live moisture reading",
      assignee: "reef-crab",
      workspace: "tidepool",
      risk_flag: false,
    });
    const client = new ClaudeDraftClient({
      exec: async () => JSON.stringify({ result: draftJson }),
    });

    await expect(
      client.draftTask("set up the greenhouse sensor, sloppy is fine here"),
    ).resolves.toEqual({
      title: "set up the greenhouse sensor",
      purpose: "know soil moisture without walking out",
      completion_criteria: "dashboard shows a live moisture reading",
      assignee: "reef-crab",
      workspace: "tidepool",
      risk_flag: false,
    });
  });

  it("コードフェンスや前後の散文に包まれていても JSON を抽出する(issue #25 の「安全に抽出」要件)", async () => {
    const draftJson = JSON.stringify({
      title: "set up the greenhouse sensor",
      purpose: "know soil moisture without walking out",
      completion_criteria: "dashboard shows a live moisture reading",
    });
    const client = new ClaudeDraftClient({
      exec: async () =>
        JSON.stringify({
          result: `Sure! Here's the draft:\n\n\`\`\`json\n${draftJson}\n\`\`\`\n\nLet me know if you'd like changes.`,
        }),
    });

    await expect(client.draftTask("set up the greenhouse sensor")).resolves.toEqual({
      title: "set up the greenhouse sensor",
      purpose: "know soil moisture without walking out",
      completion_criteria: "dashboard shows a live moisture reading",
    });
  });

  it("CLI 出力が JSON でない場合、draftTask は reject する(#12 の 503 フォールバック契約を守る)", async () => {
    const client = new ClaudeDraftClient({
      exec: async () => JSON.stringify({ result: "sure, here's your task: not actually JSON" }),
    });

    await expect(client.draftTask("set up the greenhouse sensor")).rejects.toThrow();
  });

  it("エンベロープに result フィールド(文字列)が無い場合、draftTask は reject する", async () => {
    const client = new ClaudeDraftClient({
      exec: async () => JSON.stringify({ result: 123 }),
    });

    await expect(client.draftTask("set up the greenhouse sensor")).rejects.toThrow();
  });

  it("必須フィールド(title/purpose/completion_criteria)が欠けている場合、draftTask は reject する", async () => {
    const client = new ClaudeDraftClient({
      exec: async () =>
        JSON.stringify({ result: JSON.stringify({ title: "set up the greenhouse sensor" }) }),
    });

    await expect(client.draftTask("set up the greenhouse sensor")).rejects.toThrow();
  });

  it("RegistryCandidates が渡されている場合、プロンプトに assignee/workspace 候補名が埋め込まれる", async () => {
    const calls: string[][] = [];
    const client = new ClaudeDraftClient({
      candidates: { assignees: ["reef-crab", "deckhand"], workspaces: ["tidepool", "sandbox"] },
      exec: async (_command, args) => {
        calls.push(args);
        return JSON.stringify({
          result: JSON.stringify({ title: "t", purpose: "p", completion_criteria: "c" }),
        });
      },
    });

    await client.draftTask("set up the greenhouse sensor");

    const prompt = calls[0]!.join(" ");
    expect(prompt).toContain("reef-crab");
    expect(prompt).toContain("deckhand");
    expect(prompt).toContain("tidepool");
    expect(prompt).toContain("sandbox");
  });

  it("--model/--effort を明示指定する(ADR 0005: ホストの直前の選択に依存しない)", async () => {
    const calls: string[][] = [];
    const client = new ClaudeDraftClient({
      exec: async (_command, args) => {
        calls.push(args);
        return JSON.stringify({
          result: JSON.stringify({ title: "t", purpose: "p", completion_criteria: "c" }),
        });
      },
    });

    await client.draftTask("set up the greenhouse sensor");

    const argLine = calls[0]!.join(" ");
    expect(argLine).toContain("--model sonnet");
    expect(argLine).toContain("--effort medium");
  });

  it("--max-turns 1 を指定する(MCPツールを持たない単発JSON生成のため)", async () => {
    const calls: string[][] = [];
    const client = new ClaudeDraftClient({
      exec: async (_command, args) => {
        calls.push(args);
        return JSON.stringify({
          result: JSON.stringify({ title: "t", purpose: "p", completion_criteria: "c" }),
        });
      },
    });

    await client.draftTask("set up the greenhouse sensor");

    expect(calls[0]!.join(" ")).toContain("--max-turns 1");
  });

  it("--safe-mode を指定し、ボードの起動ディレクトリの CLAUDE.md/skills/MCP を拾わない", async () => {
    const calls: string[][] = [];
    const client = new ClaudeDraftClient({
      exec: async (_command, args) => {
        calls.push(args);
        return JSON.stringify({
          result: JSON.stringify({ title: "t", purpose: "p", completion_criteria: "c" }),
        });
      },
    });

    await client.draftTask("set up the greenhouse sensor");

    expect(calls[0]!.join(" ")).toContain("--safe-mode");
  });

  it("inspectIssue は issue 全体(title/本文/コメント)をプロンプトに入れ、CLI の応答から IssueInspection を返す(issue #49 設計点4)", async () => {
    const verdict = JSON.stringify({
      ok: false,
      missing: "completion criteria cannot be derived",
      suggested_comment: "## Completion criteria\n- the login form submits cleanly",
    });
    const calls: string[][] = [];
    const client = new ClaudeDraftClient({
      exec: async (_command, args) => {
        calls.push(args);
        return JSON.stringify({ result: verdict });
      },
    });

    const inspection = await client.inspectIssue({
      title: "曖昧なメモ",
      body: "なんとかする",
      comments: ["補足です"],
    });

    expect(inspection).toEqual({
      ok: false,
      missing: "completion criteria cannot be derived",
      suggested_comment: "## Completion criteria\n- the login form submits cleanly",
    });
    // 「issue」= タイトル + 本文 + 全コメント(CONTEXT.md)を検査対象に渡す
    const prompt = calls[0]![1]!;
    expect(prompt).toContain("曖昧なメモ");
    expect(prompt).toContain("なんとかする");
    expect(prompt).toContain("補足です");
  });

  it("inspectIssue: 合格応答は ok:true だけで通り、JSON でない応答は reject する", async () => {
    const pass = new ClaudeDraftClient({
      exec: async () => JSON.stringify({ result: JSON.stringify({ ok: true }) }),
    });
    await expect(pass.inspectIssue({ title: "t", body: "b", comments: [] })).resolves.toEqual({
      ok: true,
    });

    const garbage = new ClaudeDraftClient({
      exec: async () => JSON.stringify({ result: "not json at all" }),
    });
    await expect(garbage.inspectIssue({ title: "t", body: "b", comments: [] })).rejects.toThrow();
  });
});
