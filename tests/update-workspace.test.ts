import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRegistry } from "../src/registry.js";
import {
  listWorkspaceViews,
  RegistrySelfUnprotectError,
  UnprotectNeedsConfirmationError,
  updateWorkspace,
} from "../src/workspace-create.js";
import { makeRegistry } from "./registry-fixture.js";

/** protected な一般 workspace を1つ足した fixture。 */
const WORKSPACES_WITH_PROTECTED = `tidepool:
  path: /home/pi/work/tidepool
lagoon:
  path: /home/pi/work/lagoon
  protected: true
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** createWorkspace 側のテストと同じ正規化 — fixture を main に。 */
async function makeMainRegistry(): Promise<string> {
  const dir = await makeRegistry();
  git(dir, "branch", "-M", "main");
  return dir;
}

async function makeDeps(registryDir: string) {
  return {
    registryDir,
    registryMode: "purely-local" as const,
    workspacesBaseDir: await mkdtemp(join(tmpdir(), "tidepool-ws-base-")),
  };
}

describe("updateWorkspace: notes / protected の編集(issue #57 フェーズ3)", () => {
  it("notes の変更が Tidepool 名義で registry にコミットされる", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    const result = await updateWorkspace(
      { name: "tidepool", notes: "the registry clone itself" },
      deps,
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool?.notes).toBe(
      "the registry clone itself",
    );
    expect(git(registryDir, "log", "-1", "--format=%an %s")).toBe(
      "tidepool update workspace tidepool via WebUI",
    );
    expect(result.pushed).toBe(false);
  });

  it("protected の付与は confirm なしで通る(付けるのは安全方向、issue #57)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    await updateWorkspace({ name: "tidepool", protected: true }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool?.protected).toBe(true);
  });

  it("protected の解除は confirm がなければ拒否され、コミットを積まない(#55 と同型の確認ステップ)", async () => {
    const registryDir = await makeRegistry({ "workspaces.yaml": WORKSPACES_WITH_PROTECTED });
    git(registryDir, "branch", "-M", "main");
    const before = git(registryDir, "rev-parse", "HEAD");
    const deps = await makeDeps(registryDir);

    await expect(updateWorkspace({ name: "lagoon", protected: false }, deps)).rejects.toThrow(
      UnprotectNeedsConfirmationError,
    );
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon?.protected).toBe(true);
  });

  it("protected の解除は confirm: true で通り、エントリから protected が消える", async () => {
    const registryDir = await makeRegistry({ "workspaces.yaml": WORKSPACES_WITH_PROTECTED });
    git(registryDir, "branch", "-M", "main");
    const deps = await makeDeps(registryDir);

    await updateWorkspace({ name: "lagoon", protected: false, confirm: true }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({
      path: "/home/pi/work/lagoon",
    });
  });

  it("変更ゼロの更新(同値の notes)は失敗にならず、コミットも積まない(/code-review 指摘: no-op PATCH が 502 に見える穴)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const before = git(registryDir, "rev-parse", "HEAD");

    // fixture の tidepool エントリは notes を既に持つ — 同じ値を送る
    const result = await updateWorkspace(
      { name: "tidepool", notes: "run npm install before first use" },
      deps,
    );

    expect(result.pushed).toBe(false);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("盤面自身の registry クローンを指すエントリの解除は confirm があっても拒否される(ADR 0013: 自己防衛をワンクリック圏内に置かない)", async () => {
    const registryDir = await makeMainRegistry();
    // 自分自身を workspace として登録している(v1 の実運用と同じ形)
    await writeFile(
      join(registryDir, "workspaces.yaml"),
      `registry:\n  path: ${registryDir}\n  protected: true\n`,
    );
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-am", "self"],
      { cwd: registryDir },
    );
    const deps = await makeDeps(registryDir);

    await expect(
      updateWorkspace({ name: "registry", protected: false, confirm: true }, deps),
    ).rejects.toThrow(RegistrySelfUnprotectError);
    expect(loadRegistry(registryDir, "purely-local").workspaces.registry?.protected).toBe(true);
  });

  it("いま未保護でも registry 自身への protected: false は拒否される — 床が現在のフラグ値に依存しない(/code-review 指摘)", async () => {
    const registryDir = await makeMainRegistry();
    await writeFile(
      join(registryDir, "workspaces.yaml"),
      `registry:\n  path: ${registryDir}\n`,
    );
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-am", "self"],
      { cwd: registryDir },
    );
    const deps = await makeDeps(registryDir);

    await expect(
      updateWorkspace({ name: "registry", protected: false, confirm: true }, deps),
    ).rejects.toThrow(RegistrySelfUnprotectError);
  });
});

describe("listWorkspaceViews: 設定面の一覧(issue #57 フェーズ3)", () => {
  it("各エントリの表示用ビューを返し、盤面自身の registry クローンを指すエントリだけ registrySelf が立つ", async () => {
    const registryDir = await makeMainRegistry();
    await writeFile(
      join(registryDir, "workspaces.yaml"),
      `registry:\n  path: ${registryDir}\n  protected: true\nlagoon:\n  repo: https://github.com/example/lagoon.git\n  branch: trunk\n  notes: run npm install\n`,
    );
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-am", "self"],
      { cwd: registryDir },
    );

    const views = listWorkspaceViews(await makeDeps(registryDir));

    expect(views).toEqual([
      { name: "registry", path: registryDir, protected: true, registrySelf: true },
      {
        name: "lagoon",
        repo: "https://github.com/example/lagoon.git",
        branch: "trunk",
        notes: "run npm install",
        registrySelf: false,
      },
    ]);
  });
});
