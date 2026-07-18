import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProfile, listProfileViews } from "../src/profile-create.js";
import { InvalidAuthorityProfileNameError, loadRegistry } from "../src/registry.js";
import { RegistryCloneBusyError } from "../src/registry-write.js";
import { makeRegistry } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** registry クローンのブランチ名をホストの init.defaultBranch 設定に依存させ
 *  ない — ADR 0020 の「main はコード定数」に合わせ、fixture を main に正規化
 *  (create-agent.test.ts と同じ理由)。 */
async function makeMainRegistry(): Promise<string> {
  const dir = await makeRegistry();
  git(dir, "branch", "-M", "main");
  return dir;
}

describe("createProfile: 正常系(issue #76)", () => {
  it("authority/<name>.yaml が Tidepool 名義でコミットされ、loadRegistry が全フィールドを返す(ラウンドトリップ、merge 含む)", async () => {
    const registryDir = await makeMainRegistry();

    await createProfile(
      {
        name: "risky",
        guidance: "Prefer reversible actions.\nAnything irreversible is outside your authority.",
        assignable_to: ["deckhand", "tako"],
        allowed_workspaces: ["tidepool"],
        merge: "auto_if_ci_green",
      },
      { registryDir },
    );

    const profile = loadRegistry(registryDir).authority.risky;
    expect(profile).toEqual({
      name: "risky",
      guidance: "Prefer reversible actions.\nAnything irreversible is outside your authority.",
      assignable_to: ["deckhand", "tako"],
      allowed_workspaces: ["tidepool"],
      merge: "auto_if_ci_green",
    });
    // 手編集(帯域外)ではなくコミット済み — ADR 0020 の読み取り規律と両立する
    expect(git(registryDir, "status", "--porcelain")).toBe("");
    expect(git(registryDir, "log", "-1", "--format=%an")).toBe("tidepool");
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe("create authority profile risky via WebUI");
  });

  it("merge を省略すると frontmatter にキー自体が現れず、ラウンドトリップでも undefined のまま", async () => {
    const registryDir = await makeMainRegistry();

    await createProfile(
      {
        name: "readonly",
        guidance: "Read-only work.",
        assignable_to: ["*"],
        allowed_workspaces: ["*"],
      },
      { registryDir },
    );

    const raw = readFileSync(join(registryDir, "authority", "readonly.yaml"), "utf8");
    expect(raw).not.toContain("merge");
    expect(raw).not.toContain("name");
    const profile = loadRegistry(registryDir).authority.readonly;
    expect(profile).toEqual({
      name: "readonly",
      guidance: "Read-only work.",
      assignable_to: ["*"],
      allowed_workspaces: ["*"],
      merge: undefined,
    });
  });
});

describe("createProfile: name 検証(issue #76 — assertValidAgentName と同型の入口ゲート)", () => {
  const base = {
    guidance: "g",
    assignable_to: ["*"],
    allowed_workspaces: ["*"],
  };

  it.each(["../escape", "a/b", "", ".", ".."])(
    "charset 外・予約名 %j は InvalidAuthorityProfileNameError で拒否され、コミットを積まない",
    async (name) => {
      const registryDir = await makeMainRegistry();
      const before = git(registryDir, "rev-parse", "HEAD");

      await expect(createProfile({ ...base, name }, { registryDir })).rejects.toThrow(
        InvalidAuthorityProfileNameError,
      );
      expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    },
  );

  it("registry に既にあるプロファイル名は拒否され、既存定義を上書きしない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      createProfile({ ...base, name: "standard" }, { registryDir }),
    ).rejects.toThrow(InvalidAuthorityProfileNameError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    // fixture の standard はそのまま(assignable_to は "*" のみ)
    expect(loadRegistry(registryDir).authority.standard!.assignable_to).toEqual(["*"]);
  });
});

describe("createProfile: registry コミットの前提条件(ADR 0020 — agent-create.ts と共有の検査)", () => {
  const input = { name: "risky", guidance: "g", assignable_to: ["*"], allowed_workspaces: ["*"] };

  it("registry クローンの HEAD が main 以外なら RegistryCloneBusyError で失敗し、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");

    await expect(createProfile(input, { registryDir })).rejects.toThrow(RegistryCloneBusyError);
    expect(git(registryDir, "log", "--format=%s", "task/registry-edit-1")).toBe(
      "registry fixture",
    );
  });

  it("registry クローンが dirty なら失敗し、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");
    writeFileSync(join(registryDir, "workspaces.yaml"), "[:::invalid yaml", { flag: "a" });

    await expect(createProfile(input, { registryDir })).rejects.toThrow(RegistryCloneBusyError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("createProfile: registry への push(issue #76 — ベストエフォート)", () => {
  const input = { name: "risky", guidance: "g", assignable_to: ["*"], allowed_workspaces: ["*"] };

  it("origin リモートがあれば registry コミットが push され、pushed: true", async () => {
    const registryDir = await makeMainRegistry();
    const bare = await mkdtemp(join(tmpdir(), "tidepool-registry-origin-"));
    git(bare, "init", "--bare");
    git(registryDir, "remote", "add", "origin", bare);
    git(registryDir, "push", "-u", "origin", "main");

    const result = await createProfile(input, { registryDir });

    expect(result.pushed).toBe(true);
    expect(git(bare, "log", "-1", "--format=%s", "main")).toBe(
      "create authority profile risky via WebUI",
    );
  });

  it("push の失敗は非致命 — コミットは成功し、pushed: false と警告ログだけが残る", async () => {
    const registryDir = await makeMainRegistry();
    git(registryDir, "remote", "add", "origin", "/no/such/remote");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await createProfile(input, { registryDir });

      expect(result.pushed).toBe(false);
      expect(loadRegistry(registryDir).authority.risky).toBeDefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("push");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("listProfileViews: 編集フォーム用の一覧(issue #76 — listAgentViews と同型)", () => {
  it("registry の全プロファイルを全フィールドで返す", async () => {
    const registryDir = await makeMainRegistry();
    await createProfile(
      { name: "risky", guidance: "g", assignable_to: ["*"], allowed_workspaces: ["*"] },
      { registryDir },
    );

    const views = listProfileViews({ registryDir });

    expect(views.map((v) => v.name).sort()).toEqual(["risky", "standard"]);
    expect(views.find((v) => v.name === "risky")).toEqual({
      name: "risky",
      guidance: "g",
      assignable_to: ["*"],
      allowed_workspaces: ["*"],
      merge: undefined,
    });
  });
});
