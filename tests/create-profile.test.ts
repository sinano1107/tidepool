import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createProfile, listProfileViews, ProfileConfirmationRequiredError } from "../src/profile-create.js";
import { InvalidAuthorityProfileNameError, loadRegistry } from "../src/registry.js";
import { RegistryFetchFailedError, RegistryPushFailedError } from "../src/registry-write.js";
import { makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

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
        // 危険な値を含むペイロードなので確認が要る(ADR 0061 決定1)— この
        // テストの主題はラウンドトリップで、門そのものは別 describe が見る
        confirmDangerous: true,
      },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    const profile = loadRegistry(registryDir, "purely-local").authority.risky;
    expect(profile).toEqual({
      name: "risky",
      guidance: "Prefer reversible actions.\nAnything irreversible is outside your authority.",
      assignable_to: ["deckhand", "tako"],
      allowed_workspaces: ["tidepool"],
      merge: "auto_if_ci_green",
    });
    // 手編集(帯域外)ではなくコミット済み — ADR 0020 の読み取り規律と両立する。
    // registryDir 自身の working tree は checkout ではなく着地先の ref だけを見る
    // (ADR 0052 決定6: clone の working tree は正本ではないので触れない)
    expect(git(registryDir, "log", "-1", "--format=%an")).toBe("tidepool");
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe("create authority profile risky via WebUI");
  });

  it("merge: external も他の2値と同じくファイルに書かれ、ラウンドトリップで戻る(ADR 0079: 省略の口は無い)", async () => {
    const registryDir = await makeMainRegistry();

    await createProfile(
      {
        name: "readonly",
        guidance: "Read-only work.",
        assignable_to: ["*"],
        allowed_workspaces: ["*"],
        merge: "external",
        confirmDangerous: true,
      },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    // ADR 0052 決定6: 書き込みは使い捨て worktree の中で起こる — registryDir 自身
    // の working tree ではなく着地先の ref から読む(loadRegistry と同じ規律)
    const raw = git(registryDir, "show", "main:authority/readonly.yaml");
    expect(raw).toContain("merge: external");
    expect(raw).not.toContain("name");
    const profile = loadRegistry(registryDir, "purely-local").authority.readonly;
    expect(profile).toEqual({
      name: "readonly",
      guidance: "Read-only work.",
      assignable_to: ["*"],
      allowed_workspaces: ["*"],
      merge: "external",
    });
  });
});

describe("createProfile: name 検証(issue #76 — assertValidAgentName と同型の入口ゲート)", () => {
  const base = {
    guidance: "g",
    assignable_to: ["*"],
    allowed_workspaces: ["*"],
    merge: "escalate" as const,
  };

  it.each(["../escape", "a/b", "", ".", ".."])(
    "charset 外・予約名 %j は InvalidAuthorityProfileNameError で拒否され、コミットを積まない",
    async (name) => {
      const registryDir = await makeMainRegistry();
      const before = git(registryDir, "rev-parse", "HEAD");

      await expect(createProfile({ ...base, name }, { registry: { dir: registryDir, mode: "purely-local" } })).rejects.toThrow(
        InvalidAuthorityProfileNameError,
      );
      expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    },
  );

  it("registry に既にあるプロファイル名は拒否され、既存定義を上書きしない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      createProfile({ ...base, name: "standard" }, { registry: { dir: registryDir, mode: "purely-local" } }),
    ).rejects.toThrow(InvalidAuthorityProfileNameError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    // fixture の standard はそのまま(assignable_to は "*" のみ)
    expect(loadRegistry(registryDir, "purely-local").authority.standard!.assignable_to).toEqual(["*"]);
  });
});

describe("createProfile: checkout の位置に依存しない書き込み(ADR 0052 決定6 / issue #210)", () => {
  const input = {
    name: "risky",
    guidance: "g",
    assignable_to: ["*"],
    allowed_workspaces: ["*"],
    merge: "escalate" as const,
    confirmDangerous: true,
  };

  it("registry クローンが registry-edit タスクのブランチに居ても、リモート main へコミットが着地する", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");

    await createProfile(input, { registry: { dir: registryDir, mode: "remote-backed" } });

    expect(loadRegistry(registryDir, "remote-backed").authority.risky).toBeDefined();
    expect(git(registryDir, "log", "-1", "--format=%s", "refs/remotes/origin/main")).toBe(
      "create authority profile risky via WebUI",
    );
    expect(git(registryDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/registry-edit-1");
  });

  it("push が失敗すると致命 — リモートにもコミットが残らない", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "remote", "set-url", "--push", "origin", "/no/such/remote");
    const before = git(registryDir, "rev-parse", "refs/remotes/origin/main");

    await expect(
      createProfile(input, { registry: { dir: registryDir, mode: "remote-backed" } }),
    ).rejects.toThrow(RegistryPushFailedError);

    expect(git(registryDir, "rev-parse", "refs/remotes/origin/main")).toBe(before);
    expect(loadRegistry(registryDir, "remote-backed").authority.risky).toBeUndefined();
  });

  it("入口の fetch が失敗すると致命 — コミットを一切積まない", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "remote", "set-url", "origin", "/no/such/remote");

    await expect(
      createProfile(input, { registry: { dir: registryDir, mode: "remote-backed" } }),
    ).rejects.toThrow(RegistryFetchFailedError);

    expect(loadRegistry(registryDir, "remote-backed").authority.risky).toBeUndefined();
  });

  it("純ローカル registry(remote なし)でも、タスクブランチに居る状態から書き込みが通る", async () => {
    const registryDir = await makeMainRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");

    await createProfile(input, { registry: { dir: registryDir, mode: "purely-local" } });

    expect(loadRegistry(registryDir, "purely-local").authority.risky).toBeDefined();
    expect(git(registryDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/registry-edit-1");
  });
});

describe("listProfileViews: 編集フォーム用の一覧(issue #76 — listAgentViews と同型)", () => {
  it("registry の全プロファイルを全フィールドで返す", async () => {
    const registryDir = await makeMainRegistry();
    await createProfile(
      { name: "risky", guidance: "g", assignable_to: ["*"], allowed_workspaces: ["*"], merge: "external", confirmDangerous: true },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    const views = listProfileViews({ registry: { dir: registryDir, mode: "purely-local" } });

    expect(views.map((v) => v.name).sort()).toEqual(["risky", "standard"]);
    expect(views.find((v) => v.name === "risky")).toEqual({
      name: "risky",
      guidance: "g",
      assignable_to: ["*"],
      allowed_workspaces: ["*"],
      merge: "external",
    });
  });
});

describe("createProfile: 危険な値の確認(ADR 0061 決定1 — 執行はドメイン側に1つ)", () => {
  const DANGEROUS = {
    name: "risky",
    guidance: "g",
    assignable_to: ["*"],
    allowed_workspaces: ["tidepool"],
    merge: "escalate" as const,
  };

  it("confirmDangerous なしは拒否され、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      createProfile(DANGEROUS, { registry: { dir: registryDir, mode: "purely-local" } }),
    ).rejects.toThrow(ProfileConfirmationRequiredError);

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").authority.risky).toBeUndefined();
  });

  it("拒否は理由コードを構造化フィールドと本文の両方で運ぶ", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      createProfile(
        { ...DANGEROUS, merge: "auto_if_ci_green" },
        { registry: { dir: registryDir, mode: "purely-local" } },
      ),
    ).rejects.toMatchObject({
      name: "ProfileConfirmationRequiredError",
      reasons: ["merge_auto_if_ci_green", "assignable_to_wildcard"],
      message: expect.stringContaining("merge_auto_if_ci_green"),
    });
  });

  it("confirmDangerous: true なら保存される — フラグはファイルに書かれない", async () => {
    const registryDir = await makeMainRegistry();

    await createProfile(
      { ...DANGEROUS, confirmDangerous: true },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    expect(loadRegistry(registryDir, "purely-local").authority.risky).toEqual({
      name: "risky",
      guidance: "g",
      assignable_to: ["*"],
      allowed_workspaces: ["tidepool"],
      merge: "escalate",
    });
  });

  it("不正な名前は confirm では買えない — 危険な値より先に名前で弾く(ADR 0061 根拠5)", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      createProfile({ ...DANGEROUS, name: "../escape" }, { registry: { dir: registryDir, mode: "purely-local" } }),
    ).rejects.toThrow(InvalidAuthorityProfileNameError);
  });
});
