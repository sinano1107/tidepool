import { execFileSync } from "node:child_process";
import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidReviewAllowedCommandError, loadRegistry } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import {
  listWorkspaceViews,
  updateWorkspace,
  WorkspaceConfirmationRequiredError,
} from "../src/workspace-create.js";
import { makeWorkspace } from "./harness.js";
import { makeRegistry, makeRemoteBackedRegistry, rejectRegistryPushes, writeUnannounced } from "./registry-fixture.js";
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
    registry: { dir: registryDir, mode: "purely-local" as const, writeRef: writeUnannounced },
    workspacesBaseDir: await tempDir("tidepool-ws-base-"),
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

  it("flag の無い別 clone でも、生の origin が registry と同じ GitHub repo なら保護を解除できない(ADR 0377 決定6 / E3)", async () => {
    const workspace = await makeWorkspace("registry-edits");
    const repo = "https://github.com/octocat/registry.git";
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": `registry-edits:\n  path: ${workspace.path}\n`,
    });
    git(registryDir, "remote", "add", "origin", repo.replace("https://", "https://git:example-token@"));
    git(workspace.path, "remote", "add", "origin", "git@GitHub.COM:OctoCat/Registry");
    git(workspace.path, "config", "url.https://github.com/other/.insteadOf", "git@GitHub.COM:OctoCat/");
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
    git(workspace.path, "remote", "add", "origin", rawOrigin);
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": `registry-mirror:\n  path: ${workspace.path}\n`,
    });
    git(registryDir, "remote", "add", "origin", rawOrigin);

    await expect(
      updateWorkspace({ name: "registry-mirror", protected: false, confirm: true }, await makeDeps(registryDir)),
    ).rejects.toThrow("shares the registry's repository (git.example.com:registry.git)");
  });

  it("checkout の config が壊れた symlink なら、origin が読めず確認付きでも保護を解除できない(E3b)", async () => {
    const workspace = await makeWorkspace("broken-origin");
    const config = join(workspace.path, ".git", "config");
    await rm(config);
    await symlink("missing-config", config);
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": `broken-origin:\n  path: ${workspace.path}\n`,
    });

    await expect(
      updateWorkspace({ name: "broken-origin", protected: false, confirm: true }, await makeDeps(registryDir)),
    ).rejects.toThrow(
      `the origin of workspace "broken-origin"'s checkout cannot be read, so the workspace is treated as protected; repair the checkout first.`,
    );
  });

  it("Git config が FIFO を include していても、origin の読み取りを打ち切って保護する", async () => {
    const workspace = await makeWorkspace("blocking-origin");
    const pipe = join(workspace.path, "config-pipe");
    git(workspace.path, "config", "--add", "include.path", pipe);
    execFileSync("mkfifo", [pipe]);
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": `blocking-origin:\n  path: ${workspace.path}\n`,
    });

    await expect(
      updateWorkspace({ name: "blocking-origin", protected: false, confirm: true }, await makeDeps(registryDir)),
    ).rejects.toThrow("repair the checkout first.");
  });

  it("origin は設定されているが URL が無ければ確認付きでも保護を解除できない(E3b)", async () => {
    const workspace = await makeWorkspace("missing-origin-url");
    git(workspace.path, "remote", "add", "origin", "/srv/git/registry.git");
    git(workspace.path, "config", "--unset", "remote.origin.url");
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": `missing-origin-url:\n  path: ${workspace.path}\n`,
    });

    await expect(
      updateWorkspace({ name: "missing-origin-url", protected: false, confirm: true }, await makeDeps(registryDir)),
    ).rejects.toThrow("repair the checkout first.");
  });

  it("registry 側の origin を読めないときは registry clone の修理を示す", async () => {
    const workspace = await makeWorkspace("maybe-registry");
    git(workspace.path, "remote", "add", "origin", "/srv/git/registry.git");
    const registryDir = await makeMainRegistry({
      "workspaces.yaml": `maybe-registry:\n  path: ${workspace.path}\n`,
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
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const, writeRef: writeUnannounced } };

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
    rejectRegistryPushes(registryDir);
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const, writeRef: writeUnannounced } };

    await expect(
      updateWorkspace({ name: "tidepool", notes: "the registry clone itself" }, deps),
    ).rejects.toThrow(RegistryPushFailedError);

    expect(loadRegistry(registryDir, "remote-backed").workspaces.tidepool?.notes).not.toBe(
      "the registry clone itself",
    );
  });
});

describe("listWorkspaceViews: 設定面の一覧(issue #57 フェーズ3)", () => {
  it("保護の計算結果を返し、盤面自身の clone の識別とは区別する", async () => {
    const registryDir = await makeMainRegistry();
    const registryEdits = await makeWorkspace("registry-edits");
    const lagoon = await makeWorkspace("lagoon");
    const broken = await makeWorkspace("broken");
    const origin = "/srv/git/registry.git";
    git(registryDir, "remote", "add", "origin", origin);
    git(registryEdits.path, "remote", "add", "origin", origin);
    await writeFile(join(broken.path, ".git", "config"), "[broken\n");
    await writeFile(
      join(registryDir, "workspaces.yaml"),
      `registry:\n  path: ${registryDir}\nregistry-edits:\n  path: ${registryEdits.path}\nlagoon:\n  path: ${lagoon.path}\n  branch: trunk\n  notes: run npm install\nbroken:\n  path: ${broken.path}\n`,
    );
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-am", "self"],
      { cwd: registryDir },
    );

    const deps = await makeDeps(registryDir);

    expect(listWorkspaceViews(deps, "configured").workspaces).toEqual([
      { name: "registry", path: registryDir, protected: true, protectionReason: "registry_repository", registrySelf: true },
      { name: "registry-edits", path: registryEdits.path, protected: true, protectionReason: "registry_repository", registrySelf: false },
      {
        name: "lagoon",
        path: lagoon.path,
        branch: "trunk",
        notes: "run npm install",
        protected: false,
        registrySelf: false,
      },
      { name: "broken", path: broken.path, protected: true, protectionReason: "unreadable_origin", registrySelf: false },
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
