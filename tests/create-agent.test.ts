import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgent,
  InvalidAgentIconError,
  listAgentViews,
  UnknownAuthorityProfileError,
} from "../src/agent-create.js";
import { InvalidAgentNameError, InvalidSkillAllowlistError, loadRegistry } from "../src/registry.js";
import { RegistryCloneBusyError } from "../src/registry-write.js";
import { makeRegistry } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** registry クローンのブランチ名をホストの init.defaultBranch 設定に依存させ
 *  ない — ADR 0020 の「main はコード定数」に合わせ、fixture を main に正規化。 */
async function makeMainRegistry(): Promise<string> {
  const dir = await makeRegistry();
  git(dir, "branch", "-M", "main");
  return dir;
}

describe("createAgent: 正常系(issue #70)", () => {
  it("agents/<name>.md が Tidepool 名義でコミットされ、loadRegistry が全フィールドを返す(ラウンドトリップ)", async () => {
    const registryDir = await makeMainRegistry();

    await createAgent(
      {
        name: "tako",
        authority: "standard",
        description: "General work agent for the tidepool board",
        icon: "🐙",
        model: "claude-sonnet-5",
        effort: "high",
        advisor: "opus",
        skills: ["@workspace"],
        systemPrompt: "You are Tako, the tidepool board's general work agent.\nBe kind.",
      },
      { registryDir, registryMode: "purely-local" },
    );

    const agent = loadRegistry(registryDir, "purely-local").agents.tako;
    expect(agent).toEqual({
      name: "tako",
      // 作成時の version は機械刻印 — 呼び出し側は渡せない(入力型に version がない)
      version: "1",
      authority: "standard",
      description: "General work agent for the tidepool board",
      icon: "🐙",
      model: "claude-sonnet-5",
      effort: "high",
      advisor: "opus",
      skills: ["@workspace"],
      systemPrompt: "You are Tako, the tidepool board's general work agent.\nBe kind.",
    });
    // 手編集(帯域外)ではなくコミット済み — ADR 0020 の読み取り規律と両立する
    expect(git(registryDir, "status", "--porcelain")).toBe("");
    expect(git(registryDir, "log", "-1", "--format=%an")).toBe("tidepool");
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe("create agent tako via WebUI");
  });

  it("icon/model/effort/advisor を省略すると frontmatter にキー自体が現れず、ラウンドトリップでも undefined のまま", async () => {
    const registryDir = await makeMainRegistry();

    await createAgent(
      {
        name: "hermit",
        authority: "standard",
        description: "Minimal agent",
        skills: ["*"],
        systemPrompt: "You are Hermit.",
      },
      { registryDir, registryMode: "purely-local" },
    );

    const raw = readFileSync(join(registryDir, "agents", "hermit.md"), "utf8");
    expect(raw).not.toContain("icon");
    expect(raw).not.toContain("model");
    expect(raw).not.toContain("effort");
    expect(raw).not.toContain("advisor");
    const agent = loadRegistry(registryDir, "purely-local").agents.hermit;
    expect(agent).toEqual({
      name: "hermit",
      version: "1",
      authority: "standard",
      description: "Minimal agent",
      icon: undefined,
      model: undefined,
      effort: undefined,
      advisor: undefined,
      skills: ["*"],
      systemPrompt: "You are Hermit.",
    });
  });
});

describe("createAgent: name 検証(issue #70 — assertValidWorkspaceName と同型の入口ゲート)", () => {
  const base = {
    authority: "standard",
    description: "d",
    skills: ["*"],
    systemPrompt: "p",
  };

  it.each(["../escape", "a/b", "", ".", ".."])(
    "charset 外・予約名 %j は InvalidAgentNameError で拒否され、コミットを積まない",
    async (name) => {
      const registryDir = await makeMainRegistry();
      const before = git(registryDir, "rev-parse", "HEAD");

      await expect(createAgent({ ...base, name }, { registryDir, registryMode: "purely-local" })).rejects.toThrow(
        InvalidAgentNameError,
      );
      expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    },
  );

  it("registry に既にあるエージェント名は拒否され、既存定義を上書きしない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      createAgent({ ...base, name: "deckhand" }, { registryDir, registryMode: "purely-local" }),
    ).rejects.toThrow(InvalidAgentNameError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    // fixture の deckhand はそのまま
    expect(loadRegistry(registryDir, "purely-local").agents.deckhand!.version).toBe("0.3.1");
  });
});

describe("createAgent: authority 検証(issue #70 — 既存プロファイルからの選択のみ)", () => {
  it("registry にないプロファイル名は UnknownAuthorityProfileError で拒否され、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      createAgent(
        { name: "tako", authority: "no-such-profile", description: "d", skills: ["*"], systemPrompt: "p" },
        { registryDir, registryMode: "purely-local" },
      ),
    ).rejects.toThrow(UnknownAuthorityProfileError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("createAgent: registry コミットの前提条件(ADR 0020 — workspace 側と共有の検査)", () => {
  const input = { name: "tako", authority: "standard", description: "d", skills: ["*"], systemPrompt: "p" };

  it("registry クローンの HEAD が main 以外(registry-edit タスクのブランチ移動中)なら RegistryCloneBusyError で失敗し、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");

    await expect(createAgent(input, { registryDir, registryMode: "purely-local" })).rejects.toThrow(RegistryCloneBusyError);
    expect(git(registryDir, "log", "--format=%s", "task/registry-edit-1")).toBe(
      "registry fixture",
    );
  });

  it("registry クローンが dirty なら失敗し、コミットを積まない — 検査は loadRegistry より先(dirty が不正 yaml でも RegistryCloneBusyError)", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");
    writeFileSync(join(registryDir, "workspaces.yaml"), "[:::invalid yaml", { flag: "a" });

    await expect(createAgent(input, { registryDir, registryMode: "purely-local" })).rejects.toThrow(RegistryCloneBusyError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("createAgent: registry への push(issue #70 — ベストエフォート)", () => {
  const input = { name: "tako", authority: "standard", description: "d", skills: ["*"], systemPrompt: "p" };

  it("origin リモートがあれば registry コミットが push され、pushed: true", async () => {
    const registryDir = await makeMainRegistry();
    const bare = await mkdtemp(join(tmpdir(), "tidepool-registry-origin-"));
    git(bare, "init", "--bare");
    git(registryDir, "remote", "add", "origin", bare);
    git(registryDir, "push", "-u", "origin", "main");

    const result = await createAgent(input, { registryDir, registryMode: "purely-local" });

    expect(result.pushed).toBe(true);
    expect(git(bare, "log", "-1", "--format=%s", "main")).toBe("create agent tako via WebUI");
  });

  it("push の失敗は非致命 — コミットは成功し、pushed: false と警告ログだけが残る", async () => {
    const registryDir = await makeMainRegistry();
    git(registryDir, "remote", "add", "origin", "/no/such/remote");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await createAgent(input, { registryDir, registryMode: "purely-local" });

      expect(result.pushed).toBe(false);
      expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeDefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("push");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createAgent: icon 検証(ADR 0026 — loadRegistry を壊す書き込みを入口で拒否)", () => {
  it.each(["ab", "🐙🐙", "🐙!"])(
    "単一 Twemoji グラフィムでない icon %j は拒否され、registry は読める状態のまま",
    async (icon) => {
      const registryDir = await makeMainRegistry();
      const before = git(registryDir, "rev-parse", "HEAD");

      await expect(
        createAgent(
          { name: "tako", authority: "standard", description: "d", icon, skills: ["*"], systemPrompt: "p" },
          { registryDir, registryMode: "purely-local" },
        ),
      ).rejects.toThrow(InvalidAgentIconError);
      expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
      // 不正 icon が書き込まれていれば loadRegistry ごと落ちる — それが起きていない
      expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeUndefined();
    },
  );
});

describe("createAgent: skills 検証(ADR 0025 — loadRegistry を壊す許可リストを入口で拒否)", () => {
  it.each([[["*", "code-review"]], [["@world"]], [["foo*"]]])(
    "文法違反の skills %j は InvalidSkillAllowlistError で拒否され、registry は読める状態のまま",
    async (skills) => {
      const registryDir = await makeMainRegistry();
      const before = git(registryDir, "rev-parse", "HEAD");

      await expect(
        createAgent(
          { name: "tako", authority: "standard", description: "d", skills, systemPrompt: "p" },
          { registryDir, registryMode: "purely-local" },
        ),
      ).rejects.toThrow(InvalidSkillAllowlistError);
      expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
      // 不正 allowlist が書き込まれていれば loadRegistry ごと落ちる — それが起きていない
      expect(loadRegistry(registryDir, "purely-local").agents.tako).toBeUndefined();
    },
  );
});

describe("listAgentViews: 編集フォーム用の一覧(issue #70)", () => {
  it("registry の全エージェントを systemPrompt 含む全フィールドで返す", async () => {
    const registryDir = await makeMainRegistry();
    await createAgent(
      { name: "tako", authority: "standard", description: "General agent", icon: "🐙", skills: ["*"], systemPrompt: "You are Tako." },
      { registryDir, registryMode: "purely-local" },
    );

    const views = listAgentViews({ registryDir, registryMode: "purely-local" });

    expect(views.map((v) => v.name).sort()).toEqual(["deckhand", "tako"]);
    expect(views.find((v) => v.name === "tako")).toEqual({
      name: "tako",
      version: "1",
      authority: "standard",
      description: "General agent",
      icon: "🐙",
      model: undefined,
      effort: undefined,
      skills: ["*"],
      systemPrompt: "You are Tako.",
    });
  });
});
