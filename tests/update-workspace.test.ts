import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidReviewAllowedCommandError, loadRegistry } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import {
  listWorkspaceViews,
  RegistrySelfUnprotectError,
  updateWorkspace,
  WorkspaceConfirmationRequiredError,
} from "../src/workspace-create.js";
import { makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

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
async function makeMainRegistry(files?: Record<string, string>): Promise<string> {
  const dir = await makeRegistry(files);
  git(dir, "branch", "-M", "main");
  return dir;
}

async function makeDeps(registryDir: string) {
  return {
    registry: { dir: registryDir, mode: "purely-local" as const },
    workspacesBaseDir: await mkdtemp(join(tmpdir(), "tidepool-ws-base-")),
  };
}

describe("updateWorkspace: notes / protected の編集(issue #57 フェーズ3)", () => {
  it("notes の変更が Tidepool 名義で registry にコミットされる", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    await updateWorkspace({ name: "tidepool", notes: "the registry clone itself" }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool?.notes).toBe(
      "the registry clone itself",
    );
    expect(git(registryDir, "log", "-1", "--format=%an %s")).toBe(
      "tidepool update workspace tidepool via WebUI",
    );
  });

  it("protected の付与は confirm なしで通る(付けるのは安全方向、issue #57)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    await updateWorkspace({ name: "tidepool", protected: true }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool?.protected).toBe(true);
  });

  it("protected の解除は confirm がなければ拒否され、コミットを積まない(#55 と同型の確認ステップ)", async () => {
    const registryDir = await makeMainRegistry({ "workspaces.yaml": WORKSPACES_WITH_PROTECTED });
    const before = git(registryDir, "rev-parse", "HEAD");
    const deps = await makeDeps(registryDir);

    await expect(updateWorkspace({ name: "lagoon", protected: false }, deps)).rejects.toThrow(
      WorkspaceConfirmationRequiredError,
    );
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon?.protected).toBe(true);
  });

  it("protected の解除は confirm: true で通り、エントリから protected が消える", async () => {
    const registryDir = await makeMainRegistry({ "workspaces.yaml": WORKSPACES_WITH_PROTECTED });
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
    await updateWorkspace({ name: "tidepool", notes: "run npm install before first use" }, deps);

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

describe("updateWorkspace: review_allowed_commands の編集(issue #264 / ADR 0061)", () => {
  it("confirm: true 付きの設定が registry に着地する", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    await updateWorkspace(
      { name: "tidepool", review_allowed_commands: ["npm test"], confirm: true },
      deps,
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool?.review_allowed_commands).toEqual([
      "npm test",
    ]);
  });

  it("非空の設定は confirm なしでは拒まれ、理由コードを運ぶ(コミットも積まない)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      updateWorkspace({ name: "tidepool", review_allowed_commands: ["npm test"] }, deps),
    ).rejects.toMatchObject({
      name: "WorkspaceConfirmationRequiredError",
      reasons: ["review_allowed_commands_set"],
    });
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("notes だけの PATCH は、設定済みの workspace でも確認を要求しない — 判定はペイロードだけを見る(ADR 0061 決定2)", async () => {
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": "tidepool:\n  path: /home/pi/work/tidepool\n  review_allowed_commands:\n    - npm test\n",
    });
    const deps = await makeDeps(registryDir);

    await updateWorkspace({ name: "tidepool", notes: "run npm install first" }, deps);

    const entry = loadRegistry(registryDir, "purely-local").workspaces.tidepool;
    expect(entry?.notes).toBe("run npm install first");
    expect(entry?.review_allowed_commands).toEqual(["npm test"]);
  });

  it("空配列は確認なしでキーごと消える — 床を下げる向きに摩擦は置かない(ADR 0061 決定2)", async () => {
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": "tidepool:\n  path: /home/pi/work/tidepool\n  review_allowed_commands:\n    - npm test\n",
    });
    const deps = await makeDeps(registryDir);

    await updateWorkspace({ name: "tidepool", review_allowed_commands: [] }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool).toEqual({
      path: "/home/pi/work/tidepool",
    });
  });

  it("文法違反のエントリは書き込み前に弾かれ、registry は読める状態のまま(ADR 0061 根拠5)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      updateWorkspace(
        { name: "tidepool", review_allowed_commands: ["npm test,rm -rf /"], confirm: true },
        deps,
      ),
    ).rejects.toThrow(InvalidReviewAllowedCommandError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool?.review_allowed_commands).toBeUndefined();
  });
});

describe("updateWorkspace: checkout の位置に依存しない書き込み(ADR 0052 決定6 / issue #210)", () => {
  it("registry クローンが registry-edit タスクのブランチに居ても、編集がリモート main へ着地する", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const } };

    await updateWorkspace({ name: "tidepool", notes: "the registry clone itself" }, deps);

    expect(loadRegistry(registryDir, "remote-backed").workspaces.tidepool?.notes).toBe(
      "the registry clone itself",
    );
    expect(git(registryDir, "log", "-1", "--format=%s", "refs/remotes/origin/main")).toBe(
      "update workspace tidepool via WebUI",
    );
    expect(git(registryDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/registry-edit-1");
  });

  it("push が失敗すると致命 — リモートに編集が残らない(ADR 0052 決定1)", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "remote", "set-url", "--push", "origin", "/no/such/remote");
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const } };
    const before = git(registryDir, "rev-parse", "refs/remotes/origin/main");

    await expect(
      updateWorkspace({ name: "tidepool", notes: "the registry clone itself" }, deps),
    ).rejects.toThrow(RegistryPushFailedError);

    expect(git(registryDir, "rev-parse", "refs/remotes/origin/main")).toBe(before);
    expect(loadRegistry(registryDir, "remote-backed").workspaces.tidepool?.notes).not.toBe(
      "the registry clone itself",
    );
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
