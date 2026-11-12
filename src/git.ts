import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WORKER_TREE_GIT_TIMEOUT_MS, WorkerTreeGitTimeoutError } from "./worker-tree-git-timeout.js";

/** The board's own git identity: the author on the tree rule's WIP commits
 *  (the task checkout release) and on the registry commits the WebUI flows make (issue #57,
 *  workspace-create.ts) — one authorship for everything tidepool itself
 *  commits. The email is the GitHub App bot's noreply (ADR 0093 決定9): the
 *  board's mechanical execution shows up under the same `tidepool-board[bot]` the
 *  board's GitHub operations do, extending the "board acts as Tidepool, not as
 *  a person" line (quarantine/watchdog questions already register under this
 *  name) onto git author.
 *
 *  ADR 0071: env 注入であってフラグではない — worker セッションが立てる ambient
 *  な `GIT_*` に負けないため。 */
const TIDEPOOL_BOT_NOREPLY_EMAIL =
  // 公式 App の bot noreply(公開値、`gh api 'users/tidepool-board%5Bbot%5D' --jq .id`)。
  // fork が自分の App で動かすときは env で差し替える(ADR 0093 決定9)。
  process.env.TIDEPOOL_GITHUB_BOT_EMAIL ?? "319381852+tidepool-board[bot]@users.noreply.github.com";
const TIDEPOOL_GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "tidepool",
  GIT_AUTHOR_EMAIL: TIDEPOOL_BOT_NOREPLY_EMAIL,
  GIT_COMMITTER_NAME: "tidepool",
  GIT_COMMITTER_EMAIL: TIDEPOOL_BOT_NOREPLY_EMAIL,
} as const;

/** The board's plain (unauthenticated) git runner. stderr captured, not inherited: git narrates checkouts on stderr and the
 *  board's console is not the place for it. */
export function git(cwd: string, ...args: string[]): string {
  return run(cwd, args).toString().trim();
}

/** Machine-readable working-tree status, including every untracked file regardless of Git config. */
export function gitStatus(cwd: string): string {
  return git(cwd, "status", "--porcelain", "--untracked-files=all");
}

type View = (args: string[], overrides?: NodeJS.ProcessEnv) => string;
type Runner = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Buffer;

/** ADR 0356 決定3: borrow the checkout's objects while keeping its config, index, and ignore metadata out of the board's view.
 *  `objectsFrom` is the repo whose objects the view reads and writes — a task checkout's view uses the named place's.
 *  This is the unbounded view for the board's own side, including the Interview room (ADR 0356 決定1).
 *  Worker status and staging use bounded Git (ADR 0357 決定1). */
export function withBoardGit<T>(cwd: string, use: (view: View, gitDir: string) => T, objectsFrom = cwd): T {
  return viewWith(run, cwd, use, objectsFrom);
}

/** ADR 0357 決定1: the board's view over a worker's tree runs every call through the bounded runner. */
function withWorkerTreeGit<T>(cwd: string, use: (view: View, gitDir: string) => T, objectsFrom = cwd): T {
  return viewWith(runOnWorkerTree, cwd, use, objectsFrom);
}

function viewWith<T>(runner: Runner, cwd: string, use: (view: View, gitDir: string) => T, objectsFrom: string, mode: "view" | "stage" = "view"): T {
  const stage = mode === "stage";
  const format = git(objectsFrom, "rev-parse", "--show-object-format");
  const objects = git(objectsFrom, "rev-parse", "--path-format=absolute", "--git-path", "objects");
  const makeDirectory = () => mkdtempSync(join(tmpdir(), "tidepool-git-view-"));
  const dir = stage ? stagingHostStep(makeDirectory) : makeDirectory();
  try {
    const init = () => {
      git(dir, "init", "--bare", "--quiet", "--template=", `--object-format=${format}`);
      if (stage) writeFileSync(join(dir, "objects", "info", "alternates"), `${objects}\n`);
    };
    if (stage) stagingHostStep(init);
    else init();
    const env = { GIT_DIR: dir, GIT_WORK_TREE: resolve(cwd), GIT_INDEX_FILE: join(dir, "index"), ...(!stage && { GIT_OBJECT_DIRECTORY: objects }) };
    return use((args, overrides) => runner(dir, args, { ...env, ...overrides }).toString(), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type SparsePolicy = { pattern: string; cone: boolean };

function sparseOptions(gitDir: string, sparse: SparsePolicy | undefined): string[] {
  if (!sparse) return [];
  mkdirSync(join(gitDir, "info"));
  writeFileSync(join(gitDir, "info", "sparse-checkout"), sparse.pattern);
  return ["-c", "core.sparseCheckout=true", "-c", `core.sparseCheckoutCone=${sparse.cone}`];
}

/** ADR 0356 決定5: apply Git's normal overwrite checks using the real index, with no configured smudge filters. */
export function boardReadTree(cwd: string, from: string, to: string, sparse?: SparsePolicy): void {
  const index = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index");
  withBoardGit(cwd, (view, dir) => {
    // The index survives this view, so it cannot refer to a new sharedindex in the temporary gitdir.
    view(["-c", "core.splitIndex=false", ...sparseOptions(dir, sparse), "read-tree", "-u", "-m", from, to], { GIT_INDEX_FILE: index });
  });
}

export type WorktreeChange = { path: string; status: string };

export const displayWorktreePath = (path: string): string => /[\r\n\t]/.test(path) ? JSON.stringify(path) : path;

/** The view's fresh index holds `head`'s tree. */
function seedViewIndex(view: View, head: string): void {
  view(["update-ref", "--no-deref", "HEAD", head]);
  view(["read-tree", head]);
}

/** ADR 0360 Status 追記(#3111): view が運ばない path は sparse でなく pathspec で外す —— その path が無くても、ディレクトリでも、stub でも
 *  index には seed の entry が残り、add も status も配下ごと触らない。 */
const viewPathspecs = (exclude: string[]) => [".", ...exclude.map((path) => `:(exclude,literal)${path}`)];

const GITLINK_MODE = "160000";

/** ADR 0365 決定3: 記録の gitlink —— view の index の種 `head` の gitlink の path。 */
function seededGitlinks(view: View, head: string): string[] {
  return view(["ls-tree", "-r", "-z", head]).split("\0").filter((line) => line.startsWith(`${GITLINK_MODE} `)).map((line) => line.slice(line.indexOf("\t") + 1));
}

/** ADR 0365 決定3: worktree は gitlink の値を供給しない —— view は入れ子の repo を外す。worktree で祖先まで symlink でない dir の記録の
 *  gitlink(無い・file・symlink・読めない path は削除や置き換えとして記録できるので add -A に任せる)と、untracked の列挙が中へ降りない
 *  dir として返す entry。 */
function nestedRepos(view: View, cwd: string, gitlinks: string[]): string[] {
  const untracked = view(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter((path) => path.endsWith("/"));
  return [...gitlinks.filter((path) => isDirectoryBeneath(cwd, path)), ...untracked.map((path) => path.slice(0, -1))];
}

/** `rel` の各段が symlink でない dir か —— 祖先の symlink も辿らない。読めない段は dir と見なさず add -A に任せる(書いた tree の検査が後ろを守る)。 */
function isDirectoryBeneath(cwd: string, rel: string): boolean {
  let path = cwd;
  return rel.split("/").every((part) => {
    path = join(path, part);
    try {
      return lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  });
}

/** ADR 0356 決定2: worker の repo(task の checkout)が読めない。 */
export class TaskCheckoutUnreadableError extends Error {}

/** ADR 0356 決定2 / ADR 0364 決定2 / ADR 0367 決定1: checkout や盤面の一時 repo を用意する host 側の失敗。 */
export class TaskCheckoutHostError extends Error {}

export function stagingHostStep<T>(step: () => T): T {
  try {
    return step();
  } catch (cause) {
    if (cause instanceof WorkerTreeGitTimeoutError) throw cause;
    throw stagingHostError(cause);
  }
}

const stagingHostError = (cause: unknown) =>
  new TaskCheckoutHostError(`the board cannot stage the task checkout's working tree: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });

/** ADR 0364 決定2 / ADR 0367 決定1: writing the board's temporary repo can fail because the host is out of space. */
export function outOfSpace(dir: string, cause: unknown): boolean {
  if ((cause as NodeJS.ErrnoException | null)?.code === "ENOSPC" || String((cause as { stderr?: unknown } | null)?.stderr ?? "").includes("No space left on device")) return true;
  try {
    return statfsSync(dir).bavail === 0;
  } catch {
    return false;
  }
}

/** ADR 0367 決定1: stage in a temporary board-owned repo, where the gitlink check can reject the tree before it travels.
 *  The tree is available for `use` while that repo is open. */
export function boardWriteTree<T>(cwd: string, head: string, objectsFrom: string, use: (tree: string, gitDir: string) => T, exclude: string[] = []): T {
  return viewWith(runOnWorkerTree, cwd, (view, gitDir) => {
    try {
      // ADR 0367 決定1: 盤面の記録から index を作る失敗は、worker の worktree を読む失敗と分ける。
      seedViewIndex(view, head);
    } catch (cause) {
      if (!(cause instanceof WorkerTreeGitTimeoutError) && outOfSpace(gitDir, cause)) throw stagingHostError(cause);
      throw cause;
    }
    const gitlinks = seededGitlinks(view, head);
    let tree: string;
    try {
      const paths = viewPathspecs([...exclude, ...nestedRepos(view, cwd, gitlinks)]);
      // 入れ子の repo は worker が幾つでも作れる —— argv でなく file で渡す(E2BIG)
      const pathspecs = join(gitDir, "pathspecs");
      stagingHostStep(() => writeFileSync(pathspecs, paths.join("\0")));
      view(["add", "-A", `--pathspec-from-file=${pathspecs}`, "--pathspec-file-nul"]);
      tree = view(["write-tree"]).trim();
      // ADR 0365 決定3: 列挙が外さなかった入れ子の repo が足した・進めた gitlink は worker の repo の故障
      const added = gitlinkChanges(diffTreeEntries(gitDir, `${head}^{tree}`, tree, { workerTree: true }));
      if (added.length > 0) {
        throw new TaskCheckoutUnreadableError(`the task checkout at ${cwd} cannot be read: the worktree has a nested repository the board does not carry: ${added.join(", ")}`);
      }
    } catch (cause) {
      if (cause instanceof WorkerTreeGitTimeoutError || cause instanceof TaskCheckoutUnreadableError || cause instanceof TaskCheckoutHostError) throw cause;
      if (outOfSpace(gitDir, cause)) throw stagingHostError(cause);
      throw new TaskCheckoutUnreadableError(`the task checkout at ${cwd} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    return use(tree, gitDir);
  }, objectsFrom, "stage");
}

export interface TreeDeltaEntry {
  dstMode: string;
  path: string;
}

/** `from` から `to` まで(`mergeBase` なら2つの merge-base から `to` まで —— commit に限る)に entry(mode と blob、在る↔無い)が変わった行。
 *  盤面所有の repo で、replace ref を通さず object を読む(ADR 0360 決定1)。`.gitmodules` の `ignore` に gitlink を伏せさせない。
 *  行は `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0`。 */
export function diffTreeEntries(repo: string, from: string, to: string, { mergeBase = false, workerTree = false } = {}): TreeDeltaEntry[] {
  const read = workerTree ? workerRepoGit : git;
  const fields = read(repo, "--no-replace-objects", "diff-tree", "-r", "--raw", "-z", "--ignore-submodules=none", ...(mergeBase ? ["--merge-base"] : []), from, to).split("\0");
  const entries: TreeDeltaEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    entries.push({ dstMode: fields[i]!.split(" ")[1]!, path: fields[i + 1]! });
  }
  return entries;
}

/** ADR 0365 決定2: base から gitlink を足した・進めた path —— 参照先は別 repo の commit で、記録は持てない。diff-tree は変わった entry
 *  しか出さないので、行き先が gitlink の行がちょうど「足す」と「進める」。消す・blob や tree に置き換える行は行き先が gitlink でない。 */
export function gitlinkChanges(delta: TreeDeltaEntry[]): string[] {
  return delta.filter(({ dstMode }) => dstMode === GITLINK_MODE).map(({ path }) => path);
}

/** The repo's own status: only the board's env overrides apply (ADR 0356 決定5). For the named place, whose config is the human's or the board's. */
export function ownWorktreeStatus(cwd: string): WorktreeChange[] {
  return porcelainChanges(run(cwd, ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"]).toString());
}

function porcelainChanges(output: string): WorktreeChange[] {
  return output.split("\0").filter(Boolean).map((line) => ({ path: line.slice(3), status: line.slice(0, 2) }));
}

export class WorktreeStatusError extends Error {}

/** ADR 0356 決定3: a task checkout read only through the board's view — a fresh index from `head`'s tree and `objectsFrom`'s
 *  objects. Nothing runs in the worker's repo, so its real index is not read, and the view excludes nested repos (ADR 0365 決定3): a
 *  submodule counts by its recorded gitlink. */
export function boardViewStatus(cwd: string, head: string, objectsFrom: string, exclude: string[] = []): WorktreeChange[] {
  return withWorkerTreeGit(cwd, (view) => {
    seedViewIndex(view, head);
    const gitlinks = seededGitlinks(view, head);
    try {
      // dirty: 外さない gitlink の path が symlink だと、git は中の worktree を調べに行き status ごと落ちる(#3117 の実測、git 2.47)
      return porcelainChanges(view(["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=dirty", "--", ...viewPathspecs([...exclude, ...nestedRepos(view, cwd, gitlinks)])]));
    } catch (cause) {
      if (cause instanceof WorkerTreeGitTimeoutError) throw cause; // ADR 0357 決定3: 上限超過は観測の失敗ではない
      // ADR 0359 決定3: 盤面の記録から index を作る段の失敗と、worker の worktree を観測する段の失敗を分ける
      throw new WorktreeStatusError(cause instanceof Error ? cause.message : String(cause), { cause });
    }
  }, objectsFrom);
}

/** `git` に stdin を渡したもの(`--stdin` を取る subcommand 用)。 */
export function gitWithInput(input: string, cwd: string, ...args: string[]): string {
  return run(cwd, args, undefined, input).toString().trim();
}

/** ADR 0356 決定5 / ADR 0339 決定1: build the local environment and keep transport restricted to file. */
export function localGitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LC_ALL: process.env.LC_ALL,
    HOME: process.env.HOME,
    ...TIDEPOOL_GIT_IDENTITY_ENV,
    ...env,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // ADR 0356 決定5: also suppress repo-local hooks (including reference-transaction) and fsmonitor on real-index writes.
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "commit.gpgsign",
    GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "core.excludesFile",
    GIT_CONFIG_VALUE_3: "/dev/null",
  };
}

const subcommandOf = (args: string[]): string => args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-c" && args[i - 1] !== "-C") ?? "";

/** `timeout` kills the call; `bound` is the limit its expiry names (the stage's, when the call ran on what remained of it). */
function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string, timeout?: number, bound = timeout): Buffer {
  try {
    return execFileSync("git", args, {
      cwd,
      env: localGitEnv(env),
      maxBuffer: 64 * 1024 * 1024,
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // ADR 0334: Node's timeout kills only the parent git, so it runs in its own process group and the kill below also
      // reaches a child (`upload-pack`, a git blocked in `open()`). SIGTERM so git removes its lock files
      ...(timeout !== undefined && { timeout, killSignal: "SIGTERM" as const, detached: true }),
    });
  } catch (err) {
    const { code, pid, stderr } = err as NodeJS.ErrnoException & { pid?: number; stderr?: Buffer };
    if (timeout !== undefined && code === "ETIMEDOUT") {
      try {
        if (pid) process.kill(-pid, "SIGTERM");
      } catch {
        // the group has already exited
      }
      throw new WorkerTreeGitTimeoutError(subcommandOf(args), bound ?? timeout, stderr?.toString().split("\n")[0]?.trim() ?? "", { cause: err });
    }
    rethrowNamingMissingCwd(err, cwd, args);
  }
}

/** ADR 0357 決定1: the one runner for the git the board runs on a worker's tree or repo, bounded by one constant. ADR 0364 決定3: a call
 *  inside one bounded stage runs on what remains before the stage's `deadline`, and its expiry names the constant. */
function runOnWorkerTree(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string, deadline = Date.now() + WORKER_TREE_GIT_TIMEOUT_MS): Buffer {
  const remaining = deadline - Date.now();
  // execFileSync の timeout 0 は無期限 —— 使い切った段では撃たない
  if (remaining <= 0) throw new WorkerTreeGitTimeoutError(subcommandOf(args), WORKER_TREE_GIT_TIMEOUT_MS, "");
  return run(cwd, args, env, input, remaining, WORKER_TREE_GIT_TIMEOUT_MS);
}

/** ADR 0357 決定1 / ADR 0364 決定3: bounded Git for worker bytes, including reads and fetches from board-owned copies. */
export function workerRepoGit(cwd: string, ...args: string[]): string {
  return runOnWorkerTree(cwd, args).toString().trim();
}

/** ADR 0364 決定3: git inside the copy-and-verify stage, all bounded by the stage's one `deadline`. */
export function workerRepoGitUntil(deadline: number, cwd: string, args: string[], input?: string): string {
  return runOnWorkerTree(cwd, args, undefined, input, deadline).toString().trim();
}

/** `run` と、github-auth.ts で盤面の網に出る git が最初に checkout を読む `checkoutOrigin` が共有する —— 網に出る git
 *  そのもの(`runAuthedGit`)は盤面所有の repo か HOME を cwd にするので通らず、clone の置き場の不在は `authedClone` が
 *  同じ文で先に名指す。Node は cwd が無いときも git が
 *  PATH に無いときも在り処を言わない「spawnSync git ENOENT」だけを投げ、それが quarantine の理由にそのまま載る
 *  (issue #2722)—— cwd が無いほうだけを在り処を名指す理由に書き換え、git が無いほうは元のまま投げる。 */
export function rethrowNamingMissingCwd(err: unknown, cwd: string, args: string[]): never {
  if ((err as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(cwd)) {
    throw new Error(`\`git ${args[0]}\` cannot run: the directory ${cwd} does not exist`, { cause: err });
  }
  throw err;
}
