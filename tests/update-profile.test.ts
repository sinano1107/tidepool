import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { updateProfile } from "../src/profile-create.js";
import { loadRegistry, UnknownAuthorityProfileError } from "../src/registry.js";
import { makeRegistry } from "./registry-fixture.js";

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
      { registryDir, registryMode: "purely-local" },
    );

    const profile = loadRegistry(registryDir, "purely-local").authority.standard;
    expect(profile).toEqual({
      name: "standard",
      guidance: "Rewritten guidance.",
      assignable_to: ["deckhand"],
      allowed_workspaces: ["tidepool"],
      merge: "escalate",
    });
    expect(git(registryDir, "status", "--porcelain")).toBe("");
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe(
      "update authority profile standard via WebUI",
    );
    expect(git(registryDir, "log", "-1", "--format=%an")).toBe("tidepool");
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
    };
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(updateProfile(same, { registryDir, registryMode: "purely-local" })).resolves.toBeDefined();

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("配列フィールドは中身の比較 — 同じ要素の再送はコミットなしの成功(参照比較のバグ回帰)", async () => {
    const registryDir = await makeMainRegistry({
      "authority/reviewer.yaml":
        "guidance: review only\nassignable_to:\n  - deckhand\n  - tako\nallowed_workspaces:\n  - tidepool\n",
    });
    const before = git(registryDir, "rev-parse", "HEAD");

    await updateProfile(
      {
        name: "reviewer",
        guidance: "review only",
        assignable_to: ["deckhand", "tako"],
        allowed_workspaces: ["tidepool"],
      },
      { registryDir, registryMode: "purely-local" },
    );

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("assignable_to の中身だけが変われば(要素数は同じ)コミットする — 長さだけの比較への後退を防ぐ", async () => {
    const registryDir = await makeMainRegistry({
      "authority/reviewer.yaml":
        "guidance: review only\nassignable_to:\n  - deckhand\nallowed_workspaces:\n  - tidepool\n",
    });
    const before = git(registryDir, "rev-parse", "HEAD");

    await updateProfile(
      {
        name: "reviewer",
        guidance: "review only",
        assignable_to: ["tako"],
        allowed_workspaces: ["tidepool"],
      },
      { registryDir, registryMode: "purely-local" },
    );

    expect(git(registryDir, "rev-parse", "HEAD")).not.toBe(before);
    expect(loadRegistry(registryDir, "purely-local").authority.reviewer!.assignable_to).toEqual(["tako"]);
  });
});

describe("updateProfile: 存在しないプロファイル(issue #76 — 編集は既存名のみ)", () => {
  it("registry にない名前は UnknownAuthorityProfileError で拒否され、ファイルもコミットも増えない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      updateProfile(
        { name: "ghost", guidance: "g", assignable_to: ["*"], allowed_workspaces: ["*"] },
        { registryDir, registryMode: "purely-local" },
      ),
    ).rejects.toThrow(UnknownAuthorityProfileError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").authority.ghost).toBeUndefined();
  });
});
