import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubAuth } from "../src/github-auth.js";
import { loadRegistry } from "../src/registry.js";
import { RepoAccessMissingError } from "../src/repo-access.js";
import {
  CheckoutHasOriginError,
  GitHubIdentityMissingError,
  publishWorkspace,
  RegistrySelfPublishError,
  WorkspaceAlreadyPublishedError,
} from "../src/workspace-create.js";
import { type FakeBroker, issuedToken, startFakeBroker } from "./fake-broker.js";
import { FakeGitHubClient } from "./fakes.js";
import { makeRegistry } from "./registry-fixture.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  )
    .toString()
    .trim();
}

/** 盤面の GitHub 身元(ADR 0093)。mode 600 の検査は `loadGitHubAuth` の側にあるので、
 *  ここは user token ファイルを1つ置くだけでよい。宛先が github.com を指すケース
 *  (到達性 probe の各テスト)では publish が仲介へ token を要求するので、仲介の
 *  代役も一緒に立てる —— テストの push 先は file:// なので token そのものは
 *  使われない。 */
const brokers: FakeBroker[] = [];
afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.close();
});

async function makeGitHubAuth(): Promise<GitHubAuth> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-token-"));
  const file = join(dir, "token");
  await writeFile(file, "gho_test\n");
  await chmod(file, 0o600);
  const broker = await startFakeBroker(() => issuedToken("installation-token"));
  brokers.push(broker);
  return new GitHubAuth(file, broker.url);
}

/** purely-local な workspace を1つ持つ registry と、その checkout。 */
async function makeBoard(entries?: string): Promise<{
  registryDir: string;
  deps: {
    registry: { dir: string; mode: "purely-local" };
    workspacesBaseDir: string;
    githubAuth: GitHubAuth;
  };
  checkout: string;
}> {
  const checkout = await mkdtemp(join(tmpdir(), "tidepool-sandbox-"));
  git(checkout, "init", "-b", "main");
  await writeFile(join(checkout, "README.md"), "sandbox\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-m", "initial");
  const registryDir = await makeRegistry({
    "workspaces.yaml":
      entries ??
      `sandbox:
  path: ${checkout}
`,
  });
  return {
    registryDir,
    deps: {
      registry: { dir: registryDir, mode: "purely-local" as const },
      workspacesBaseDir: await mkdtemp(join(tmpdir(), "tidepool-ws-base-")),
      githubAuth: await makeGitHubAuth(),
    },
    checkout,
  };
}

/** 人間が用意する宛先(ADR 0066 決定2): 盤面は repo を作らないので、テストでも
 *  空の bare repo を先に置く。 */
async function makeDestination(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-dest-"));
  git(dir, "init", "--bare", "-b", "main");
  return dir;
}

/** GitHub UI の「Add a README」を模す: 宛先の `main` に無関係な履歴を1つ置く。 */
async function seedDestination(dest: string): Promise<void> {
  const seed = await mkdtemp(join(tmpdir(), "tidepool-seed-"));
  git(seed, "init", "-b", "main");
  await writeFile(join(seed, "README.md"), "# added from the GitHub UI\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "Initial commit");
  git(seed, "push", dest, "main");
}

/** 宛先にあるブランチ名(`git ls-remote --heads` の refname 側)。 */
function remoteBranches(dest: string): string[] {
  const out = git(dest, "ls-remote", "--heads", dest);
  return out === "" ? [] : out.split("\n").map((line) => line.split("refs/heads/")[1] ?? "");
}

describe("publishWorkspace: 遷移そのもの(ADR 0066 決定2/6)", () => {
  it("purely-local な workspace が remote-backed として宣言され、全ブランチが載る", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    // publish 以前のタスクブランチ(決着後も削除されない差分の恒久記録)も連れて行く
    git(checkout, "branch", "task/abc123");
    // タグはドメイン上の意味を持たないので送らない(ADR 0066 決定6)
    git(checkout, "tag", "v0.1.0");
    const dest = await makeDestination();

    const pushed = await publishWorkspace({ name: "sandbox", repo: dest }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox?.repo).toBe(dest);
    expect(git(registryDir, "log", "-1", "--format=%an %s")).toBe(
      "tidepool publish workspace sandbox via WebUI",
    );
    expect(remoteBranches(dest).sort()).toEqual(["main", "task/abc123"]);
    expect(git(dest, "ls-remote", "--tags", dest)).toBe("");
    expect(git(checkout, "remote", "get-url", "origin")).toBe(dest);
    // ADR 0064 決定4 の6行目が撮り直す集合 —— push の直前に確定した「盤面が書いた ref」
    expect(pushed.sort()).toEqual([
      "refs/remotes/origin/main",
      "refs/remotes/origin/task/abc123",
    ]);
  });

  // ADR 0066 決定5 + issue #285 やること2/4: 最も起きやすい2つの人為ミスのうち
  // 「GitHub UI の Add a README」。`main` は non-fast-forward で落ちるが `task/*` は
  // 宛先に無いので、非 atomic なら**タスクブランチだけが載って**しまう —— 失敗した
  // publish が痕跡を残さないという不変条件がリモート側で破れる。
  it("宛先が空でなければ落ち、ローカルの origin も宛先のブランチも増えない(--atomic)", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    git(checkout, "branch", "task/abc123");
    const dest = await makeDestination();
    await seedDestination(dest);
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(publishWorkspace({ name: "sandbox", repo: dest }, deps)).rejects.toThrow();

    expect(() => git(checkout, "remote", "get-url", "origin")).toThrow();
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox?.repo).toBeUndefined();
    expect(remoteBranches(dest)).toEqual(["main"]);
  });
});

// ADR 0067 決定8(issue #285 のコメント): ADR 0066 決定5 が自分で名指しした最頻の
// 人為ミス「repo は作ったが bot の招待を忘れた」を、直せる材料が手元にあるうちに閉じる。
// probe は `await` を含むが、まだ外部効果を1つも起こしていない位置(`remote add` の
// 手前)なので不可分性の要求には触れない。
describe("publishWorkspace: 宛先への到達性(ADR 0067 決定8)", () => {
  it("仲介が token を出せなければ remote add すら撃たずに拒否する", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    const github = new FakeGitHubClient();
    github.scriptUnreachable("sinano1107/sandbox");
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      publishWorkspace(
        { name: "sandbox", repo: "https://github.com/sinano1107/sandbox.git" },
        { ...deps, github },
      ),
    ).rejects.toThrow(RepoAccessMissingError);

    expect(() => git(checkout, "remote", "get-url", "origin")).toThrow();
    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
  });

  it("直せなかったときの案内は repo の名指し・install リンク・仲介の理由を持つ", async () => {
    const { deps } = await makeBoard();
    const github = new FakeGitHubClient();
    github.scriptUnreachable("sinano1107/sandbox");

    const err: Error = await publishWorkspace(
      { name: "sandbox", repo: "https://github.com/sinano1107/sandbox.git" },
      { ...deps, github },
    ).then(
      () => new Error("publish resolved — expected a refusal"),
      (e) => e as Error,
    );

    expect(err.message).toContain("sinano1107/sandbox");
    expect(err.message).toContain("/installations/new");
    expect(err.message).toContain("HTTP 404: repo_unreachable");
  });

  // probe は唯一の `await` なので、その往復が registry を読んでから書くまでの窓を作る。
  // publish の対象は**既に登録済み**の workspace なので、`createWorkspace` の
  // 「途中失敗が残すのは registry が知らない孤児だけ」という根拠は引き継げない。
  it("probe の往復中に landed した publish を上書きせず、拒否へ落ちる", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    const github = new FakeGitHubClient();
    // probe が撃たれた瞬間に、別の扉から publish が landed したことにする
    const original = github.canReach.bind(github);
    github.canReach = async (ref) => {
      await writeFile(
        join(registryDir, "workspaces.yaml"),
        `sandbox:\n  path: ${checkout}\n  repo: https://github.com/sinano1107/first.git\n`,
      );
      git(registryDir, "add", "-A");
      git(registryDir, "commit", "-m", "another door published first");
      return original(ref);
    };

    await expect(
      publishWorkspace(
        { name: "sandbox", repo: "https://github.com/sinano1107/sandbox.git" },
        { ...deps, github },
      ),
    ).rejects.toThrow(WorkspaceAlreadyPublishedError);

    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox?.repo).toBe(
      "https://github.com/sinano1107/first.git",
    );
    expect(() => git(checkout, "remote", "get-url", "origin")).toThrow();
  });

  it("非 GitHub の宛先では probe が1回も撃たれない", async () => {
    const { deps } = await makeBoard();
    const github = new FakeGitHubClient();
    const dest = await makeDestination();

    await publishWorkspace({ name: "sandbox", repo: dest }, { ...deps, github });

    expect(github.repoAccessCalls).toBe(0);
  });
});

describe("publishWorkspace: 4つの拒否(ADR 0066 決定5 / issue #285)", () => {
  it("既に remote-backed な workspace は拒否され、痕跡を残さない", async () => {
    const { registryDir, deps, checkout } = await makeBoard(
      `sandbox:
  path: ${await mkdtemp(join(tmpdir(), "tidepool-unused-"))}
  repo: https://github.com/sinano1107/sandbox.git
`,
    );
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      publishWorkspace({ name: "sandbox", repo: "https://github.com/sinano1107/other.git" }, deps),
    ).rejects.toThrow(WorkspaceAlreadyPublishedError);

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox?.repo).toBe(
      "https://github.com/sinano1107/sandbox.git",
    );
    expect(() => git(checkout, "remote", "get-url", "origin")).toThrow();
  });

  // ADR 0066 決定5 / ADR 0013 と同じ形の、確認では買えない拒否: 通すと workspace
  // エントリは remote-backed を宣言し、合成 root は purely-local を宣言する ——
  // ADR 0052 が quarantine と定めた「2つの宣言の食い違い」を人間の扉が製造する。
  it("registry clone 自身は拒否される(2つの宣言の食い違いを人間の扉が製造しない)", async () => {
    const { registryDir, deps } = await makeBoard("placeholder: {}\n");
    // registry clone をそれ自身の workspace として登録する(#211 の「2つの役」)
    await writeFile(
      join(registryDir, "workspaces.yaml"),
      `registry:
  path: ${registryDir}
  protected: true
`,
    );
    git(registryDir, "add", "-A");
    git(registryDir, "commit", "-m", "register the registry clone itself");
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      publishWorkspace({ name: "registry", repo: "https://github.com/sinano1107/reg.git" }, deps),
    ).rejects.toThrow(RegistrySelfPublishError);

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(() => git(registryDir, "remote", "get-url", "origin")).toThrow();
  });

  it("GitHub 身元を持たない盤面では拒否される(push できない)", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      publishWorkspace(
        { name: "sandbox", repo: "https://github.com/sinano1107/sandbox.git" },
        { ...deps, githubAuth: undefined },
      ),
    ).rejects.toThrow(GitHubIdentityMissingError);

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(() => git(checkout, "remote", "get-url", "origin")).toThrow();
  });

  // 宣言(`repo` 無し)と実態(`origin` 在り)が既にずれている = 帯域外の手作業が
  // 作った ADR 0052 のずれ状態。pickup でどのみち quarantine に落ちるので、publish が
  // 上書きして辻褄を合わせる形は採らない。**publish が足していない remote は消さない。**
  it("checkout に既に origin が在る workspace は拒否され、その origin も消さない", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    git(checkout, "remote", "add", "origin", "https://github.com/sinano1107/out-of-band.git");
    const before = git(registryDir, "rev-parse", "HEAD");

    await expect(
      publishWorkspace({ name: "sandbox", repo: "https://github.com/sinano1107/sandbox.git" }, deps),
    ).rejects.toThrow(CheckoutHasOriginError);

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(git(checkout, "remote", "get-url", "origin")).toBe(
      "https://github.com/sinano1107/out-of-band.git",
    );
  });
});
