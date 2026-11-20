import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { GitHubAuth } from "../src/github-auth.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { loadRegistry } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { RepoAccessMissingError } from "../src/repo-access.js";
import { registerTask } from "../src/tasks.js";
import { refreshProtectedBranch, releaseWorkspace, resolveExecutionWorkspace } from "../src/workspace.js";
import {
  CheckoutHasOriginError,
  createWorkspace,
  deleteWorkspace,
  GitHubIdentityMissingError,
  publishWorkspace,
  WorkspaceAlreadyPublishedError,
} from "../src/workspace-create.js";
import { type FakeBroker, issuedToken, startFakeBroker } from "./fake-broker.js";
import { FakeClock, FakeGitHubClient, unusedLanding } from "./fakes.js";
import { startGitHttpRemote } from "./git-http-remote.js";
import { GIT_FIXTURE_TEST_TIMEOUT, HUMAN_WEBUI, leaveBaseline, makeRemoteBackedWorkspace, prepareAtPickup, quarantineQuestion } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.mock("../src/github-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/github-auth.js")>(),
  GIT_NETWORK_TIMEOUT_MS: 1000,
}));

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

it("publish の push が無音なら origin を巻き戻し、registry に repo を書かない(ADR 0334 / ADR 0066)", async () => {
  const { registryDir, deps, checkout } = await makeBoard();
  const dest = await makeDestination();
  const repo = await startGitHttpRemote(dest, "stall-push");

  await expect(publishWorkspace({ name: "sandbox", repo }, deps)).rejects.toThrow(
    "`git push` stalled: no bytes for 1 s (in " + checkout + ")",
  );
  expect(() => git(checkout, "remote", "get-url", "origin")).toThrow();
  expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox?.repo).toBeUndefined();
}, 15_000);

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
const dbs: Db[] = [];
afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.close();
  for (const db of dbs.splice(0)) db.close();
});

async function makeGitHubAuth(): Promise<GitHubAuth> {
  const dir = await tempDir("tidepool-token-");
  const file = join(dir, "token");
  await writeFile(file, "gho_test\n");
  await chmod(file, 0o600);
  const broker = await startFakeBroker(() => issuedToken("installation-token"));
  brokers.push(broker);
  return new GitHubAuth(file, broker.url);
}

/** purely-local な workspace を1つ持つ registry と、その checkout。 */
async function makeBoard(entries?: string) {
  const checkout = await tempDir("tidepool-sandbox-");
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
  const db = openDb(join(await tempDir("tidepool-board-"), "board.sqlite"));
  dbs.push(db);
  return {
    registryDir,
    deps: {
      registry: { dir: registryDir, mode: "purely-local" as const },
      workspacesBaseDir: await tempDir("tidepool-ws-base-"),
      githubAuth: await makeGitHubAuth(),
      db,
    },
    checkout,
  };
}

/** publish の最中に走っているセッション —— checkout を pickup した状態。 */
async function runningSession(db: Db, checkout: string) {
  const clock = new FakeClock();
  const task = registerTask(
    db,
    { type: "work", title: "runs while the human publishes", purpose: "keep working", completion_criteria: "done" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  const workspace = { name: "sandbox", path: checkout };
  const place = await prepareAtPickup(db, workspace, task);
  return { release: () => releaseWorkspace(db, place, task, clock.now()) };
}

/** 人間が用意する宛先(ADR 0066 決定2): 盤面は repo を作らないので、テストでも
 *  空の bare repo を先に置く。 */
async function makeDestination(): Promise<string> {
  const dir = await tempDir("tidepool-dest-");
  git(dir, "init", "--bare", "-b", "main");
  return dir;
}

/** GitHub UI の「Add a README」を模す: 宛先の `main` に無関係な履歴を1つ置く。 */
async function seedDestination(dest: string): Promise<void> {
  const seed = await tempDir("tidepool-seed-");
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
  it("remembers a published destination and accepts a new one after repair, delete and register", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    const clock = new FakeClock();
    const now = () => clock.now();
    const resolve = () => resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), "sandbox", null, deps.workspacesBaseDir);
    const refresh = () => refreshProtectedBranch(deps.db, resolve(), deps.githubAuth);
    const declare = async (repo?: string) => {
      await writeFile(join(registryDir, "workspaces.yaml"), `sandbox:\n  path: ${checkout}\n${repo ? `  repo: ${repo}\n` : ""}`);
      git(registryDir, "add", "workspaces.yaml");
      git(registryDir, "commit", "-m", "edit the workspace repo");
    };
    await leaveBaseline(deps.db, resolve());
    const dest = await makeDestination();

    await publishWorkspace({ name: "sandbox", repo: dest }, deps);
    await refresh();
    expect(git(checkout, "rev-parse", "refs/remotes/origin/main")).toBe(git(dest, "rev-parse", "refs/heads/main"));
    expect(quarantineQuestion(deps.db, "workspace", "sandbox")).toBeUndefined();

    const { workspace: replacement, publish } = await makeRemoteBackedWorkspace("replacement");
    const repair = `workspace sandbox was registered for repo ${dest}, but its registry entry now says ${replacement.repo}. Put \`repo:\` back and answer. To move the workspace to another repository, delete it afterwards and register it again.`;
    await declare(replacement.repo);
    await expect(refresh()).rejects.toThrow(repair);
    const question = quarantineQuestion(deps.db, "workspace", "sandbox")!;
    const answer = () => submitAnswer({ db: deps.db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db: deps.db, resolveWorkspace: resolve }) }, question, ["repaired by hand"], undefined, now, "webui");
    await expect(answer()).rejects.toThrow(repair);
    await declare(dest);
    await answer();
    await deleteWorkspace({ name: "sandbox", confirm: true }, { ...deps, unsettledTaskCount: 0, awaitingLandingTaskIds: [] });
    await createWorkspace({ name: "sandbox", mode: "register", path: replacement.path, confirm: true }, deps);

    await leaveBaseline(deps.db, resolve());
    publish("replacement.txt", "from the replacement repository\n", "advance replacement");
    await refresh();
    expect(git(replacement.path, "rev-parse", "refs/remotes/origin/main")).toBe(git(replacement.repo!, "rev-parse", "refs/heads/main"));
    expect(quarantineQuestion(deps.db, "workspace", "sandbox")).toBeUndefined();
  });

  it("purely-local な workspace が remote-backed として宣言され、全ブランチが載る", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    // publish 以前のタスクブランチ(決着後も削除されない差分の恒久記録)も連れて行く
    git(checkout, "branch", "task/abc123");
    // タグはドメイン上の意味を持たないので送らない(ADR 0066 決定6)
    git(checkout, "tag", "v0.1.0");
    const dest = await makeDestination();

    await publishWorkspace({ name: "sandbox", repo: dest }, deps);

    expect(loadRegistry(registryDir, "purely-local").workspaces.sandbox?.repo).toBe(dest);
    expect(git(registryDir, "log", "-1", "--format=%an %s")).toBe(
      "tidepool publish workspace sandbox via WebUI",
    );
    expect(remoteBranches(dest).sort()).toEqual(["main", "task/abc123"]);
    expect(git(dest, "ls-remote", "--tags", dest)).toBe("");
    expect(git(checkout, "remote", "get-url", "origin")).toBe(dest);
  });

  // ADR 0243 / ADR 0066 決定4: push する N 本の写しはまとめて予告され、押した値か予告の前(行が無い)の1値に畳まれる ——
  // 2値の行のまま残れば、もう片方の値へ動いた写しを解放が通してしまう。atomic に拒まれた push は写しを作らない
  it.each([
    ["通った", false],
    ["宛先に拒まれた", true],
  ])("publish の push が%sとき、走っているセッションの解放は写しが畳まれなかった側の値へ動いたことを違反と読む", async (_, rejected) => {
    const { deps, checkout } = await makeBoard();
    git(checkout, "branch", "task/abc123");
    const session = await runningSession(deps.db, checkout);
    const dest = await makeDestination();
    if (rejected) await seedDestination(dest);

    const published = publishWorkspace({ name: "sandbox", repo: dest }, deps);
    await (rejected ? expect(published).rejects.toThrow() : expect(published).resolves.toBeUndefined());
    // 押した写しは消し、拒まれた写しは予告した値で作る
    const copy = "refs/remotes/origin/main";
    const main = git(checkout, "rev-parse", "main");
    git(checkout, "update-ref", ...(rejected ? [copy, main] : ["-d", copy]));
    session.release();

    expect(quarantineQuestion(deps.db, "workspace", "sandbox")?.purpose).toContain(
      rejected ? `now: ${main} ${copy}` : `was: ${main} ${copy}`,
    );
  });

  // ADR 0052 Status 追記(#2827): 盤面所有の repo からの push は checkout の写しを動かさない —— 押した N 本の写しは push の成功を見て盤面が書く
  it.each([
    ["通れば、押した各ブランチの写しは押した sha を指す", false],
    ["拒まれれば、写しは1本も作られない", true],
  ])("publish の push が%s", async (_, rejected) => {
    const { deps, checkout } = await makeBoard();
    git(checkout, "branch", "task/abc123");
    const dest = await makeDestination();
    if (rejected) await seedDestination(dest);

    await publishWorkspace({ name: "sandbox", repo: dest }, deps).catch(() => {});

    const refs = (prefix: string) => git(checkout, "for-each-ref", "--format=%(objectname) %(refname:lstrip=3)", prefix);
    expect(refs("refs/remotes/origin")).toBe(rejected ? "" : git(checkout, "for-each-ref", "--format=%(objectname) %(refname:lstrip=2)", "refs/heads"));
  });

  // 巻き戻しは口の内側にある: push が通った後に registry のコミットが落ちれば、写しを書く前の値(ここでは無い)へ戻した後に
  // 読み返して畳むので(ADR 0243 決定2)、基準は予告の前(行が無い)へ戻る
  it("push が通った後に registry のコミットが落ちて巻き戻っても、走っているセッションの解放は違反にならない", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    const session = await runningSession(deps.db, checkout);
    const dest = await makeDestination();
    // registry の着地(`update-ref`)だけを落とす —— ref の lock を先に置く
    await writeFile(join(registryDir, ".git", "refs", "heads", "main.lock"), "");

    await expect(publishWorkspace({ name: "sandbox", repo: dest }, deps)).rejects.toThrow(RegistryPushFailedError);
    expect(remoteBranches(dest)).toContain("main");
    expect(() => git(checkout, "remote", "get-url", "origin")).toThrow();
    session.release();
    const workspace = resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), "sandbox", null, deps.workspacesBaseDir);
    await refreshProtectedBranch(deps.db, workspace, deps.githubAuth);

    expect(quarantineQuestion(deps.db, "workspace", "sandbox")).toBeUndefined();
  });

  // ADR 0066 決定5(#3197): 巻き戻しは publish が足した `remote.origin` の節と押した N 本の写しの逆だけ —— 節の無いまま
  // 残っていた写し・origin/HEAD・上流の設定(#3183 決定12 の修理文 `git config --remove-section remote.origin` が作る状態)は消さない
  it.each([
    ["push が宛先に拒まれた", "rejected"],
    ["push が通った後に registry のコミットが落ちた", "registry"],
  ] as const)("%sとき、remote の節が無いまま残っていた写しと上流の設定は publish の前のまま残り、比較は違反にならない", async (_, failure) => {
    const { registryDir, deps, checkout } = await makeBoard();
    const prior = git(checkout, "rev-parse", "main");
    git(checkout, "commit", "--allow-empty", "-m", "after the copies");
    git(checkout, "remote", "add", "origin", "https://github.com/sinano1107/old.git");
    git(checkout, "update-ref", "refs/remotes/origin/main", prior);
    git(checkout, "update-ref", "refs/remotes/origin/gone", prior);
    git(checkout, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(checkout, "config", "branch.main.remote", "origin");
    git(checkout, "config", "--remove-section", "remote.origin");
    const session = await runningSession(deps.db, checkout);
    const dest = await makeDestination();
    if (failure === "rejected") await seedDestination(dest);
    else await writeFile(join(registryDir, ".git", "refs", "heads", "main.lock"), "");
    const state = () => [git(checkout, "for-each-ref", "--format=%(objectname) %(symref) %(refname)"), git(checkout, "config", "--local", "--list")];
    const before = state();

    await expect(publishWorkspace({ name: "sandbox", repo: dest }, deps)).rejects.toThrow(failure === "registry" ? RegistryPushFailedError : "`git push` failed");
    expect(git(dest, "rev-parse", "main") === git(checkout, "rev-parse", "main")).toBe(failure === "registry");
    expect(state()).toEqual(before);
    expect(() => git(checkout, "remote", "get-url", "origin")).toThrow();
    session.release();
    const workspace = resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), "sandbox", null, deps.workspacesBaseDir);
    await refreshProtectedBranch(deps.db, workspace, deps.githubAuth);

    expect(quarantineQuestion(deps.db, "workspace", "sandbox")).toBeUndefined();
  });

  // 落ちて残った行は次の比較まで残り(ADR 0351 決定4)、次の予告はその上に重なる(ADR 0373 決定3・5)—— 戻す先は行ではなく、
  // publish が書く前に checkout にあった値(ADR 0066 決定5 の Status 追記、#3197)
  it("基準の写しの行が前に落ちた publish の2値のままでも、registry のコミットが落ちた巻き戻しは写しを publish の前の値へ戻す", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    const old = git(checkout, "rev-parse", "main");
    git(checkout, "commit", "--allow-empty", "-m", "pushed by the earlier publish");
    const earlier = git(checkout, "rev-parse", "main");
    const copy = "refs/remotes/origin/main";
    // 前に落ちた publish が書いた写しの側(節は人間が修理文どおりに外した)。その後の commit で、今回押す値は行のどちらとも違う
    git(checkout, "update-ref", copy, earlier);
    git(checkout, "commit", "--allow-empty", "-m", "after the earlier publish");
    const session = await runningSession(deps.db, checkout);
    deps.db.prepare("UPDATE workspace_state SET ref_snapshot = replace(ref_snapshot, ?, ?) WHERE name = ?").run(`${earlier} ${copy}`, `${old}|${earlier} ${copy}`, "sandbox");
    expect(deps.db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get("sandbox")).toContain(`${old}|${earlier} ${copy}`);
    const dest = await makeDestination();
    await writeFile(join(registryDir, ".git", "refs", "heads", "main.lock"), "");

    await expect(publishWorkspace({ name: "sandbox", repo: dest }, deps)).rejects.toThrow(RegistryPushFailedError);
    expect(git(dest, "rev-parse", "main")).toBe(git(checkout, "rev-parse", "main"));
    expect(git(checkout, "rev-parse", copy)).toBe(earlier);
    session.release();
    const workspace = resolveExecutionWorkspace(loadRegistry(registryDir, "purely-local"), "sandbox", null, deps.workspacesBaseDir);
    await refreshProtectedBranch(deps.db, workspace, deps.githubAuth);

    expect(quarantineQuestion(deps.db, "workspace", "sandbox")).toBeUndefined();
  });

  // ADR 0066 決定5 の Status 追記(#3197): 巻き戻しの手順は1つが落ちても残り(ADR 0378 決定10 の覚えた repo の戻しを含む)を撃ち、
  // 投げるのは巻き戻しの失敗で、元の失敗はその原因に残る
  it("巻き戻しで写しの削除が落ちても、後の写しと覚えた repo は戻り、元の失敗を原因に持つ巻き戻しの失敗を投げる", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    const prior = git(checkout, "rev-parse", "main");
    git(checkout, "commit", "--allow-empty", "-m", "after the copy");
    git(checkout, "update-ref", "refs/remotes/origin/main", prior);
    // refname 順で main より前 —— 写しが無かった名前の削除が、前に値があった名前の書き戻しより先に落ちる
    git(checkout, "branch", "a");
    await leaveBaseline(deps.db, { name: "sandbox", path: checkout });
    const dest = await makeDestination();
    await writeFile(join(registryDir, ".git", "refs", "heads", "main.lock"), "");
    // ref の削除だけが packed-refs の lock を取る —— push の後の写しの書き込みは通り、巻き戻しの削除だけが落ちる
    await writeFile(join(checkout, ".git", "packed-refs.lock"), "");

    const err = await publishWorkspace({ name: "sandbox", repo: dest }, deps).then(
      () => new Error("publish resolved — expected a failure"),
      (e) => e as Error,
    );

    expect(err.cause).toBeInstanceOf(RegistryPushFailedError);
    expect(err.message).toContain(`failed: ${(err.cause as Error).message}; rolling it back failed: `);
    expect(git(checkout, "rev-parse", "refs/remotes/origin/main")).toBe(prior);
    expect(() => git(checkout, "remote", "get-url", "origin")).toThrow();
    expect(deps.db.prepare("SELECT remembered_repo FROM workspace_state WHERE name = ?").pluck().get("sandbox")).toBe("null");
  });

  // 前の値のままの写しは巻き戻しで撃たない —— 残った `origin/feature` と D/F で衝突する `origin/feature/x` は、書けずに落ちた後の
  // `update-ref -d` も落ちる。何も残っていない巻き戻しを失敗と言わない
  it("残った写しと名前が衝突して写しを書けずに落ちた publish は、巻き戻しの失敗でなく元の失敗を投げ、publish の前のままに戻る", async () => {
    const { deps, checkout } = await makeBoard();
    git(checkout, "update-ref", "refs/remotes/origin/feature", git(checkout, "rev-parse", "main"));
    git(checkout, "branch", "feature/x");
    const state = () => [git(checkout, "for-each-ref", "--format=%(objectname) %(symref) %(refname)"), git(checkout, "config", "--local", "--list")];
    const before = state();
    const dest = await makeDestination();

    const err = await publishWorkspace({ name: "sandbox", repo: dest }, deps).then(
      () => new Error("publish resolved — expected a failure"),
      (e) => e as Error,
    );

    expect(err.message).toContain("refs/remotes/origin/feature/x");
    expect(err.message).not.toContain("rolling it back failed");
    expect(state()).toEqual(before);
    expect(() => git(checkout, "remote", "get-url", "origin")).toThrow();
  });

  // ADR 0342 決定4: 巻き戻しの手順が受けた盤面 DB の拒否は、巻き戻しの失敗に包まずそのまま投げる
  it("覚えた repo の戻しで盤面 DB が書きを拒むと、publish はその拒否をそのまま投げる", async () => {
    const { registryDir, deps, checkout } = await makeBoard();
    await leaveBaseline(deps.db, { name: "sandbox", path: checkout });
    const dest = await makeDestination();
    await writeFile(join(registryDir, ".git", "refs", "heads", "main.lock"), "");
    const refusal = new Database.SqliteError("database or disk is full", "SQLITE_FULL");
    deps.db.function("refuse_restore", () => {
      throw refusal;
    });
    // 宛先を覚えた後の書き(= 戻し)だけを拒む
    deps.db.exec(
      "CREATE TEMP TRIGGER restore_refused BEFORE UPDATE OF remembered_repo ON workspace_state " +
        "WHEN OLD.remembered_repo IS NOT NULL AND OLD.remembered_repo <> 'null' BEGIN SELECT refuse_restore(); END",
    );

    await expect(publishWorkspace({ name: "sandbox", repo: dest }, deps)).rejects.toBe(refusal);
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
    const original = github.tokenRefusal.bind(github);
    github.tokenRefusal = async (ref) => {
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

describe("publishWorkspace: 3つの拒否(ADR 0066 決定5 / issue #285)", () => {
  it("既に remote-backed な workspace は拒否され、痕跡を残さない", async () => {
    const { registryDir, deps, checkout } = await makeBoard(
      `sandbox:
  path: ${await tempDir("tidepool-unused-")}
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

    const refused = publishWorkspace({ name: "sandbox", repo: "https://github.com/sinano1107/sandbox.git" }, deps);
    await expect(refused).rejects.toThrow(CheckoutHasOriginError);
    // spec #3273 text A12(H12 → F4): 手で直せとだけ言わず、ref を動かさない直し方を言う
    await expect(refused).rejects.toThrow(`. In ${checkout}, run \`git config --remove-section remote.origin\`.`);

    expect(git(registryDir, "rev-parse", "HEAD")).toBe(before);
    expect(git(checkout, "remote", "get-url", "origin")).toBe(
      "https://github.com/sinano1107/out-of-band.git",
    );
  });
});
