import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { UnknownAgentError } from "../src/agent.js";
import { UnknownAuthorityProfileError, updateAgent } from "../src/agent-create.js";
import { loadRegistry } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

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
        skills: ["@workspace"],
        systemPrompt: "You are Deckhand, rewritten.",
      },
      { registryDir, registryMode: "purely-local" },
    );

    const agent = loadRegistry(registryDir, "purely-local").agents.deckhand;
    expect(agent).toEqual({
      name: "deckhand",
      version: "0.3.2",
      authority: "standard",
      description: "Rewritten description",
      icon: "🦀",
      model: undefined,
      effort: undefined,
      skills: ["@workspace"],
      systemPrompt: "You are Deckhand, rewritten.",
    });
    // registryDir 自身の working tree は checkout ではなく着地先の ref だけを見る
    // (ADR 0052 決定6)
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe("update agent deckhand via WebUI");
    expect(git(registryDir, "log", "-1", "--format=%an")).toBe("tidepool");
  });

  it("非 semver の単一数値でも刻める(3 → 4)", async () => {
    const registryDir = await makeMainRegistry({
      "agents/crab.md": "---\nversion: 3\nauthority: standard\nskills:\n  - '*'\ndescription: d\n---\np\n",
    });

    await updateAgent(
      { name: "crab", authority: "standard", description: "d2", skills: ["*"], systemPrompt: "p" },
      { registryDir, registryMode: "purely-local" },
    );

    expect(loadRegistry(registryDir, "purely-local").agents.crab!.version).toBe("4");
  });

  it("数値セグメントが一つもない version は 1 に振り直す — 刻印は常に前へ進む", async () => {
    const registryDir = await makeMainRegistry({
      "agents/crab.md": "---\nversion: beta\nauthority: standard\nskills:\n  - '*'\ndescription: d\n---\np\n",
    });

    await updateAgent(
      { name: "crab", authority: "standard", description: "d2", skills: ["*"], systemPrompt: "p" },
      { registryDir, registryMode: "purely-local" },
    );

    expect(loadRegistry(registryDir, "purely-local").agents.crab!.version).toBe("1");
  });
});

describe("updateAgent: checkout の位置に依存しない書き込み(ADR 0052 決定6 / issue #210)", () => {
  it("registry クローンが registry-edit タスクのブランチに居ても、編集がリモート main へ着地する", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");

    await updateAgent(
      {
        name: "deckhand",
        authority: "standard",
        description: "Rewritten description",
        skills: ["@workspace"],
        systemPrompt: "You are Deckhand, rewritten.",
      },
      { registryDir, registryMode: "remote-backed" },
    );

    expect(loadRegistry(registryDir, "remote-backed").agents.deckhand?.description).toBe(
      "Rewritten description",
    );
    expect(git(registryDir, "log", "-1", "--format=%s", "refs/remotes/origin/main")).toBe(
      "update agent deckhand via WebUI",
    );
    expect(git(registryDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/registry-edit-1");
  });

  it("push が失敗すると致命 — リモートに編集が残らない(ADR 0052 決定1)", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "remote", "set-url", "--push", "origin", "/no/such/remote");
    const before = git(registryDir, "rev-parse", "refs/remotes/origin/main");

    await expect(
      updateAgent(
        {
          name: "deckhand",
          authority: "standard",
          description: "Rewritten description",
          skills: ["@workspace"],
          systemPrompt: "You are Deckhand, rewritten.",
        },
        { registryDir, registryMode: "remote-backed" },
      ),
    ).rejects.toThrow(RegistryPushFailedError);

    expect(git(registryDir, "rev-parse", "refs/remotes/origin/main")).toBe(before);
    expect(loadRegistry(registryDir, "remote-backed").agents.deckhand?.description).not.toBe(
      "Rewritten description",
    );
  });
});

describe("updateAgent: no-change 編集(issue #70 — workspace-create の porcelain チェックの agent 版)", () => {
  it("空白だけの advisor を未設定へ戻すと frontmatter から消し、実効構成の変更として version を進める(issue #175)", async () => {
    const registryDir = await makeMainRegistry({
      "agents/crab.md": "---\nversion: 3\nauthority: standard\nskills:\n  - '*'\ndescription: d\nadvisor: opus\n---\np\n",
    });

    await updateAgent(
      {
        name: "crab",
        authority: "standard",
        description: "d",
        advisor: "  \t ",
        skills: ["*"],
        systemPrompt: "p",
      },
      { registryDir, registryMode: "purely-local" },
    );

    expect(loadRegistry(registryDir, "purely-local").agents.crab).toMatchObject({ version: "4", advisor: undefined });
    // registryDir 自身の working tree ではなく着地先の ref から読む(ADR 0052 決定6)
    expect(git(registryDir, "show", "main:agents/crab.md")).not.toContain("advisor:");
  });

  it("実効フィールドが不変な再送はコミットなしの成功で、version も上がらない", async () => {
    const registryDir = await makeMainRegistry();
    // fixture の deckhand と同一内容(version は入力に存在しない)
    const same = {
      name: "deckhand",
      authority: "standard",
      description: "General work agent for the tidepool board",
      skills: ["*"],
      systemPrompt:
        "You are Deckhand, the tidepool board's general work agent.\nWork only through the tidepool MCP verbs.",
    };
    const before = git(registryDir, "rev-parse", "HEAD");

    await updateAgent(same, { registryDir, registryMode: "purely-local" });

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").agents.deckhand!.version).toBe("0.3.1");
  });

  it("末尾改行付き systemPrompt の再送も no-change — parseAgentFile が trim して読む以上、外側の空白は保存されない正規形で比較する", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await updateAgent(
      {
        name: "deckhand",
        authority: "standard",
        description: "General work agent for the tidepool board",
        skills: ["*"],
        systemPrompt:
          "You are Deckhand, the tidepool board's general work agent.\nWork only through the tidepool MCP verbs.\n",
      },
      { registryDir, registryMode: "purely-local" },
    );

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").agents.deckhand!.version).toBe("0.3.1");
  });
});

describe("updateAgent: authority 検証(issue #70 — 編集でも既存プロファイルのみ)", () => {
  it("registry にないプロファイル名への付け替えは拒否され、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      updateAgent(
        { name: "deckhand", authority: "no-such-profile", description: "d", skills: ["*"], systemPrompt: "p" },
        { registryDir, registryMode: "purely-local" },
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
        { name: "ghost", authority: "standard", description: "d", skills: ["*"], systemPrompt: "p" },
        { registryDir, registryMode: "purely-local" },
      ),
    ).rejects.toThrow(UnknownAgentError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").agents.ghost).toBeUndefined();
  });
});
