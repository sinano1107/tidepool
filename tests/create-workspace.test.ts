import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidWorkspaceNameError, loadRegistry } from "../src/registry.js";
import { RegistryFetchFailedError, RegistryPushFailedError } from "../src/registry-write.js";
import { RepoAccessMissingError } from "../src/repo-access.js";
import {
  BoardStateOverlapError,
  createWorkspace,
  NotAGitRepositoryError,
  OrphanCheckoutMismatchError,
} from "../src/workspace-create.js";
import { FakeGitHubClient } from "./fakes.js";
import { makeRegistry, makeRemoteBackedRegistry } from "./registry-fixture.js";

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

/** register モードが登録する「ホスト上に既にある checkout」— origin を持つ実クローン。 */
async function makeExistingCheckout(upstream: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "tidepool-existing-"));
  const dir = join(parent, "checkout");
  git(parent, "clone", "--quiet", upstream, dir);
  return dir;
}

/** register モードの対象 — git リポジトリだが origin を持たない、ローカルのみの
 *  checkout(ADR 0066 決定7 の門をくぐれる最小の fixture)。 */
async function makeLocalOnlyCheckout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-local-only-"));
  git(dir, "init", "-b", "main");
  return dir;
}

/** 実 clone をネットワークへ出さずに「規約どおりの場所に要求 repo の孤児が居る」
 *  状態を作る: ローカル upstream から clone して origin だけ要求 URL に差し替える
 *  (ADR 0087 決定5 の流用条件を満たす最小の形)。 */
function placeMatchingOrphan(baseDir: string, name: string, upstream: string, repo: string): void {
  const dir = join(baseDir, name);
  git(baseDir, "clone", "--quiet", upstream, dir);
  git(dir, "remote", "set-url", "origin", repo);
}

async function makeDeps(registryDir: string) {
  return {
    registry: { dir: registryDir, mode: "purely-local" as const },
    workspacesBaseDir: await mkdtemp(join(tmpdir(), "tidepool-ws-base-")),
    github: new FakeGitHubClient(),
  };
}

describe("createWorkspace: 新規作成モード(issue #57 / ADR 0066)", () => {
  it("GitHub を1度も呼ばずに workspace を作り、repo を書かない", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    const path = await createWorkspace({ mode: "create", name: "lagoon" }, deps);

    expect(deps.github.repoAccessCalls).toBe(0);
    // ADR 0082 決定1: 規約導出モードの着地先は、決めた側へ返って初めて読める
    expect(path).toBe(join(deps.workspacesBaseDir, "lagoon"));
    expect(existsSync(join(deps.workspacesBaseDir, "lagoon"))).toBe(true);
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({});
  });

  it("初期ブランチは main — ホストの init.defaultBranch に依存しない", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    // ホストの init.defaultBranch を master に振っておく —— -b main が実装から
    // 抜けても既定が main のホストでは緑のままなので、判別力を持たせるには
    // 既定を master 側にずらして確かめる必要がある
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "init.defaultbranch";
    process.env.GIT_CONFIG_VALUE_0 = "master";
    try {
      await createWorkspace({ mode: "create", name: "lagoon" }, deps);
    } finally {
      delete process.env.GIT_CONFIG_COUNT;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }

    const checkoutDir = join(deps.workspacesBaseDir, "lagoon");
    expect(git(checkoutDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    // 空リポジトリには main が存在しない(ensureTaskBranch が pickup 時に落ちる)
    // ので、初期コミットが実在することも押さえる
    expect(git(checkoutDir, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("GitHub 身元が無い盤面(deps.github 不在)でも create が通る", async () => {
    const registryDir = await makeMainRegistry();
    const { github: _github, ...deps } = await makeDeps(registryDir);

    await createWorkspace({ mode: "create", name: "lagoon" }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({});
  });

  it("notes と protected は作成フォームからエントリへそのまま載る(protected を付けるのは安全方向なので確認なし)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);

    await createWorkspace(
      { mode: "create", name: "lagoon", notes: "run npm install", protected: true },
      deps,
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({
      notes: "run npm install",
      protected: true,
    });
  });

  it("リトライは冪等: 規約どおりの場所に既に checkout があれば(前回 registry コミット直前で失敗した孤児)、済んだ手順として流用して登録まで進む", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    // 前回の孤児を模す: 規約どおりの場所に手作業で init 済み
    git(deps.workspacesBaseDir, "init", "-b", "main", "lagoon");

    await createWorkspace({ mode: "create", name: "lagoon" }, deps);

    expect(deps.github.repoAccessCalls).toBe(0);
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({});
  });
});

describe("createWorkspace: register モード(issue #57)", () => {
  it("明示 path のエントリが workspaces.yaml に加わり、Tidepool 名義で registry にコミットされる", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const path = await makeLocalOnlyCheckout();

    await createWorkspace({ mode: "register", name: "sandbox", path }, deps);

    const registry = loadRegistry(registryDir, "purely-local");
    expect(registry.workspaces.sandbox).toEqual({ path });
    // 手編集(帯域外)ではなくコミット済み — ADR 0020 の読み取り規律と両立する。
    // registryDir 自身の working tree は checkout ではなく着地先の ref だけを見る
    // (ADR 0052 決定6: clone の working tree は正本ではないので触れない)
    expect(git(registryDir, "log", "-1", "--format=%an")).toBe("tidepool");
  });

  // ADR 0052 決定3 / issue #211: `repo` は機械が読むフィールドへ昇格した ——
  // 「この workspace はリモートの正本を持つ」の宣言である。register モードは今日
  // `{ path }` しか書かないので、盤面が checkout の origin URL を読んで焼く。
  // 焼かなければ、既存 checkout として登録された remote 付き workspace は
  // purely-local と宣言され続け、merge 済みの成果が見えない地点からタスクが始まる。
  it("origin を持つ既存 checkout の登録では、その URL が repo として焼かれる", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();
    const checkout = await makeExistingCheckout(upstream);

    await createWorkspace({ mode: "register", name: "sandbox", path: checkout }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox).toEqual({
      path: checkout,
      repo: upstream,
    });
  });

  // 逆向き。remote を持たない checkout に `repo` を書けば、その宣言と実態のずれが
  // pickup で quarantine に落ちる —— 登録がその状態を自分で作ってはならない。
  it("origin を持たない既存 checkout の登録では repo を書かない", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const checkout = await makeLocalOnlyCheckout();

    await createWorkspace({ mode: "register", name: "sandbox", path: checkout }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox).toEqual({ path: checkout });
  });

  // ADR 0066 決定7: `repo` は登録の瞬間の観測(ADR 0052 決定3)であり、対象が
  // git リポジトリでなければ観測できない。旧挙動(origin なしとして repo を
  // 書かず通す)は撤回 — 観測に基づかない既定値を書いていた。
  it("git リポジトリでないパスの登録は拒否され、コミットを積まない", async () => {
    const registryDir = await makeMainRegistry();
    const before = git(registryDir, "rev-parse", "HEAD");
    const deps = await makeDeps(registryDir);
    const notAGitRepo = await mkdtemp(join(tmpdir(), "tidepool-not-a-repo-"));

    await expect(
      createWorkspace({ mode: "register", name: "sandbox", path: notAGitRepo }, deps),
    ).rejects.toThrow(NotAGitRepositoryError);
    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox).toBeUndefined();
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("createWorkspace: clone モード(issue #57)", () => {
  it("リポジトリが <workspacesBaseDir>/<name> に clone され、path なし・repo ありのエントリが登録される(ADR 0018)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();

    const cloneDir = await createWorkspace({ mode: "clone", name: "lagoon", repo: upstream }, deps);

    expect(cloneDir).toBe(join(deps.workspacesBaseDir, "lagoon"));
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

  it("仲介が token を出せない repo は clone を撃たずに拒否し、install の案内を message に載せる(ADR 0093 決定8)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    deps.github.scriptUnreachable("sinano1107/tidepool");

    const err = await createWorkspace(
      { mode: "clone", name: "lagoon", repo: "https://github.com/sinano1107/tidepool" },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RepoAccessMissingError);
    expect((err as Error).message).toContain("sinano1107/tidepool");
    expect((err as Error).message).toContain("/installations/new");
    expect((err as Error).message).toContain("HTTP 404: repo_unreachable");
    // 門は clone の**前**にある — 拒否は checkout を1つも残さない
    expect(existsSync(join(deps.workspacesBaseDir, "lagoon"))).toBe(false);
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toBeUndefined();
  });

  it("仲介が token を出せる repo は門を通って登録される", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();
    // 規約どおりの場所に前回の孤児が居る形を借りて、実 clone をネットワークへ
    // 出さずに門の先まで通す(冪等リトライは下のテストが単独で押さえている)。
    // origin は要求 repo に揃える —— 流用は要求と整合するときだけ(ADR 0087 決定5)
    placeMatchingOrphan(deps.workspacesBaseDir, "lagoon", upstream, "https://github.com/sinano1107/tidepool");

    await createWorkspace(
      { mode: "clone", name: "lagoon", repo: "https://github.com/sinano1107/tidepool" },
      deps,
    );

    expect(deps.github.repoAccessCalls).toBe(1);
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({
      repo: "https://github.com/sinano1107/tidepool",
    });
  });

  it("非 GitHub の URL では probe が発火しない —— clone の入力欄は「anything git clone accepts」のまま", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();

    await createWorkspace({ mode: "clone", name: "lagoon", repo: upstream }, deps);

    expect(deps.github.repoAccessCalls).toBe(0);
  });

  it("盤面が GitHub 身元を持たない(deps.github 不在)なら probe を撃たず今日の挙動のまま", async () => {
    const registryDir = await makeMainRegistry();
    const { github: _github, ...deps } = await makeDeps(registryDir);
    // 規約どおりの場所に要求 repo の孤児を置いておけば、身元なしでもネットワークに出ずに通る
    const upstream = await makeUpstream();
    placeMatchingOrphan(deps.workspacesBaseDir, "lagoon", upstream, "https://github.com/sinano1107/tidepool");

    await createWorkspace(
      { mode: "clone", name: "lagoon", repo: "https://github.com/sinano1107/tidepool" },
      deps,
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toEqual({
      repo: "https://github.com/sinano1107/tidepool",
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

  it("新規作成モード: 重なる clone 先なら checkout を作る前に拒否する(外部作用の手前で止める)", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const guarded = {
      ...deps,
      boardState: [{ label: "the board's own checkout (process cwd)", path: deps.workspacesBaseDir }],
    };

    await expect(createWorkspace({ mode: "create", name: "lagoon" }, guarded)).rejects.toThrow(
      BoardStateOverlapError,
    );
    expect(existsSync(join(deps.workspacesBaseDir, "lagoon"))).toBe(false);
  });

  it("交差しない登録は従来どおり通る", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const boardDir = await mkdtemp(join(tmpdir(), "tidepool-board-"));
    const path = await makeLocalOnlyCheckout();

    await createWorkspace({ mode: "register", name: "sandbox", path }, {
      ...deps,
      boardState: [{ label: "board database (TIDEPOOL_DB)", path: join(boardDir, "board.sqlite") }],
    });

    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox).toEqual({ path });
  });
});

describe("createWorkspace: checkout の位置に依存しない書き込み(ADR 0052 決定6 / issue #210)", () => {
  // 旧テスト「外部処理(リポジトリ作成)の最中に...」は削除した。create モードの
  // 外部処理は ADR 0066 決定1 で GitHub 呼び出しから mkdir + git init + 初期コミット
  // (ローカル・同期)に変わり、フックできる非同期の差し込み点が無くなった —— 同じ
  // 性質(worktree は毎回その場で切るので registryDir のブランチ移動に影響されない)
  // は、以下の「registry-edit タスクのブランチに居ても...」(呼び出し**前**にブランチが
  // 動いている形)と clone モードの ADR 0067 probe を差し込む版で引き続き押さえる。
  it("clone モードの repo-access probe の最中に registry クローンのブランチが動いても、着地先は影響を受けない(/code-review TOCTOU 指摘)", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const } };
    const upstream = await makeUpstream();
    // 規約どおりの場所に前回の孤児を置き、実 clone をネットワークへ出さずに
    // probe の先まで通す(冪等リトライは clone モードの別テストが単独で押さえている)
    placeMatchingOrphan(deps.workspacesBaseDir, "lagoon", upstream, "https://github.com/sinano1107/tidepool");
    // 遅い外部手順(repo-access probe)の間に registry-edit タスクがブランチを
    // checkout する — worktree は毎回その場で切るので、この移動に影響されない
    const inner = deps.github.tokenRefusal.bind(deps.github);
    deps.github.tokenRefusal = async (ref) => {
      git(registryDir, "checkout", "-b", "task/registry-edit-1");
      return inner(ref);
    };

    await createWorkspace(
      { mode: "clone", name: "lagoon", repo: "https://github.com/sinano1107/tidepool" },
      deps,
    );

    expect(loadRegistry(registryDir, "remote-backed").workspaces.lagoon).toEqual({
      repo: "https://github.com/sinano1107/tidepool",
    });
    expect(git(registryDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/registry-edit-1");
  });

  it("registry クローンが registry-edit タスクのブランチに居ても、リモート main へエントリが着地する", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const } };
    const path = await makeLocalOnlyCheckout();

    await createWorkspace({ mode: "register", name: "sandbox", path }, deps);

    expect(loadRegistry(registryDir, "remote-backed").workspaces.sandbox).toEqual({ path });
    expect(git(registryDir, "log", "-1", "--format=%s", "refs/remotes/origin/main")).toBe(
      "add workspace sandbox via WebUI",
    );
  });

  it("push が失敗すると致命 — リモートにもコミットが残らない", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "remote", "set-url", "--push", "origin", "/no/such/remote");
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const } };
    const path = await makeLocalOnlyCheckout();

    await expect(
      createWorkspace({ mode: "register", name: "sandbox", path }, deps),
    ).rejects.toThrow(RegistryPushFailedError);
    expect(loadRegistry(registryDir, "remote-backed").workspaces.sandbox).toBeUndefined();
  });

  it("入口の fetch が失敗すると致命 — コミットを一切積まない", async () => {
    const { registryDir } = await makeRemoteBackedRegistry();
    git(registryDir, "remote", "set-url", "origin", "/no/such/remote");
    const deps = { ...(await makeDeps(registryDir)), registry: { dir: registryDir, mode: "remote-backed" as const } };

    await expect(
      createWorkspace({ mode: "register", name: "sandbox", path: "/tmp/sandbox" }, deps),
    ).rejects.toThrow(RegistryFetchFailedError);
    expect(loadRegistry(registryDir, "remote-backed").workspaces.sandbox).toBeUndefined();
  });

  it("純ローカル registry(remote なし)でも、タスクブランチに居る状態から書き込みが通る", async () => {
    const registryDir = await makeMainRegistry();
    git(registryDir, "checkout", "-b", "task/registry-edit-1");
    const deps = await makeDeps(registryDir);
    const path = await makeLocalOnlyCheckout();

    await createWorkspace({ mode: "register", name: "sandbox", path }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox).toEqual({ path });
    expect(git(registryDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/registry-edit-1");
  });
});

describe("createWorkspace: 孤児流用の門(ADR 0087 決定5 / issue #205)", () => {
  it("clone モード: 規約パスの既存 checkout の origin が要求 repo と違えば、その場所を名指しして拒否する", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const stale = await makeUpstream();
    const wanted = await makeUpstream();
    // 削除済み workspace の checkout が残っている状態を模す
    git(deps.workspacesBaseDir, "clone", stale, join(deps.workspacesBaseDir, "lagoon"));

    await expect(
      createWorkspace({ mode: "clone", name: "lagoon", repo: wanted }, deps),
    ).rejects.toThrow(OrphanCheckoutMismatchError);

    await expect(
      createWorkspace({ mode: "clone", name: "lagoon", repo: wanted }, deps),
    ).rejects.toThrow(join(deps.workspacesBaseDir, "lagoon"));
    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toBeUndefined();
  });

  it("新規作成モード: 規約パスの既存 checkout が origin を持てば流用せず拒否する", async () => {
    const registryDir = await makeMainRegistry();
    const deps = await makeDeps(registryDir);
    const upstream = await makeUpstream();
    git(deps.workspacesBaseDir, "clone", upstream, join(deps.workspacesBaseDir, "lagoon"));

    await expect(createWorkspace({ mode: "create", name: "lagoon" }, deps)).rejects.toThrow(
      OrphanCheckoutMismatchError,
    );

    expect(loadRegistry(registryDir, "purely-local").workspaces.lagoon).toBeUndefined();
  });
});
