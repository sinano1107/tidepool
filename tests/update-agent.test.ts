import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { UnknownAgentError } from "../src/agent.js";
import { UnknownAuthorityProfileError, updateAgent } from "../src/agent-create.js";
import { loadRegistry } from "../src/registry.js";
import { makeRegistry } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** fixture を main に正規化(create-agent.test.ts と同じ理由: ADR 0020)。 */
async function makeMainRegistry(files: Record<string, string> = {}): Promise<string> {
  const dir = await makeRegistry(files);
  git(dir, "branch", "-M", "main");
  return dir;
}

describe("updateAgent: version 自動インクリメント(issue #70 — 機械刻印、呼び出し側は渡せない)", () => {
  it("編集で最後の数値セグメントが +1 され(0.3.1 → 0.3.2)、渡したフィールドで全書き換えされる", async () => {
    const registryDir = await makeMainRegistry();

    await updateAgent(
      {
        name: "deckhand",
        authority: "standard",
        description: "Rewritten description",
        icon: "🦀",
        systemPrompt: "You are Deckhand, rewritten.",
      },
      { registryDir },
    );

    const agent = loadRegistry(registryDir).agents.deckhand;
    expect(agent).toEqual({
      name: "deckhand",
      version: "0.3.2",
      authority: "standard",
      description: "Rewritten description",
      icon: "🦀",
      model: undefined,
      effort: undefined,
      systemPrompt: "You are Deckhand, rewritten.",
    });
    expect(git(registryDir, "status", "--porcelain")).toBe("");
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe("update agent deckhand via WebUI");
    expect(git(registryDir, "log", "-1", "--format=%an")).toBe("tidepool");
  });

  it("非 semver の単一数値でも刻める(3 → 4)", async () => {
    const registryDir = await makeMainRegistry({
      "agents/crab.md": "---\nversion: 3\nauthority: standard\ndescription: d\n---\np\n",
    });

    await updateAgent(
      { name: "crab", authority: "standard", description: "d2", systemPrompt: "p" },
      { registryDir },
    );

    expect(loadRegistry(registryDir).agents.crab!.version).toBe("4");
  });

  it("数値セグメントが一つもない version は 1 に振り直す — 刻印は常に前へ進む", async () => {
    const registryDir = await makeMainRegistry({
      "agents/crab.md": "---\nversion: beta\nauthority: standard\ndescription: d\n---\np\n",
    });

    await updateAgent(
      { name: "crab", authority: "standard", description: "d2", systemPrompt: "p" },
      { registryDir },
    );

    expect(loadRegistry(registryDir).agents.crab!.version).toBe("1");
  });
});

describe("updateAgent: no-change 編集(issue #70 — workspace-create の porcelain チェックの agent 版)", () => {
  it("実効フィールドが不変な再送はコミットなしの成功で、version も上がらない", async () => {
    const registryDir = await makeMainRegistry();
    // fixture の deckhand と同一内容(version は入力に存在しない)
    const same = {
      name: "deckhand",
      authority: "standard",
      description: "General work agent for the tidepool board",
      systemPrompt:
        "You are Deckhand, the tidepool board's general work agent.\nWork only through the tidepool MCP verbs.",
    };
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(updateAgent(same, { registryDir })).resolves.toBeDefined();

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir).agents.deckhand!.version).toBe("0.3.1");
  });

  it("末尾改行付き systemPrompt の再送も no-change — parseAgentFile が trim して読む以上、外側の空白は保存されない正規形で比較する", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await updateAgent(
      {
        name: "deckhand",
        authority: "standard",
        description: "General work agent for the tidepool board",
        systemPrompt:
          "You are Deckhand, the tidepool board's general work agent.\nWork only through the tidepool MCP verbs.\n",
      },
      { registryDir },
    );

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir).agents.deckhand!.version).toBe("0.3.1");
  });
});

describe("updateAgent: authority 検証(issue #70 — 編集でも既存プロファイルのみ)", () => {
  it("registry にないプロファイル名への付け替えは拒否され、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      updateAgent(
        { name: "deckhand", authority: "no-such-profile", description: "d", systemPrompt: "p" },
        { registryDir },
      ),
    ).rejects.toThrow(UnknownAuthorityProfileError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("updateAgent: 存在しないエージェント(issue #70 — 編集は既存名のみ)", () => {
  it("registry にない名前は UnknownAgentError で拒否され、ファイルもコミットも増えない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      updateAgent(
        { name: "ghost", authority: "standard", description: "d", systemPrompt: "p" },
        { registryDir },
      ),
    ).rejects.toThrow(UnknownAgentError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir).agents.ghost).toBeUndefined();
  });
});
