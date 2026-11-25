import { execFileSync } from "node:child_process";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { openDb } from "../src/db.js";
import { GitHubAuth, workspaceHeadRepoDestination } from "../src/github-auth.js";
import { quarantineChecks } from "../src/human-verbs.js";
import { createLanding } from "../src/landing.js";
import { InvalidReviewAllowedCommandError, loadRegistry } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import {
  announceHeadRepo,
  assertRememberedHeadRepo,
  compareRefsBeforeLanding,
  resolveExecutionWorkspace,
  UnfinishedHeadRepoChangeError,
  withRememberedRepoCheck,
  workspaceProtectionReader,
} from "../src/workspace.js";
import {
  HeadRepoTaskBranchesNotSentError,
  listWorkspaceViews,
  updateWorkspace,
  WorkspaceConfirmationRequiredError,
} from "../src/workspace-create.js";
import { issuedToken, startFakeBroker } from "./fake-broker.js";
import { FakeClock, FakeGitHubClient } from "./fakes.js";
import { checkoutTaskBranch, commitWork, GIT_FIXTURE_TEST_TIMEOUT, makeWorkspace, quarantineQuestion, shimGit } from "./harness.js";
import { answerPromotion, breakPackedRefs, convergeOn, finish, landingWork, promotionFailures, repairPackedRefs } from "./landing-fixture.js";
import { makeRegistry, makeRemoteBackedRegistry, rejectRegistryPushes, setWorkspaceEntry } from "./registry-fixture.js";
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
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  return {
    registry: { dir: registryDir, mode: "purely-local" as const },
    workspacesBaseDir: await tempDir("tidepool-ws-base-"),
    db,
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

// ADR 0395 決定2 を ADR 0391 決定1〜3 の順で書く扉: registry に届かなければ、足した remote を外し、覚えた値を前の値へ畳む
describe("updateWorkspace: 出元 repo の書き込みの巻き戻し", () => {
  it("registry の push が落ちると、remote を前の状態へ戻し、宣言を変えず、次の検査は Quarantine なしに通る", async () => {
    const { registryDir, publish } = await makeRemoteBackedRegistry();
    const checkout = await makeWorkspace("lagoon");
    publish("workspaces.yaml", `lagoon:\n  path: ${JSON.stringify(checkout.path)}\n  repo: https://github.com/acme/lagoon.git\n`, "add lagoon");
    rejectRegistryPushes(registryDir);
    const github = new FakeGitHubClient();
    github.scriptRepositoryParent("acme/fork", "acme/lagoon");
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const }, github };
    const declared = () => resolveExecutionWorkspace(loadRegistry(registryDir, "remote-backed"), "lagoon", "lagoon", deps.workspacesBaseDir);

    await expect(updateWorkspace({ name: "lagoon", head_repo: "acme/fork", confirm: true }, deps)).rejects.toThrow(RegistryPushFailedError);

    expect(git(checkout.path, "remote")).toBe("");
    expect(declared().head_repo).toBeUndefined();
    expect(workspaceHeadRepoDestination(withRememberedRepoCheck(deps.db, declared(), () => new Date(0)))).toBeUndefined();
    expect(quarantineQuestion(deps.db, "workspace", "lagoon")).toBeUndefined();
  });
});

// ADR 0395 決定3: 出元 repo が宣言されたとき、扉が `task/*` を出元 repo へ送る(送るのは1本ずつ)。issue #3563: 失敗しても宣言は残り、同じ値をもう一度
// 通せば送り直す。出元 repo は GitHub の名前なので、盤面が組んだ網の行き先を shim で手元の bare へ回す
describe("updateWorkspace: タスクブランチを出元 repo へ送る", { timeout: GIT_FIXTURE_TEST_TIMEOUT }, () => {
  async function headRepoBoard() {
    const checkout = await makeWorkspace("lagoon");
    const registryDir = await makeMainRegistry({ "workspaces.yaml": `lagoon:\n  path: ${JSON.stringify(checkout.path)}\n  repo: https://github.com/acme/lagoon.git\n` });
    git(registryDir, "remote", "add", "origin", "https://github.com/acme/registry.git");
    const github = new FakeGitHubClient();
    github.scriptRepositoryParent("acme/fork", "acme/lagoon");
    const broker = await startFakeBroker((request) => issuedToken(`token-for-${request.repo}`));
    onTestFinished(() => broker.close());
    const tokenFile = join(await tempDir("tidepool-token-"), "token");
    await writeFile(tokenFile, "gho_test\n");
    await chmod(tokenFile, 0o600);
    const deps = { ...(await makeDeps(registryDir)), github, githubAuth: new GitHubAuth(tokenFile, broker.url) };
    const entry = () => loadRegistry(registryDir, "purely-local").workspaces.lagoon!;
    const workspace = { name: "lagoon", path: checkout.path, repo: "https://github.com/acme/lagoon.git" };
    // 着地の最初の撮りは pickup の開く前の項を撃つ(ADR 0399 決定7)—— 宣言の repo を指す origin を持つ checkout
    git(checkout.path, "remote", "add", "origin", workspace.repo);
    git(checkout.path, "branch", "task/aaa");
    git(checkout.path, "branch", "task/bbb");
    git(checkout.path, "branch", "feature");
    const sha = git(checkout.path, "rev-parse", "main");
    // fork の task/aaa は盤面の知らない履歴にある —— non-fast-forward で拒まれる
    const fork = await tempDir("tidepool-fork-");
    git(fork, "init", "--bare", "-b", "main");
    const outside = await tempDir("tidepool-outside-");
    git(outside, "init", "-b", "main");
    git(outside, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "diverged on the fork");
    git(outside, "push", fork, "main:refs/heads/task/aaa");
    const diverged = git(fork, "rev-parse", "task/aaa");
    const calls = await shimGit({ route: ["https://github.com/acme/fork.git", fork] });
    return {
      deps, entry, workspace, sha, fork, diverged, calls,
      set: () => updateWorkspace({ name: "lagoon", head_repo: "acme/fork", confirm: true }, deps),
      forkBranches: () => git(fork, "for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/heads/"),
      copies: () => git(checkout.path, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/"),
    };
  }

  it("タスクブランチだけを1本ずつ出元 repo の token で送り、送れなかったタスクブランチがあっても宣言は残り、同じ値をもう一度通すと送り直す", async () => {
    const { entry, sha, fork, diverged, calls, set, forkBranches, copies } = await headRepoBoard();

    const failed = await set().then(() => undefined, (e: Error) => e);

    expect(failed).toBeInstanceOf(HeadRepoTaskBranchesNotSentError);
    expect(failed?.message).toMatch(
      /^The head repo acme\/fork of workspace lagoon was saved, but these task branches were not sent to it: task\/aaa \(.+\)\. Set the same head repo again to send them\.$/s,
    );
    expect(entry().head_repo).toBe("acme/fork");
    expect(forkBranches()).toBe(`task/aaa ${diverged}\ntask/bbb ${sha}`);
    // 写しは送れたタスクブランチだけ。origin の写しは書かない
    expect(copies()).toBe(`refs/remotes/head-repo/task/bbb ${sha}`);
    expect(calls().filter(({ args }) => args.includes("push")).map(({ args, env }) => [args.at(-1), env.GH_TOKEN])).toEqual([
      [`${sha}:refs/heads/task/aaa`, "token-for-acme/fork"],
      [`${sha}:refs/heads/task/bbb`, "token-for-acme/fork"],
    ]);

    // ADR 0395 Status 追記: task/bbb は写しがあるので送らない —— 送るのは写しの無い task/aaa だけ
    git(fork, "update-ref", "-d", "refs/heads/task/aaa");
    await set();

    expect(entry().head_repo).toBe("acme/fork");
    expect(forkBranches()).toBe(`task/aaa ${sha}\ntask/bbb ${sha}`);
    expect(copies()).toBe(`refs/remotes/head-repo/task/aaa ${sha}\nrefs/remotes/head-repo/task/bbb ${sha}`);
  });

  // ADR 0395 Status 追記(#3605): 写しのあるタスクブランチは盤面が一度送ったもので、扉は送り直さない —— 人間の巻き戻しを fast-forward で戻さない
  it.each([false, true])("送れたタスクブランチを出元 repo で祖先へ戻してから同じ値で宣言し直しても、扉は写しの無いタスクブランチだけを送り、戻したブランチは動かない(送った後に local が進んだ = %s)", async (advanced) => {
    const { workspace, sha, fork, calls, set, copies } = await headRepoBoard();
    const commitOn = (parent: string, message: string) =>
      git(workspace.path, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit-tree", "-p", parent, "-m", message, `${parent}^{tree}`);
    const sent = commitOn(sha, "sent");
    git(workspace.path, "update-ref", "refs/heads/task/bbb", sent);
    await expect(set()).rejects.toBeInstanceOf(HeadRepoTaskBranchesNotSentError);
    expect(git(fork, "rev-parse", "task/bbb")).toBe(sent);
    if (advanced) git(workspace.path, "update-ref", "refs/heads/task/bbb", commitOn(sent, "after the send"));
    git(fork, "update-ref", "refs/heads/task/bbb", sha);
    const before = calls().length;

    const again = await set().then(() => undefined, (e: Error) => e);

    expect(again?.message).toMatch(/these task branches were not sent to it: task\/aaa \(.+\)\. Set the same head repo again/s);
    expect(calls().slice(before).filter(({ args }) => args.includes("push")).map(({ args }) => args.at(-1))).toEqual([`${sha}:refs/heads/task/aaa`]);
    expect(git(fork, "rev-parse", "task/bbb")).toBe(sha);
    expect(copies()).toBe(`refs/remotes/head-repo/task/bbb ${sent}`);
  });

  // ADR 0395 Status 追記(#3605): 送った後に出元 repo で消されたタスクブランチは人間が消したもの —— 扉は作り直さない
  it("送れたタスクブランチを出元 repo で消してから同じ値で宣言し直しても、扉はそれを作り直さない", async () => {
    const { fork, set, forkBranches, diverged } = await headRepoBoard();
    await expect(set()).rejects.toBeInstanceOf(HeadRepoTaskBranchesNotSentError);
    git(fork, "update-ref", "-d", "refs/heads/task/bbb");

    await expect(set()).rejects.toThrow(/these task branches were not sent to it: task\/aaa \(.+\)\. Set/s);

    expect(forkBranches()).toBe(`task/aaa ${diverged}`);
  });

  // ADR 0243: 写しは口を通る —— 基準の行は送れたタスクブランチの写しだけを持ち、次の比較は Quarantine を立てない
  it("基準があっても、送れたタスクブランチの写しだけが基準に入り、次の比較は違反にならない", async () => {
    const { deps, workspace, sha, set } = await headRepoBoard();
    const now = () => new Date();
    compareRefsBeforeLanding(deps.db, workspace, { resolveRegistered: undefined, now: now() });

    await expect(set()).rejects.toBeInstanceOf(HeadRepoTaskBranchesNotSentError);

    const rows = (deps.db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get("lagoon") as string)
      .split("\n").filter((line) => line.includes("refs/remotes/"));
    expect(rows).toEqual([`${sha} refs/remotes/head-repo/task/bbb`]);
    compareRefsBeforeLanding(deps.db, { ...workspace, head_repo: "acme/fork" }, { resolveRegistered: undefined, now: now() });
    expect(quarantineQuestion(deps.db, "workspace", "lagoon")).toBeUndefined();
  });

  it("replacing or removing the head repo discards only copies from the previous head repo", async () => {
    const { deps, workspace, sha, set, copies, entry, fork } = await headRepoBoard();
    const now = () => new Date();
    git(workspace.path, "update-ref", "refs/remotes/origin/main", sha);
    compareRefsBeforeLanding(deps.db, workspace, { resolveRegistered: undefined, now: now() });
    await expect(set()).rejects.toBeInstanceOf(HeadRepoTaskBranchesNotSentError);
    expect(copies()).toBe(`refs/remotes/head-repo/task/bbb ${sha}\nrefs/remotes/origin/main ${sha}`);

    git(workspace.path, "symbolic-ref", "refs/remotes/head-repo/HEAD", "refs/remotes/origin/main");
    const replacement = await tempDir("tidepool-replacement-fork-");
    git(replacement, "init", "--bare", "-b", "main");
    git(replacement, "fetch", fork, "refs/heads/task/aaa:refs/heads/task/bbb");
    await shimGit({ route: ["https://github.com/another/fork.git", replacement] });
    deps.github.scriptRepositoryParent("another/fork", "acme/lagoon");
    // 差し替えが前の出元 repo の写しを捨てるので、扉は task/bbb も新しい出元 repo へ送る(そこでは分岐していて拒まれる)
    await expect(updateWorkspace({ name: "lagoon", head_repo: "another/fork", confirm: true }, deps)).rejects.toThrow(
      /these task branches were not sent to it: task\/bbb \(.+\)\. Set/s,
    );

    expect(entry().head_repo).toBe("another/fork");
    expect(copies()).toBe(`refs/remotes/head-repo/task/aaa ${sha}\nrefs/remotes/origin/main ${sha}`);
    compareRefsBeforeLanding(deps.db, { ...workspace, head_repo: "another/fork" }, { resolveRegistered: undefined, now: now() });

    await updateWorkspace({ name: "lagoon", head_repo: "" }, deps);

    expect(entry().head_repo).toBeUndefined();
    expect(copies()).toBe(`refs/remotes/origin/main ${sha}`);
    compareRefsBeforeLanding(deps.db, workspace, { resolveRegistered: undefined, now: now() });
  });

  /** 扉が acme/fork から another/fork への変更を予告・remote・registry の commit まで書き、最後の畳みの前に死んだ形。 */
  function dieChangingToAnotherFork(deps: Awaited<ReturnType<typeof headRepoBoard>>["deps"], workspace: { name: string; path: string; repo: string }) {
    announceHeadRepo(deps.db, { ...workspace, head_repo: "acme/fork" }, "another/fork");
    git(workspace.path, "remote", "set-url", "head-repo", "https://github.com/another/fork.git");
    setWorkspaceEntry(deps.registry.dir, "lagoon", "head_repo", "another/fork");
  }

  // ADR 0415 決定1: 外す扉も変更の前に畳む —— 予告が前の fork を忘れた後で巻き戻ると、前の fork の写しが次の fork のものとして残る
  it("終わっていない変更の間に外す扉の registry の commit が落ちても前の fork の写しは残らず、出元 repo を置き直すとタスクブランチを全部送る", async () => {
    const { deps, workspace, sha, set, copies, calls } = await headRepoBoard();
    await expect(set()).rejects.toBeInstanceOf(HeadRepoTaskBranchesNotSentError);
    dieChangingToAnotherFork(deps, workspace);
    const replacement = await tempDir("tidepool-replacement-fork-");
    git(replacement, "init", "--quiet", "--bare", "-b", "main");
    await shimGit({ route: ["https://github.com/another/fork.git", replacement] });
    deps.github.scriptRepositoryParent("another/fork", "acme/lagoon");
    const path = process.env.PATH;
    await shimGit({ fails: ["commit", "registry commit failed"] });

    await expect(updateWorkspace({ name: "lagoon", head_repo: "" }, deps)).rejects.toThrow("registry commit failed");
    process.env.PATH = path;

    expect(copies()).not.toContain("refs/remotes/head-repo/");
    const before = calls().length;
    await updateWorkspace({ name: "lagoon", head_repo: "another/fork", confirm: true }, deps);
    expect(calls().slice(before).filter(({ args }) => args.includes("push")).map(({ args }) => args.at(-1))).toEqual([
      `${sha}:refs/heads/task/aaa`,
      `${sha}:refs/heads/task/bbb`,
    ]);
  });

  // ADR 0415 決定2・3: 扉が registry の commit まで書いて死んだ変更は、行き先の読みが止め、扉で外せば畳まれる
  it.each([
    ["外す", undefined],
    ["前の値へ戻す", "acme/fork"],
  ] as const)("終わっていない変更で止まっている間に扉で出元 repo を%sと、変更が畳まれ、行き先の検査が通る", async (_, value) => {
    const { deps, workspace, set, copies } = await headRepoBoard();
    await expect(set()).rejects.toBeInstanceOf(HeadRepoTaskBranchesNotSentError);
    dieChangingToAnotherFork(deps, workspace);
    expect(() => assertRememberedHeadRepo(deps.db, { ...workspace, head_repo: "another/fork" }, new Date())).toThrow(UnfinishedHeadRepoChangeError);

    const door = updateWorkspace({ name: "lagoon", head_repo: value ?? "", confirm: true }, deps);

    // 戻した fork では分岐した task/aaa がまた送れない —— 宣言は保存される
    if (value) await expect(door).rejects.toBeInstanceOf(HeadRepoTaskBranchesNotSentError);
    else await door;
    if (!value) expect(copies()).not.toContain("refs/remotes/head-repo/");
    expect(() => assertRememberedHeadRepo(deps.db, { ...workspace, head_repo: value }, new Date())).not.toThrow();
  });

  // ADR 0415 決定4: 扉の最後の畳みが落ちても扉は Quarantine を立てない —— 止めるのは次の行き先の読みで、回答が変更を終える
  it("扉の最後の畳みが落ちると、扉は Quarantine を立てずにエラーを返し、次の行き先の読みが止め、回答が変更を終える", async () => {
    const { deps, workspace, entry, set, copies } = await headRepoBoard();
    await expect(set()).rejects.toBeInstanceOf(HeadRepoTaskBranchesNotSentError);
    expect(copies()).toContain("refs/remotes/head-repo/");
    deps.github.scriptRepositoryParent("another/fork", "acme/lagoon");
    // 回答の後半の項が origin と出元 repo を網で読む
    const origin = await tempDir("tidepool-lagoon-origin-");
    git(origin, "clone", "--quiet", "--bare", workspace.path, ".");
    const replacement = await tempDir("tidepool-replacement-fork-");
    git(replacement, "init", "--quiet", "--bare", "-b", "main");
    await shimGit({ route: [workspace.repo, origin] });
    await shimGit({ route: ["https://github.com/another/fork.git", replacement] });
    breakPackedRefs(workspace);

    await expect(updateWorkspace({ name: "lagoon", head_repo: "another/fork", confirm: true }, deps)).rejects.toThrow("not a packed ref");

    expect(entry().head_repo).toBe("another/fork");
    expect(quarantineQuestion(deps.db, "workspace", "lagoon")).toBeUndefined();

    repairPackedRefs(workspace);
    const declared = { ...workspace, head_repo: "another/fork" };
    expect(() => workspaceHeadRepoDestination(withRememberedRepoCheck(deps.db, declared, () => new Date()))).toThrow(UnfinishedHeadRepoChangeError);
    expect(quarantineQuestion(deps.db, "workspace", "lagoon")).toBeDefined();

    const accept = quarantineChecks({ quarantineResolvers: {}, db: deps.db, workspace: declared }).workspace!;
    await expect(accept("lagoon", "repaired by hand", "webui")).resolves.toMatchObject({ notice: expect.stringContaining("finished the head repo change of workspace lagoon") });

    expect(copies()).not.toContain("refs/remotes/head-repo/");
    expect(() => assertRememberedHeadRepo(deps.db, declared, new Date())).not.toThrow();
  });

  // ADR 0376 決定6 / ADR 0395 Status 追記(#3605): 扉は写しのあるタスクブランチを送らないので、収束が text D2 で止めた巻き戻しを上書きしない
  it("convergence refuses to overwrite a rewind of a task branch sent only by publish, and declaring the same head repo again leaves the rewind for retry to keep refusing", async () => {
    const { deps, workspace, sha, fork, set } = await headRepoBoard();
    const clock = new FakeClock();
    git(workspace.path, "update-ref", "refs/remotes/origin/main", sha);
    const work = landingWork(deps.db, clock, workspace.name);
    checkoutTaskBranch(deps.db, workspace, work.id);
    commitWork(workspace.path, "feature.txt", "ready\n");
    git(workspace.path, "checkout", "main");
    finish(deps.db, clock, work);
    const branch = `refs/heads/task/${work.id}`;
    const pushed = git(workspace.path, "rev-parse", branch);
    await expect(set()).rejects.toBeInstanceOf(HeadRepoTaskBranchesNotSentError);
    expect(git(fork, "rev-parse", branch)).toBe(pushed);
    git(fork, "update-ref", branch, sha);
    const landing = createLanding({ ...deps, defaultAgentName: "tako", clock, workspace: { ...workspace, head_repo: "acme/fork" } });

    await expect(convergeOn(landing, work.id)).resolves.toMatchObject({
      kind: "failed", reason: "promotion_failed", error: expect.stringContaining(`head repo acme/fork's task/${work.id} was rewound`),
    });

    expect(git(fork, "rev-parse", branch)).toBe(sha);
    expect(deps.github.requests).toEqual([]);

    await expect(set()).rejects.toThrow(/these task branches were not sent to it: task\/aaa \(.+\)\. Set/s);

    expect(git(fork, "rev-parse", branch)).toBe(sha);
    const [failure] = promotionFailures(deps.db, work.id);
    await expect(answerPromotion(deps.db, clock, landing, { ...workspace, head_repo: "acme/fork" }, failure!, "retry"))
      .rejects.toThrow(`head repo acme/fork's task/${work.id} was rewound`);
    expect(git(fork, "rev-parse", branch)).toBe(sha);
    expect(deps.github.requests).toEqual([]);
  });
});

// issue #3563 の撃ち直しの扉: 同じ出元 repo をもう一度通しても registry の書き込みは何も積まず、宣言と remote はそのまま
it("同じ出元 repo をもう一度通しても壊れない", async () => {
  const checkout = await makeWorkspace("lagoon");
  const registryDir = await makeMainRegistry({ "workspaces.yaml": `lagoon:\n  path: ${JSON.stringify(checkout.path)}\n  repo: https://github.com/acme/lagoon.git\n` });
  git(registryDir, "remote", "add", "origin", "https://github.com/acme/registry.git");
  const github = new FakeGitHubClient();
  github.scriptRepositoryParent("acme/fork", "acme/lagoon");
  const deps = { ...(await makeDeps(registryDir)), github };
  const set = () => updateWorkspace({ name: "lagoon", head_repo: "acme/fork", confirm: true }, deps);
  await set();
  const head = git(registryDir, "rev-parse", "HEAD");

  await set();

  expect(git(registryDir, "rev-parse", "HEAD")).toBe(head);
  expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon?.head_repo).toBe("acme/fork");
  expect(git(checkout.path, "config", "remote.head-repo.url")).toBe("https://github.com/acme/fork.git");
});
