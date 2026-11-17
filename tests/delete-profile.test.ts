import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { deleteProfile } from "../src/profile-create.js";
import { loadRegistry } from "../src/registry.js";
import { DeletionConfirmationRequiredError } from "../src/registry-write.js";
import { makeRegistry } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** create-profile.test.ts と同じ理由で fixture を main に正規化する。 */
async function makeMainRegistry(): Promise<string> {
  // どの agent も authority で指していない profile を1つ足す —— fixture 既定の
  // `standard` は deckhand が参照しており、参照中の profile は消せない(ADR 0087 決定2)
  const dir = await makeRegistry({
    "authority/unused.yaml": "guidance: nobody points here\nassignable_to: []\nallowed_workspaces: []\nmerge: escalate\n",
  });
  git(dir, "branch", "-M", "main");
  return dir;
}

describe("deleteProfile: 正常系(issue #205 / ADR 0087 決定1)", () => {
  it("authority/<name>.yaml を committed main から除去するコミットが着地し、loadRegistry から消える", async () => {
    const registryDir = await makeMainRegistry();

    await deleteProfile(
      { name: "unused", confirm: true },
      { registry: { dir: registryDir, mode: "purely-local" } },
    );

    expect(loadRegistry(registryDir, "purely-local").authority.unused).toBeUndefined();
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe(
      "delete authority profile unused via WebUI",
    );
  });
});

describe("deleteProfile: 確認の門(issue #205 / ADR 0087)", () => {
  it("confirm なしの削除要求は拒まれ、ファイルは残る", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      deleteProfile({ name: "unused" }, { registry: { dir: registryDir, mode: "purely-local" } }),
    ).rejects.toThrow(DeletionConfirmationRequiredError);

    expect(loadRegistry(registryDir, "purely-local").authority.unused).toBeDefined();
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("deleteProfile: 確認で買えない拒否(ADR 0087 決定2)", () => {
  it("agent が authority で参照している profile は confirm があっても消せず、agent 名が理由に載る", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteProfile(
        { name: "standard", confirm: true },
        { registry: { dir: registryDir, mode: "purely-local" } },
      ),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "referenced_by_agents", agents: ["deckhand"] }],
    });

    expect(loadRegistry(registryDir, "purely-local").authority.standard).toBeDefined();
  });
});
