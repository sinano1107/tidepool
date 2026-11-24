import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
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

/** git の述語系コマンド `ask` の答え。git は「答えが no」も非零で返すので、答え(1)と**道具の失敗**(128 等)を終了コードで分ける ——
 *  後者を no と読み替えると、壊れた checkout が「コンフリクト」という嘘の理由で人間に届く。 */
export function gitAnswers(ask: () => unknown): boolean {
  try {
    ask();
    return true;
  } catch (err) {
    if ((err as { status?: number } | null)?.status !== 1) throw err;
    return false;
  }
}

/** `ancestor` が `descendant` に含まれているか = ff で運べるか。 */
export const isAncestor = (repo: { path: string }, ancestor: string, descendant: string, readGit = git): boolean =>
  gitAnswers(() => readGit(repo.path, "merge-base", "--is-ancestor", ancestor, descendant));

/** ADR 0373 決定4 / ADR 0382 決定2: `refs/stash` の今の値と reflog の各件の sha(新しい順)—— 1件ずつ `rev-parse` して object を開かない
 *  (`log -g` / `reflog show` は開けない件を黙って落とす、#3752)。reflog の件の数を越えたと git が言うまで回し、ほかの失敗は投げる。
 *  `refs/stash` が無ければ空、reflog が無ければ(update-ref で作った)今の値だけ —— そのとき `@{0}` が落ちるのを読めなさと取り違えない。
 *  shortcut: 1件ごとに git を1度起こす —— stash が数百件に積まれて遅くなれば reflog を1度で読む口に替える。 */
export function stashEntries(cwd: string, readGit = git): string[] {
  let top = "";
  if (!gitAnswers(() => (top = readGit(cwd, "rev-parse", "--verify", "--quiet", "refs/stash")))) return [];
  if (!gitAnswers(() => readGit(cwd, "reflog", "exists", "refs/stash"))) return [top];
  const entries: string[] = [];
  for (let n = 0; ; n++) {
    try {
      entries.push(readGit(cwd, "rev-parse", "--verify", `refs/stash@{${n}}`));
    } catch (err) {
      // 空の reflog と読めない reflog を git は同じ「is empty」で言うので、それは件の数の終わりに数えない
      const count = /^fatal: log for '.*' only has (\d+) entries$/m.exec(String((err as { stderr?: unknown }).stderr ?? ""))?.[1];
      if (count === undefined) throw err;
      // 一番古い件の old 値が 0 でなければ(`--rewrite` なしの delete や expire の後)、git は `@{件の数}` にその old 値を返す
      return [...new Set([top, ...entries.slice(0, Number(count))])];
    }
  }
}

/** ADR 0378 決定4: read the configured origin before applying insteadOf. */
export function readOriginConfig(readGit: (args: string[]) => Buffer): string | undefined {
  return readConfig(readGit, ["remote.origin.url"]);
}

function readConfig(readGit: (args: string[]) => Buffer, args: string[]): string | undefined {
  try {
    return readGit(["config", "--null", ...args]).toString().slice(0, -1);
  } catch (err) {
    if ((err as { status?: number }).status === 1) return undefined;
    throw err;
  }
}

const CHECKOUT_ORIGIN_TIMEOUT_MS = 2_000;

/** A readable checkout without the remote (origin by default) returns undefined. An unreadable checkout returns null. */
export function readCheckoutRemote(cwd: string, selection: "first" | "last" = "last", name = "origin"): string | undefined | null {
  // Git can block opening a config include, so both reads share a deadline.
  const deadline = Date.now() + CHECKOUT_ORIGIN_TIMEOUT_MS;
  const readGit = (args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("reading the checkout's origin timed out");
    return run(cwd, args, undefined, undefined, remaining, CHECKOUT_ORIGIN_TIMEOUT_MS);
  };
  try {
    const repo = readGit(["rev-parse", "--show-prefix", "--path-format=absolute", "--git-common-dir"]).toString();
    if (!repo.startsWith("\n")) return null;
    // Git treats a dangling config symlink like absent configuration.
    if (!statSync(join(repo.slice(1, -1), "config")).isFile()) return null;
    const remote = readConfig(readGit, ["--get-regexp", `^remote\\.${name}\\.[^.]+$`]);
    if (remote === undefined) return undefined;
    // Pickup compares the fetch URL, the first one Git fetches from. "last" is the value the board's network calls read.
    const urlKey = `remote.${name}.url`;
    const origin = selection === "first"
      ? remote.split("\0").find((entry) => entry === urlKey || entry.startsWith(`${urlKey}\n`))?.slice(urlKey.length + 1)
      : readConfig(readGit, [urlKey]);
    return origin?.trim() ? origin : null;
  } catch {
    return null;
  }
}

/** ADR 0369 決定7: confirm what the recorded objects contain without local history overrides. */
export function gitWithoutHistoryOverrides(cwd: string, ...args: string[]): string {
  return run(cwd, ["--no-replace-objects", ...args], { GIT_GRAFT_FILE: "/dev/null" }).toString().trim();
}

/** Machine-readable working-tree status, including every untracked file regardless of Git config. */
export function gitStatus(cwd: string): string {
  return git(cwd, "status", "--porcelain", "--untracked-files=all");
}

type View = (args: string[], overrides?: NodeJS.ProcessEnv, input?: string) => string;
type Runner = (cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string) => Buffer;

/** ADR 0356 決定3: borrow the checkout's objects while keeping its config, index, and ignore metadata out of the board's view.
 *  `objectsFrom` is the repo whose objects the view reads and writes — a task checkout's view uses the board-owned verified copy of the
 *  worker's tip (ADR 0412 決定1).
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
    return use((args, overrides, input) => runner(dir, args, { ...env, ...overrides }, input).toString(), dir);
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

/** `ls-tree -z` の1行の path。 */
const entryPath = (line: string) => line.slice(line.indexOf("\t") + 1);

/** `ls-tree -r -z` の行のうち gitlink の path。 */
const gitlinkPaths = (lines: string[]) => lines.filter((line) => line.startsWith(`${GITLINK_MODE} `)).map(entryPath);

/** ADR 0365 決定3: 記録の gitlink —— view の index の種 `head` の gitlink の path。 */
function seededGitlinks(view: View, head: string): string[] {
  return gitlinkPaths(view(["ls-tree", "-r", "-z", head]).split("\0"));
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

/** ADR 0356 決定2 / ADR 0371 決定4: 盤面が信じない checkout(task の checkout と作業台)が読めない。文の主語は投げる側が決める。 */
export class CheckoutUnreadableError extends Error {}

/** ADR 0356 決定2 / ADR 0364 決定2 / ADR 0367 決定1: checkout や盤面の一時 repo を用意する host 側の失敗。 */
export class CheckoutHostError extends Error {}

export function stagingHostStep<T>(step: () => T): T {
  try {
    return step();
  } catch (cause) {
    if (cause instanceof WorkerTreeGitTimeoutError) throw cause;
    throw stagingHostError(cause);
  }
}

const stagingHostError = (cause: unknown) =>
  new CheckoutHostError(`the board cannot stage the task checkout's working tree: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });

/** ADR 0364 決定2 / ADR 0367 決定1: writing the board's temporary repo can fail because the host is out of space. */
export function outOfSpace(dir: string, cause: unknown): boolean {
  if ((cause as NodeJS.ErrnoException | null)?.code === "ENOSPC" || String((cause as { stderr?: unknown } | null)?.stderr ?? "").includes("No space left on device")) return true;
  try {
    return statfsSync(dir).bavail === 0;
  } catch {
    return false;
  }
}

/** ADR 0412 決定3: 名前の場所 `at` の、種の tip より先にある ref。 */
type RecordedAhead = { ref: string; at: string };

/** ADR 0367 決定1: stage in a temporary board-owned repo, where the gitlink check can reject the tree before it travels.
 *  The tree is available for `use` while that repo is open. ADR 0412 決定2・3: `head` is the worker's tip in `objectsFrom`; with
 *  `ahead`, the paths the view excludes take the ref's entries. */
export function boardWriteTree<T>(cwd: string, head: string, objectsFrom: string, use: (tree: string, gitDir: string) => T, exclude: string[] = [], ahead?: RecordedAhead): T {
  // ADR 0412 決定3: ref の entry は名前の場所の側の段で読む(tree だけ、blob は読まない)—— 失敗は型の無いまま投げる
  const recorded = ahead ? git(ahead.at, "--no-replace-objects", "ls-tree", "-r", "-z", ahead.ref).split("\0").filter(Boolean) : [];
  const recordedGitlinks = gitlinkPaths(recorded);
  return viewWith(runOnWorkerTree, cwd, (view, gitDir) => {
    let tree: string;
    try {
      seedViewIndex(view, head);
      const excluded = [...exclude, ...nestedRepos(view, cwd, [...seededGitlinks(view, head), ...recordedGitlinks])];
      const paths = viewPathspecs(excluded);
      // 入れ子の repo は worker が幾つでも作れる —— argv でなく file で渡す(E2BIG)
      const pathspecs = join(gitDir, "pathspecs");
      stagingHostStep(() => writeFileSync(pathspecs, paths.join("\0")));
      view(["add", "-A", `--pathspec-from-file=${pathspecs}`, "--pathspec-file-nul"]);
      tree = view(["write-tree"]).trim();
      // ADR 0365 決定3: 列挙が外さなかった入れ子の repo が足した・進めた gitlink は worker の repo の故障
      const added = gitlinkChanges(diffTreeEntries(gitDir, `${head}^{tree}`, tree, { workerTree: true }));
      if (added.length > 0) {
        throw new CheckoutUnreadableError(`the task checkout at ${cwd} cannot be read: the worktree has a nested repository the board does not carry: ${added.join(", ")}`);
      }
      if (ahead) tree = overlayRecorded(view, excluded, recorded, tree.length);
    } catch (cause) {
      if (cause instanceof WorkerTreeGitTimeoutError || cause instanceof CheckoutUnreadableError || cause instanceof CheckoutHostError) throw cause;
      if (outOfSpace(gitDir, cause)) throw stagingHostError(cause);
      throw new CheckoutUnreadableError(`the task checkout at ${cwd} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    return use(tree, gitDir);
  }, objectsFrom, "stage");
}

/** ADR 0412 決定3: view が外した path(worktree が供給しない path)の index の entry を、名前の場所の ref の `recorded`(`ls-tree -r -z` の行)の
 *  entry に置き換え —— ref に無い path は落とす —— object を持たない entry を許して tree を書く。entry の object は名前の場所にある。 */
function overlayRecorded(view: View, excluded: string[], recorded: string[], oidLength: number): string {
  const inside = (path: string) => excluded.some((dir) => path === dir || path.startsWith(`${dir}/`));
  const dropped = view(["ls-files", "-z", "--cached"]).split("\0").filter((path) => path && inside(path)).map((path) => `0 ${"0".repeat(oidLength)}\t${path}\0`);
  const kept = recorded.filter((line) => inside(entryPath(line))).map((line) => `${line}\0`);
  if (dropped.length + kept.length > 0) view(["update-index", "--add", "--replace", "-z", "--index-info"], undefined, [...dropped, ...kept].join(""));
  return view(["write-tree", "--missing-ok"]).trim();
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

/** ADR 0409 決定2: git that exits 0 can still report something on stderr, so this runner returns both. A non-zero exit throws like `git`. */
export function gitReporting(cwd: string, args: string[], input: string, env: NodeJS.ProcessEnv): { stdout: string; stderr: string } {
  const result = spawnSync("git", args, runOptions(cwd, env, input));
  if (result.error) rethrowNamingMissingCwd(result.error, cwd, args);
  const [stdout, stderr] = [result.stdout.toString(), result.stderr.toString()];
  if (result.status !== 0) throw Object.assign(new Error(`Command failed: git ${args.join(" ")}\n${stderr}`), { status: result.status, stderr });
  return { stdout, stderr };
}

/** ADR 0356 決定5 / ADR 0339 決定1: build the local environment and keep transport restricted to file. */
export function localGitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LC_ALL: process.env.LC_ALL,
    HOME: process.env.HOME,
    ...TIDEPOOL_GIT_IDENTITY_ENV,
    ...env,
    // 盤面は git の文を読み分ける(`only has N entries` など)—— LC_ALL が訳す locale でも英語で言わせる
    LANGUAGE: "en",
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

/** The spawn options `run` and `gitReporting` share. */
const runOptions = (cwd: string, env: NodeJS.ProcessEnv | undefined, input: string | Buffer | undefined) => ({
  cwd,
  env: localGitEnv(env),
  maxBuffer: 64 * 1024 * 1024,
  input,
  stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] as ("ignore" | "pipe")[],
});

/** `timeout` kills the call; `bound` is the limit its expiry names (the stage's, when the call ran on what remained of it). */
function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string | Buffer, timeout?: number, bound = timeout): Buffer {
  try {
    return execFileSync("git", args, {
      ...runOptions(cwd, env, input),
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
function runOnWorkerTree(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string | Buffer, deadline = Date.now() + WORKER_TREE_GIT_TIMEOUT_MS): Buffer {
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
export function workerRepoGitUntil(deadline: number, cwd: string, args: string[], input?: string | Buffer): string {
  return runOnWorkerTree(cwd, args, undefined, input, deadline).toString().trim();
}

/** `run`・`gitReporting` と、github-auth.ts で盤面の網に出る git が最初に checkout を読む `checkoutOrigin` が共有する —— 網に出る git
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
