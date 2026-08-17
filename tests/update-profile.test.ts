import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { updateProfile } from "../src/profile-create.js";
import { loadRegistry, UnknownAuthorityProfileError } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** fixture を main に正規化(create-profile.test.ts と同じ理由: ADR 0020)。 */
async function makeMainRegistry(files: Record<string, string> = {}): Promise<string> {
  const dir = await makeRegistry(files);
  git(dir, "branch", "-M", "main");
  return dir;
}

describe("updateProfile: 正常系(issue #76 — ファイル全体の書き直し)", () => {
  it("渡したフィールドで全書き換えされ、loadRegistry に反映される", async () => {
    const registryDir = await makeMainRegistry();

    await updateProfile(
      {
        name: "standard",
        guidance: "Rewritten guidance.",
        assignable_to: ["deckhand"],
        allowed_workspaces: ["tidepool"],
        merge: "escalate",
      },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    const profile = loadRegistry(registryDir, "purely-local").authority.standard;
    expect(profile).toEqual({
      name: "standard",
      guidance: "Rewritten guidance.",
      assignable_to: ["deckhand"],
      allowed_workspaces: ["tidepool"],
      merge: "escalate",
    });
    // registryDir 自身の working tree は checkout ではなく着地先の ref だけを見る
    // (ADR 0052 決定6)
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe(
      "update authority profile standard via WebUI",
    );
    expect(git(registryDir, "log", "-1", "--format=%an")).toBe("tidepool");
  });
});

describe("updateProfile: checkout の位置に依存しない書き込み(ADR 0052 決定6 / issue #210)", () => {
  it("registry クローンが registry-edit タスクのブランチに居ても、編集がリモート main へ着地する", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");

    await updateProfile(
      {
        name: "standard",
        guidance: "Rewritten guidance.",
        assignable_to: ["deckhand"],
        allowed_workspaces: ["tidepool"],
        merge: "escalate",
      },
      { registry: { dir: registryDir, mode: "remote-backed" } },
    );

    expect(loadRegistry(registryDir, "remote-backed").authority.standard?.guidance).toBe(
      "Rewritten guidance.",
    );
    expect(git(registryDir, "log", "-1", "--format=%s", "refs/remotes/origin/main")).toBe(
      "update authority profile standard via WebUI",
    );
    expect(git(registryDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/registry-edit-1");
  });

  it("push が失敗すると致命 — リモートに編集が残らない(ADR 0052 決定1)", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "remote", "set-url", "--push", "origin", "/no/such/remote");
    const before = git(registryDir, "rev-parse", "refs/remotes/origin/main");

    await expect(
      updateProfile(
        {
          name: "standard",
          guidance: "Rewritten guidance.",
          assignable_to: ["deckhand"],
          allowed_workspaces: ["tidepool"],
          merge: "escalate",
        },
        { registry: { dir: registryDir, mode: "remote-backed" } },
      ),
    ).rejects.toThrow(RegistryPushFailedError);

    expect(git(registryDir, "rev-parse", "refs/remotes/origin/main")).toBe(before);
    expect(loadRegistry(registryDir, "remote-backed").authority.standard?.guidance).not.toBe(
      "Rewritten guidance.",
    );
  });
});

describe("updateProfile: no-change 編集(issue #76 — updateAgent の porcelain チェックと同型)", () => {
  it("実効フィールドが不変な再送はコミットなしの成功", async () => {
    const registryDir = await makeMainRegistry();
    // fixture の standard と同一内容(AUTHORITY_WILDCARD 参照は registry-fixture.ts 参照)
    const same = {
      name: "standard",
      guidance: "Prefer reversible actions. Anything irreversible is outside your authority.\n",
      assignable_to: ["*"],
      allowed_workspaces: ["*"],
      merge: "external" as const,
    };
    const before = git(registryDir, "rev-parse", "HEAD");

    await updateProfile(same, { registry: { dir: registryDir, mode: "purely-local" } });

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("配列フィールドは中身の比較 — 同じ要素の再送はコミットなしの成功(参照比較のバグ回帰)", async () => {
    const registryDir = await makeMainRegistry({
      "authority/reviewer.yaml":
        "guidance: review only\nassignable_to:\n  - deckhand\n  - tako\nallowed_workspaces:\n  - tidepool\nmerge: escalate\n",
    });
    const before = git(registryDir, "rev-parse", "HEAD");

    await updateProfile(
      {
        name: "reviewer",
        guidance: "review only",
        assignable_to: ["deckhand", "tako"],
        allowed_workspaces: ["tidepool"],
        merge: "escalate",
      },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("assignable_to の中身だけが変われば(要素数は同じ)コミットする — 長さだけの比較への後退を防ぐ", async () => {
    const registryDir = await makeMainRegistry({
      "authority/reviewer.yaml":
        "guidance: review only\nassignable_to:\n  - deckhand\nallowed_workspaces:\n  - tidepool\nmerge: escalate\n",
    });
    const before = git(registryDir, "rev-parse", "HEAD");

    await updateProfile(
      {
        name: "reviewer",
        guidance: "review only",
        assignable_to: ["tako"],
        allowed_workspaces: ["tidepool"],
        merge: "escalate",
      },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    expect(git(registryDir, "rev-parse", "HEAD")).not.toBe(before);
    expect(loadRegistry(registryDir, "purely-local").authority.reviewer!.assignable_to).toEqual(["tako"]);
  });
});

describe("updateProfile: 部分パッチ(issue #266 / ADR 0086 — absent は触らない)", () => {
  const AUTO_MERGE_PROFILE = {
    "authority/roamer.yaml":
      "guidance: old guidance\nassignable_to:\n  - deckhand\nallowed_workspaces:\n  - tidepool\nmerge: auto_if_ci_green\n",
  };

  it("guidance だけのパッチは他の3フィールドを既存値のまま残す", async () => {
    const registryDir = await makeMainRegistry(AUTO_MERGE_PROFILE);

    await updateProfile(
      { name: "roamer", guidance: "new guidance" },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    // strict + 全フィールド必須の authorityProfileSchema を通って読み戻せること
    // 自体が「保存されたファイルは4キー揃っている」の証明(ADR 0079 決定1)
    expect(loadRegistry(registryDir, "purely-local").authority.roamer).toEqual({
      name: "roamer",
      guidance: "new guidance",
      assignable_to: ["deckhand"],
      allowed_workspaces: ["tidepool"],
      merge: "auto_if_ci_green",
    });
  });

  it("空パッチ(全フィールド absent)はコミットなしの成功", async () => {
    const registryDir = await makeMainRegistry(AUTO_MERGE_PROFILE);
    const before = git(registryDir, "rev-parse", "HEAD");

    await updateProfile({ name: "roamer" }, { registry: { dir: registryDir, mode: "purely-local" } });

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("空の値は値として保存される — guidance: \"\" は空文字、assignable_to: [] は「誰にも」", async () => {
    const registryDir = await makeMainRegistry(AUTO_MERGE_PROFILE);

    await updateProfile(
      { name: "roamer", guidance: "", assignable_to: [] },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    expect(loadRegistry(registryDir, "purely-local").authority.roamer).toEqual({
      name: "roamer",
      guidance: "",
      assignable_to: [],
      allowed_workspaces: ["tidepool"],
      merge: "auto_if_ci_green",
    });
  });

  it("既存値と同じ値を明示的に送ったパッチもコミットなしの成功", async () => {
    const registryDir = await makeMainRegistry(AUTO_MERGE_PROFILE);
    const before = git(registryDir, "rev-parse", "HEAD");

    await updateProfile(
      { name: "roamer", merge: "auto_if_ci_green" },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("updateProfile: 存在しないプロファイル(issue #76 — 編集は既存名のみ)", () => {
  it("registry にない名前は UnknownAuthorityProfileError で拒否され、ファイルもコミットも増えない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      updateProfile(
        { name: "ghost", guidance: "g", assignable_to: ["*"], allowed_workspaces: ["*"], merge: "escalate" },
        { registry: { dir: registryDir, mode: "purely-local" } },
      ),
    ).rejects.toThrow(UnknownAuthorityProfileError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").authority.ghost).toBeUndefined();
  });
});
