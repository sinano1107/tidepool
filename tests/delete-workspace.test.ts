import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRegistry } from "../src/registry.js";
import { DeletionConfirmationRequiredError } from "../src/registry-write.js";
import { deleteWorkspace, RegistrySelfDeleteError } from "../src/workspace-create.js";
import { makeRegistry } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

async function makeMainRegistry(): Promise<string> {
  const dir = await makeRegistry();
  git(dir, "branch", "-M", "main");
  return dir;
}

/** 参照ゼロ・既定でもない盤面の事実。 */
const NO_REFERENCES = { unsettledTaskCount: 0 };

describe("deleteWorkspace: 正常系(issue #205 / ADR 0087 決定1・決定4)", () => {
  it("workspaces.yaml からエントリを除去するコミットが着地し、残る checkout の場所を返す", async () => {
    const registryDir = await makeMainRegistry();

    const checkout = await deleteWorkspace(
      { name: "tidepool", confirm: true },
      {
        registry: { dir: registryDir, mode: "purely-local" },
        workspacesBaseDir: "/workspaces",
        ...NO_REFERENCES,
      },
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeUndefined();
    expect(git(registryDir, "log", "-1", "--format=%s")).toBe("delete workspace tidepool via WebUI");
    // ADR 0087 決定4: ホスト上の checkout は触らない —— 応答が場所を名指しする
    expect(checkout).toBe("/home/pi/work/tidepool");
  });
});

describe("deleteWorkspace: 確認の門(issue #205 / ADR 0087)", () => {
  it("confirm なしの削除要求は拒まれ、エントリは残る", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      deleteWorkspace(
        { name: "tidepool" },
        {
          registry: { dir: registryDir, mode: "purely-local" },
          workspacesBaseDir: "/workspaces",
          ...NO_REFERENCES,
        },
      ),
    ).rejects.toThrow(DeletionConfirmationRequiredError);

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeDefined();
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("deleteWorkspace: 確認で買えない拒否(ADR 0087 決定2/3)", () => {
  it("未決着タスクが参照していると confirm があっても消せず、件数が理由に載る", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteWorkspace(
        { name: "tidepool", confirm: true },
        {
          registry: { dir: registryDir, mode: "purely-local" },
          workspacesBaseDir: "/workspaces",
          unsettledTaskCount: 3,
        },
      ),
    ).rejects.toMatchObject({
      name: "DeletionBlockedError",
      reasons: [{ code: "unsettled_tasks", count: 3 }],
    });

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeDefined();
  });

  it("盤面の既定 workspace は confirm があっても消せない", async () => {
    const registryDir = await makeMainRegistry();

    await expect(
      deleteWorkspace(
        { name: "tidepool", confirm: true },
        {
          registry: { dir: registryDir, mode: "purely-local" },
          workspacesBaseDir: "/workspaces",
          ...NO_REFERENCES,
          defaultWorkspaceName: "tidepool",
        },
      ),
    ).rejects.toMatchObject({ name: "DeletionBlockedError", reasons: [{ code: "board_default" }] });
  });

  it("profile の allowed_workspaces に列挙されているだけの workspace は消せる(ADR 0087 決定2)", async () => {
    const registryDir = await makeRegistry({
      "authority/standard.yaml":
        "guidance: lists tidepool as an allowed workspace\nassignable_to: []\nallowed_workspaces:\n  - tidepool\nmerge: escalate\n",
    });
    git(registryDir, "branch", "-M", "main");

    await deleteWorkspace(
      { name: "tidepool", confirm: true },
      {
        registry: { dir: registryDir, mode: "purely-local" },
        workspacesBaseDir: "/workspaces",
        ...NO_REFERENCES,
      },
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toBeUndefined();
    // 掃除は不要 —— 許可先が1つ消えるだけで無害である
    expect(
      loadRegistry(registryDir, "purely-local").authority.standard?.allowed_workspaces,
    ).toEqual(["tidepool"]);
  });

  it("盤面自身の registry clone は永久に消せない(RegistrySelfDeleteError)", async () => {
    const registryDir = await makeMainRegistry();
    // registry clone 自身を workspace として登録した状態(ADR 0052 決定3)
    writeFileSync(join(registryDir, "workspaces.yaml"), `registry:\n  path: ${registryDir}\n`);
    git(registryDir, "add", "-A");
    git(registryDir, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "register self");

    await expect(
      deleteWorkspace(
        { name: "registry", confirm: true },
        {
          registry: { dir: registryDir, mode: "purely-local" },
          workspacesBaseDir: "/workspaces",
          ...NO_REFERENCES,
        },
      ),
    ).rejects.toThrow(RegistrySelfDeleteError);
  });
});
