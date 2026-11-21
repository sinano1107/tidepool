import { execFileSync } from "node:child_process";
import { rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidReviewAllowedCommandError, loadRegistry } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { workspaceProtectionReader } from "../src/workspace.js";
import {
  listWorkspaceViews,
  updateWorkspace,
  WorkspaceConfirmationRequiredError,
} from "../src/workspace-create.js";
import { makeWorkspace } from "./harness.js";
import { makeRegistry, makeRemoteBackedRegistry, rejectRegistryPushes } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

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
    workspacesBaseDir: await tempDir("tidepool-ws-base-"),
  };
}

it("removing a declared human merge path requires confirmation, and additions do not", async () => {
  const registryDir = await makeMainRegistry();
  const deps = await makeDeps(registryDir);
  const mergePaths = () => loadRegistry(registryDir, "purely-local").workspaces.tidepool?.human_merge_paths;

  await updateWorkspace({ name: "tidepool", human_merge_paths: ["deploy/**", "release.sh"] }, deps);
  expect(mergePaths()).toEqual(["deploy/**", "release.sh"]);

  await expect(updateWorkspace({ name: "tidepool", human_merge_paths: ["release.sh"] }, deps))
    .rejects.toMatchObject({ name: "WorkspaceConfirmationRequiredError", reasons: ["human_merge_paths_removed"] });
  await expect(updateWorkspace({ name: "tidepool", human_merge_paths: [] }, deps))
    .rejects.toMatchObject({ name: "WorkspaceConfirmationRequiredError", reasons: ["human_merge_paths_removed"] });
  expect(mergePaths()).toEqual(["deploy/**", "release.sh"]);

  await updateWorkspace({ name: "tidepool", human_merge_paths: [], confirm: true }, deps);
  expect(mergePaths()).toBeUndefined();
});

it("a confirmed Settings edit cannot remove a human merge path added after the confirmation prompt", async () => {
  const registryDir = await makeMainRegistry();
  const deps = await makeDeps(registryDir);
  await updateWorkspace({ name: "tidepool", human_merge_paths: ["deploy/**"] }, deps);

  const remove = { name: "tidepool", human_merge_paths: [], expected_human_merge_paths: ["deploy/**"] };
  await expect(updateWorkspace(remove, deps)).rejects.toBeInstanceOf(WorkspaceConfirmationRequiredError);
  await updateWorkspace({ name: "tidepool", human_merge_paths: ["deploy/**", "release.sh"] }, deps);

  await expect(updateWorkspace({ ...remove, confirm: true }, deps)).rejects.toThrow("human merge paths changed");
  expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool?.human_merge_paths).toEqual(["deploy/**", "release.sh"]);

  await updateWorkspace({ ...remove, human_merge_paths: ["release.sh"], expected_human_merge_paths: ["deploy/**", "release.sh"], confirm: true }, deps);
  expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool?.human_merge_paths).toEqual(["release.sh"]);
});

describe("updateWorkspace: notes / protected の編集(issue #57 フェーズ3)", () => {
  it("notes の変更が Tidepool 名義で registry にコミットされる", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    await updateWorkspace({ name: "tidepool", notes: "a checkout of the tidepool repository" }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool?.notes).toBe(
      "a checkout of the tidepool repository",
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
    const { path } = await makeWorkspace("lagoon");
    const registryDir = await makeMainRegistry({ "workspaces.yaml": `lagoon:\n  path: ${path}\n  protected: true\n` });
    const before = git(registryDir, "rev-parse", "HEAD");
    const deps = await makeDeps(registryDir);

    await expect(updateWorkspace({ name: "lagoon", protected: false }, deps)).rejects.toThrow(
      WorkspaceConfirmationRequiredError,
    );
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon?.protected).toBe(true);
  });

  it("protected の解除は confirm: true で通り、エントリから protected が消える", async () => {
    const { path } = await makeWorkspace("lagoon");
    const registryDir = await makeMainRegistry({ "workspaces.yaml": `lagoon:\n  path: ${path}\n  protected: true\n` });
    const deps = await makeDeps(registryDir);

    await updateWorkspace({ name: "lagoon", protected: false, confirm: true }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({ path });
  });

  it("変更ゼロの更新(同値の notes)は失敗にならず、コミットも積まない(/code-review 指摘: no-op PATCH が 502 に見える穴)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const before = git(registryDir, "rev-parse", "HEAD");

    // fixture の tidepool エントリは notes を既に持つ — 同じ値を送る
    await updateWorkspace({ name: "tidepool", notes: "run npm install before first use" }, deps);

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("flag の無い workspace でも、宣言 repo が registry と同じ GitHub repo なら保護を解除できない(ADR 0381 決定1 / E3)", async () => {
    const workspace = await makeWorkspace("registry-edits");
    const repo = "https://github.com/octocat/registry.git";
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": `registry-edits:\n  path: ${workspace.path}\n  repo: git@GitHub.COM:OctoCat/Registry\n`,
    });
    git(registryDir, "remote", "add", "origin", "https://github.com/octocat/other.git");
    git(registryDir, "config", "--add", "remote.origin.url", repo.replace("https://", "https://git:example-token@"));
    const deps = await makeDeps(registryDir);

    await expect(
      updateWorkspace({ name: "registry-edits", protected: false, confirm: true }, deps),
    ).rejects.toThrow(
      `workspace "registry-edits" shares the registry's repository (${repo}), so it is always protected; this cannot be bought with a confirmation.`,
    );
  });

  it("SCP の origin も資格情報を除いて E3 に表示する", async () => {
    const workspace = await makeWorkspace("registry-mirror");
    const rawOrigin = "example-user@git.example.com:registry.git";
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": `registry-mirror:\n  path: ${workspace.path}\n  repo: ${rawOrigin}\n`,
    });
    git(registryDir, "remote", "add", "origin", rawOrigin);

    await expect(
      updateWorkspace({ name: "registry-mirror", protected: false, confirm: true }, await makeDeps(registryDir)),
    ).rejects.toThrow("shares the registry's repository (git.example.com:registry.git)");
  });

  it("checkout の origin が読めなくても保護の理由にならず、flag の保護は確認付きで解除できる(ADR 0381 決定4)", async () => {
    const workspace = await makeWorkspace("broken-origin");
    const config = join(workspace.path, ".git", "config");
    await rm(config);
    await symlink("missing-config", config);
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": `broken-origin:\n  path: ${workspace.path}\n  protected: true\n`,
    });

    await updateWorkspace({ name: "broken-origin", protected: false, confirm: true }, await makeDeps(registryDir));

    expect(loadRegistry(registryDir, "purely-local").workspaces["broken-origin"]).toEqual({ path: workspace.path });
  });

  it("registry 側の origin を読めないときは registry clone の修理を示す", async () => {
    const workspace = await makeWorkspace("maybe-registry");
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": `maybe-registry:\n  path: ${workspace.path}\n  repo: /srv/git/registry.git\n`,
    });
    const config = join(registryDir, ".git", "config");
    await rm(config);
    await symlink("missing-config", config);

    await expect(
      updateWorkspace({ name: "maybe-registry", protected: false, confirm: true }, await makeDeps(registryDir)),
    ).rejects.toThrow(
      'the origin of the registry clone cannot be read, so workspace "maybe-registry" is treated as protected; repair the registry checkout first.',
    );
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

describe("updateWorkspace: allowed_domains の編集(issue #321 / ADR 0072)", () => {
  it("非空の設定は confirm なしでは allowed_domains_set を理由に拒む", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    await expect(
      updateWorkspace({ name: "tidepool", allowed_domains: ["registry.npmjs.org"] }, deps),
    ).rejects.toMatchObject({
      name: "WorkspaceConfirmationRequiredError",
      reasons: ["allowed_domains_set"],
    });
  });

  it("confirm: true 付きの設定が registry に着地する", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    await updateWorkspace(
      { name: "tidepool", allowed_domains: ["registry.npmjs.org"], confirm: true },
      deps,
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.tidepool?.allowed_domains).toEqual([
      "registry.npmjs.org",
    ]);
  });
});

describe("updateWorkspace: checkout の位置に依存しない書き込み(ADR 0052 決定6 / issue #210)", () => {
  it("registry クローンが registry-edit タスクのブランチに居ても、編集がリモート main へ着地する", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const } };

    await updateWorkspace({ name: "tidepool", notes: "a checkout of the tidepool repository" }, deps);

    expect(loadRegistry(registryDir, "remote-backed").workspaces.tidepool?.notes).toBe(
      "a checkout of the tidepool repository",
    );
    expect(git(registryDir, "log", "-1", "--format=%s", "refs/remotes/origin/main")).toBe(
      "update workspace tidepool via WebUI",
    );
    expect(git(registryDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/registry-edit-1");
  });

  it("push が失敗すると致命 — リモートに編集が残らない(ADR 0052 決定1)", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    rejectRegistryPushes(registryDir);
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const } };

    await expect(
      updateWorkspace({ name: "tidepool", notes: "a checkout of the tidepool repository" }, deps),
    ).rejects.toThrow(RegistryPushFailedError);

    expect(loadRegistry(registryDir, "remote-backed").workspaces.tidepool?.notes).not.toBe(
      "a checkout of the tidepool repository",
    );
  });
});

// ADR 0381 決定1・2: 保護は宣言 `repo` の網の行き先と registry clone の網の行き先で決まり、checkout の origin は読まない。
describe("workspaceProtectionReader: 宣言 repo による registry の床", () => {
  const registryRepo = "https://github.com/octocat/registry.git";

  async function registryWithOrigin(origin: string): Promise<string> {
    const dir = await makeMainRegistry();
    git(dir, "remote", "add", "origin", origin);
    return dir;
  }

  it("宣言が registry の repo なら、checkout の origin を別の repo へ向け替えても保護になる", async () => {
    const workspace = await makeWorkspace("declared-registry");
    git(workspace.path, "remote", "add", "origin", "https://github.com/octocat/other.git");

    expect(workspaceProtectionReader(await registryWithOrigin(registryRepo))({ repo: registryRepo }, workspace.path)).toEqual({
      reason: "registry_repository",
      repo: registryRepo,
    });
  });

  it("宣言が別の repo なら、checkout の origin が registry を指していても保護にならない", async () => {
    const workspace = await makeWorkspace("declared-other");
    git(workspace.path, "remote", "add", "origin", registryRepo);

    expect(
      workspaceProtectionReader(await registryWithOrigin(registryRepo))({ repo: "https://github.com/octocat/other.git" }, workspace.path),
    ).toBeUndefined();
  });

  it("綴りだけ違う宣言(ssh・.git なし・大文字小文字・相対 path)も同じ repo として保護になる", async () => {
    const read = workspaceProtectionReader(await registryWithOrigin(registryRepo));
    const path = await tempDir("tidepool-unread-checkout-");
    for (const repo of ["git@github.com:octocat/registry.git", "https://github.com/octocat/registry", "https://github.com/OctoCat/Registry.git"]) {
      expect(read({ repo }, path)).toMatchObject({ reason: "registry_repository" });
    }
    const local = join(dirname(path), "registry-remote.git");
    expect(workspaceProtectionReader(await registryWithOrigin(local))({ repo: "../registry-remote.git" }, path)).toMatchObject({
      reason: "registry_repository",
    });
  });

  it("registry clone の origin が読めなければ宣言を持つ workspace は保護になり、宣言の無い workspace は flag だけで決まる", async () => {
    const registryDir = await makeMainRegistry();
    const config = join(registryDir, ".git", "config");
    await rm(config);
    await symlink("missing-config", config);
    const workspace = await makeWorkspace("undeclared");
    git(workspace.path, "remote", "add", "origin", registryRepo);
    const read = workspaceProtectionReader(registryDir);

    expect(read({ repo: registryRepo }, workspace.path)).toEqual({ reason: "unreadable_registry_origin" });
    expect(read({}, workspace.path)).toBeUndefined();
    expect(read({ protected: true }, workspace.path)).toEqual({ reason: "flag" });
  });

  it("registry clone の Git config が FIFO を include していても、origin の読み取りを打ち切って保護する", async () => {
    const registryDir = await makeMainRegistry();
    const pipe = join(registryDir, "config-pipe");
    git(registryDir, "config", "--add", "include.path", pipe);
    execFileSync("mkfifo", [pipe]);

    expect(workspaceProtectionReader(registryDir)({ repo: registryRepo }, registryDir)).toEqual({ reason: "unreadable_registry_origin" });
  });
});

describe("listWorkspaceViews: 設定面の一覧(issue #57 フェーズ3)", () => {
  // ADR 0377 決定1: registry clone は workspace にならないので、一覧に盤面自身の clone の印は無い
  it("保護の計算結果と、それが registry の repo から来たときの理由を返す", async () => {
    const registryDir = await makeMainRegistry();
    const registryEdits = await makeWorkspace("registry-edits");
    const lagoon = await makeWorkspace("lagoon");
    const broken = await makeWorkspace("broken");
    const origin = "/srv/git/registry.git";
    git(registryDir, "remote", "add", "origin", origin);
    await writeFile(join(broken.path, ".git", "config"), "[broken\n");
    await writeFile(
      join(registryDir, "workspaces.yaml"),
      `registry-edits:\n  path: ${registryEdits.path}\n  repo: ${origin}\nlagoon:\n  path: ${lagoon.path}\n  branch: trunk\n  notes: run npm install\nbroken:\n  path: ${broken.path}\n`,
    );
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-am", "self"],
      { cwd: registryDir },
    );

    const deps = await makeDeps(registryDir);

    expect(listWorkspaceViews(deps, "configured").workspaces).toEqual([
      { name: "registry-edits", path: registryEdits.path, repo: origin, protected: true, protectionReason: "registry_repository" },
      {
        name: "lagoon",
        path: lagoon.path,
        branch: "trunk",
        notes: "run npm install",
        protected: false,
      },
      { name: "broken", path: broken.path, protected: false },
    ]);
  });

  // ADR 0082 決定1/2: 規約導出の着地先を人間に見せるための基点は、一覧の属性として
  // 返る。出所を添えるのは「意図した設定」と「未設定の既定」を区別させるため。
  it("基点ディレクトリを出所つきで返す", async () => {
    const deps = await makeDeps(await makeMainRegistry());

    expect(listWorkspaceViews(deps, "configured").workspacesBaseDir).toEqual({
      path: deps.workspacesBaseDir,
      source: "configured",
    });
    expect(listWorkspaceViews(deps, "default").workspacesBaseDir).toEqual({
      path: deps.workspacesBaseDir,
      source: "default",
    });
  });
});
