import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InvalidWorkspaceNameError, loadRegistry } from "../src/registry.js";
import { RegistryCloneBusyError } from "../src/registry-write.js";
import { BoardStateOverlapError, createWorkspace } from "../src/workspace-create.js";
import { FakeGitHubClient } from "./fakes.js";
import { makeRegistry } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** registry クローンのブランチ名をホストの init.defaultBranch 設定に依存させ
 *  ない — ADR 0020 の「main はコード定数」に合わせ、fixture を main に正規化。 */
async function makeMainRegistry(): Promise<string> {
  const dir = await makeRegistry();
  git(dir, "branch", "-M", "main");
  return dir;
}

/** clone 元の実 git リポジトリ(ローカルパス = clone 可能な URL)。 */
async function makeUpstream(defaultBranch = "main"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-upstream-"));
  git(dir, "init", "-b", defaultBranch);
  await writeFile(join(dir, "readme.md"), "upstream fixture");
  git(dir, "add", "-A");
  git(
    dir,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "initial commit",
  );
  return dir;
}

async function makeDeps(registryDir: string) {
  return {
    registryDir,
    registryMode: "purely-local" as const,
    workspacesBaseDir: await mkdtemp(join(tmpdir(), "tidepool-ws-base-")),
    github: new FakeGitHubClient(),
  };
}

describe("createWorkspace: 新規作成モード(issue #57)", () => {
  it("GitHub に private リポジトリを作成し、clone モードと同様に登録される", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    // gh が作った「初期コミット付きリポジトリ」の代役 — フェイクはこの URL を返す
    const upstream = await makeUpstream();
    deps.github.scriptNextRepositoryUrl(upstream);

    await createWorkspace({ mode: "create", name: "lagoon" }, deps);

    expect(deps.github.createdRepositories).toEqual(["lagoon"]);
    const cloneDir = join(deps.workspacesBaseDir, "lagoon");
    expect(git(cloneDir, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({ repo: upstream });
  });

  it("notes と protected は作成フォームからエントリへそのまま載る(protected を付けるのは安全方向なので確認なし)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();

    await createWorkspace(
      { mode: "clone", name: "lagoon", repo: upstream, notes: "run npm install", protected: true },
      deps,
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({
      repo: upstream,
      notes: "run npm install",
      protected: true,
    });
  });

  it("リトライは冪等: 同名のリポジトリが既に存在すれば作成せず流用して先へ進む", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();
    deps.github.scriptRepository("lagoon", upstream);

    await createWorkspace({ mode: "create", name: "lagoon" }, deps);

    expect(deps.github.createdRepositories).toEqual([]);
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({ repo: upstream });
  });
});

describe("createWorkspace: register モード(issue #57)", () => {
  it("明示 path のエントリが workspaces.yaml に加わり、Tidepool 名義で registry にコミットされる", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    await createWorkspace(
      { mode: "register", name: "sandbox", path: "/home/pi/work/sandbox" },
      deps,
    );

    const registry = loadRegistry(registryDir, "purely-local");
    expect(registry.workspaces.sandbox).toEqual({ path: "/home/pi/work/sandbox" });
    // 手編集(帯域外)ではなくコミット済み — ADR 0020 の読み取り規律と両立する
    expect(git(registryDir, "status", "--porcelain")).toBe("");
    expect(git(registryDir, "log", "-1", "--format=%an")).toBe("tidepool");
  });
});

describe("createWorkspace: clone モード(issue #57)", () => {
  it("リポジトリが <workspacesBaseDir>/<name> に clone され、path なし・repo ありのエントリが登録される(ADR 0018)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();

    await createWorkspace({ mode: "clone", name: "lagoon", repo: upstream }, deps);

    const cloneDir = join(deps.workspacesBaseDir, "lagoon");
    expect(git(cloneDir, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({ repo: upstream });
  });

  it("default branch が main 以外なら branch: に自動記録される — 最初の pickup が quarantine で死なない(issue #27 統合)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream("trunk");

    await createWorkspace({ mode: "clone", name: "lagoon", repo: upstream }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({
      repo: upstream,
      branch: "trunk",
    });
  });

  it("リトライは冪等: 規約どおりの場所に既に clone がある(前回 registry コミット直前で失敗した孤児)なら、済んだ手順として流用して登録まで進む", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();
    git(deps.workspacesBaseDir, "clone", upstream, join(deps.workspacesBaseDir, "lagoon"));

    await createWorkspace({ mode: "clone", name: "lagoon", repo: upstream }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({ repo: upstream });
  });
});

describe("createWorkspace: 名前検証(#68 の assertValidWorkspaceName が入口で効く)", () => {
  it("registry に既にある名前は InvalidWorkspaceNameError で拒否され、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");
    const deps = await makeDeps(registryDir);

    await expect(
      createWorkspace({ mode: "register", name: "tidepool", path: "/tmp/elsewhere" }, deps),
    ).rejects.toThrow(InvalidWorkspaceNameError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("createWorkspace: 盤面の状態パスとの重なりは登録の門で即拒否(ADR 0040 / issue #149)", () => {
  it("register モード: 明示 path が盤面の状態パスと重なれば拒否され、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");
    const boardDir = await mkdtemp(join(tmpdir(), "tidepool-board-"));
    const deps = {
      ...(await makeDeps(registryDir)),
      boardState: [{ label: "board database (TIDEPOOL_DB)", path: join(boardDir, "board.sqlite") }],
    };

    await expect(
      createWorkspace({ mode: "register", name: "self", path: boardDir }, deps),
    ).rejects.toThrow(BoardStateOverlapError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("clone モード: 規約由来の clone 先(<workspacesBaseDir>/<name>)が重なれば、clone する前に拒否する", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();
    const guarded = {
      ...deps,
      // worker-logs の中に workspace を掘る形 — 逆包含も同じ交差
      boardState: [{ label: "worker logs (TIDEPOOL_WORKER_LOGS)", path: deps.workspacesBaseDir }],
    };

    await expect(
      createWorkspace({ mode: "clone", name: "lagoon", repo: upstream }, guarded),
    ).rejects.toThrow(BoardStateOverlapError);
    // 未作成のディレクトリでも判定できる(親の realpath + 字句結合)— clone は走らない
    expect(existsSync(join(deps.workspacesBaseDir, "lagoon"))).toBe(false);
  });

  it("新規作成モード: 重なる clone 先なら GitHub リポジトリを作る前に拒否する(外部作用の手前で止める)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const guarded = {
      ...deps,
      boardState: [{ label: "the board's own checkout (process cwd)", path: deps.workspacesBaseDir }],
    };

    await expect(createWorkspace({ mode: "create", name: "lagoon" }, guarded)).rejects.toThrow(
      BoardStateOverlapError,
    );
    expect(deps.github.createdRepositories).toEqual([]);
  });

  it("交差しない登録は従来どおり通る", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const boardDir = await mkdtemp(join(tmpdir(), "tidepool-board-"));

    await createWorkspace({ mode: "register", name: "sandbox", path: "/home/pi/work/sandbox" }, {
      ...deps,
      boardState: [{ label: "board database (TIDEPOOL_DB)", path: join(boardDir, "board.sqlite") }],
    });

    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox).toEqual({ path: "/home/pi/work/sandbox" });
  });
});

describe("createWorkspace: registry への push(issue #57: Tidepool 名義でコミット + push)", () => {
  it("origin リモートがあれば registry コミットが push される", async () => {
    const registryDir = await makeMainRegistry();
    const bare = await mkdtemp(join(tmpdir(), "tidepool-registry-origin-"));
    git(bare, "init", "--bare");
    git(registryDir, "remote", "add", "origin", bare);
    git(registryDir, "push", "-u", "origin", "main");
    const deps = await makeDeps(registryDir);

    const result = await createWorkspace(
      { mode: "register", name: "sandbox", path: "/tmp/sandbox" },
      deps,
    );

    expect(result.pushed).toBe(true);
    expect(git(bare, "log", "-1", "--format=%s", "main")).toBe("add workspace sandbox via WebUI");
  });

  it("push の失敗は非致命 — エントリのコミットは成功し、pushed: false と警告ログだけが残る(盤面はローカルクローンを読むので機能に支障なし)", async () => {
    const registryDir = await makeMainRegistry();
    git(registryDir, "remote", "add", "origin", "/no/such/remote");
    const deps = await makeDeps(registryDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await createWorkspace(
        { mode: "register", name: "sandbox", path: "/tmp/sandbox" },
        deps,
      );

      expect(result.pushed).toBe(false);
      expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox).toEqual({ path: "/tmp/sandbox" });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("push");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createWorkspace: registry コミットの前提条件(ADR 0020: WebUI 発はローカル main へ直接コミット)", () => {
  it("外部処理の最中に registry クローンのブランチが動いたら、コミット直前の再検査で失敗しタスクブランチに積まない(/code-review TOCTOU 指摘)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();
    deps.github.scriptNextRepositoryUrl(upstream);
    // 冒頭検査は通るが、遅い外部手順(リポジトリ作成)の間に registry-edit
    // タスクがブランチを checkout する — その瞬間を fake の中で再現する
    const inner = deps.github.createRepository.bind(deps.github);
    deps.github.createRepository = async (name) => {
      git(registryDir, "checkout", "-b", "task/registry-edit-1");
      return inner(name);
    };

    await expect(createWorkspace({ mode: "create", name: "lagoon" }, deps)).rejects.toThrow(
      RegistryCloneBusyError,
    );
    expect(git(registryDir, "log", "--format=%s", "task/registry-edit-1")).toBe(
      "registry fixture",
    );
  });
  it("registry クローンの HEAD が main 以外(registry-edit タスクのブランチ移動中)なら失敗し、エントリを積まない", async () => {
    const registryDir = await makeMainRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");
    const deps = await makeDeps(registryDir);

    await expect(
      createWorkspace({ mode: "register", name: "sandbox", path: "/tmp/sandbox" }, deps),
    ).rejects.toThrow(RegistryCloneBusyError);
    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox).toBeUndefined();
  });

  it("registry クローンが dirty なら失敗し、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");
    execFileSync("sh", ["-c", `echo drift >> ${join(registryDir, "workspaces.yaml")}`]);
    const deps = await makeDeps(registryDir);

    await expect(
      createWorkspace({ mode: "register", name: "sandbox", path: "/tmp/sandbox" }, deps),
    ).rejects.toThrow(RegistryCloneBusyError);
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});
