import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
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
 *  ref も reflog も無ければ空、reflog が無ければ(update-ref で作った)今の値だけ —— そのとき `@{0}` が落ちるのを読めなさと取り違えない。
 *  並べるか投げるかのどちらかで、git が件を落とした短い並びは返さない(#3826)。ADR 0357 決定1: `bounded` は worker の bytes(作業台)の
 *  読みを `workerRepoGit` と同じ1つの上限で撃つ。
 *  shortcut: 1件ごとに git を1度起こす —— stash が数百件に積まれて遅くなれば reflog を1度で読む口に替える。 */
export function stashEntries(cwd: string, bounded = false): string[] {
  const readGit = (...args: string[]) => gitListing(cwd, args, bounded);
  const log = resolve(cwd, readGit("rev-parse", "--git-path", "logs/refs/stash"));
  // file の読みの失敗(権限、途中の stash drop で消えた file)も、git の読みの失敗と同じく読めない並び
  const onLog = <T>(read: () => T): T => {
    try {
      return read();
    } catch (cause) {
      throw new ListingUnreadableError(`the reflog of refs/stash at ${log} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  };
  const logStat = onLog(() => lstatSync(log, { throwIfNoEntry: false }));
  // #3826: FIFO などは開けば読みが止まり、git は「reflog が無い」と答える —— git にも盤面にも開かせずに投げる
  if (logStat && !logStat.isFile()) throw new ListingUnreadableError(`the reflog of refs/stash at ${log} is not a regular file`);
  const hasLogFile = logStat !== undefined;
  let top = "";
  const hasRef = gitAnswers(() => (top = readGit("rev-parse", "--verify", "--quiet", "refs/stash")));
  const hasLog = gitAnswers(() => readGit("reflog", "exists", "refs/stash"));
  // stash の pop・drop・clear は最後の件で ref と reflog を一緒に消す —— reflog だけ残るのは壊れた ref(#3826)
  if (!hasRef && (hasLogFile || hasLog)) throw new ListingUnreadableError(`refs/stash is absent but its reflog remains at ${log}`);
  if (!hasRef) return [];
  if (!hasLog && hasLogFile) throw new ListingUnreadableError(`git reads no reflog of refs/stash, but ${log} is there`);
  if (!hasLog) return [top];
  const entries: string[] = [];
  for (let n = 0; ; n++) {
    try {
      entries.push(readGit("rev-parse", "--verify", `refs/stash@{${n}}`));
    } catch (err) {
      // 空の reflog と読めない reflog を git は同じ「is empty」で言うので、それは件の数の終わりに数えない
      const count = /^fatal: log for '.*' only has (\d+) entries$/m.exec(String((err as { stderr?: unknown }).stderr ?? ""))?.[1];
      if (count === undefined) throw err;
      // #3826: git は壊れた行を飛ばして件の数を少なく言う(一番古い行なら警告も無い)—— 警告の文でなく file の行の数と比べる
      // reflog が在るのに file が無いのは reftable —— 行の数は取れない
      if (hasLogFile) {
        const lineCount = onLog(() => readFileSync(log, "utf8").split("\n").filter(Boolean).length);
        if (lineCount !== Number(count)) throw new ListingUnreadableError(`the reflog of refs/stash at ${log} has ${lineCount} lines but git reads ${count} entries`);
      }
      // 一番古い件の old 値が 0 でなければ(`--rewrite` なしの delete や expire の後)、git は `@{件の数}` にその old 値を返す
      return [...new Set([top, ...entries.slice(0, Number(count))])];
    }
  }
}

/** #3826: git が件を落としたか数えられなかった —— 並びは短いので、答えにしない。 */
export class ListingUnreadableError extends Error {}

/** ADR 0378 決定4: read the configured origin before applying insteadOf. A missing `cwd` names `verb`, the call the read is for. */
export function readOriginConfig(cwd: string, verb: string): string | undefined {
  return readConfig((args) => run(cwd, args, undefined, undefined, undefined, undefined, verb), ["remote.origin.url"]);
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
  // ADR 0412 決定2(#3814): stage は worker の worktree と盤面の写しだけを読む —— 写しが名前の場所を借りていれば盤面の不変条件の破れで、型を付けない
  if (stage && existsSync(join(objects, "info", "alternates"))) {
    throw new Error(`the board cannot stage ${cwd}: the repo it stages over (${objectsFrom}) borrows other objects through objects/info/alternates`);
  }
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

/** ADR 0356 決定2 / ADR 0364 決定2 / ADR 0367 決定1: checkout や盤面の一時 repo を用意する host 側の失敗。ADR 0433 決定5: 盤面のどの git でも、
 *  disk が満ちて落ちたもの(`GitOutOfSpaceError`)も含む。 */
export class CheckoutHostError extends Error {}

/** ADR 0433 決定5: git の実行の出所が、disk が満ちて落ちた git を投げる host の失敗。文は git のもの —— 段は自分の文で包み直す。 */
export class GitOutOfSpaceError extends CheckoutHostError {}

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
  return saysOutOfSpace(cause) || noFreeSpace(dir);
}

/** 失敗そのもの(fs の ENOSPC か git の stderr)が容量切れと言う。 */
const saysOutOfSpace = (cause: unknown) =>
  (cause as NodeJS.ErrnoException | null)?.code === "ENOSPC" || String((cause as { stderr?: unknown } | null)?.stderr ?? "").includes("No space left on device");

/** `dir` の fs に、盤面のユーザーが使える空きが無い —— 容量切れと言わない書き込みの失敗を読む。 */
function noFreeSpace(dir: string): boolean {
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
 *  `ahead`, the paths the view excludes take the ref's entries. ADR 0412 決定2: an `objectsFrom` with `objects/info/alternates` throws an
 *  untyped Error before the worktree is read —— borrow the named place's objects inside `use`, after the stage. */
export function boardWriteTree<T>(cwd: string, head: string, objectsFrom: string, use: (tree: string, gitDir: string) => T, exclude: string[] = [], ahead?: RecordedAhead): T {
  // ADR 0412 決定3: ref の entry は名前の場所の側の段で読む(tree だけ、blob は読まない)—— 失敗は git の実行の出所の型のまま投げる
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
      if (cause instanceof GitOutOfSpaceError) throw stagingHostError(cause);
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

/** ADR 0423 決定3: 記録の tree は名前の場所で読み、stage の tree だけを有界で読む。Git の path は byte 列なので、表示に直す前に比べる。 */
export function stagedGitlinkChanges(recorded: { at: string; ref: string }, staged: { at: string; ref: string }): string[] {
  const lsTree = (ref: string) => ["--no-replace-objects", "ls-tree", "-r", "-z", ref];
  const gitlinks = (entries: Buffer) => entries.toString("latin1").split("\0").filter((line) => line.startsWith(`${GITLINK_MODE} `));
  const before = new Set(gitlinks(run(recorded.at, lsTree(recorded.ref))));
  return gitlinks(runOnWorkerTree(staged.at, lsTree(staged.ref)))
    .filter((line) => !before.has(line))
    .map((line) => Buffer.from(entryPath(line), "latin1").toString());
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
  return gitBytesWithInput(input, cwd, ...args).toString().trim();
}

/** `gitWithInput` の出力を byte のまま —— 呼び手が byte 数で切る(`cat-file --batch`)。 */
export function gitBytesWithInput(input: string, cwd: string, ...args: string[]): Buffer {
  return run(cwd, args, undefined, input);
}

/** ADR 0409 決定2: git that exits 0 can still report something on stderr, so this runner returns both. A non-zero exit throws like `git`,
 *  with `status` and `stderr`. `timeout` and `bound` are `run`'s; `runOnWorkerTree` passes them. */
export function gitReporting(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  input?: string | Buffer,
  timeout?: number,
  bound = timeout,
): { stdout: string; stderr: string } {
  const result = spawnSync("git", args, { ...runOptions(cwd, localGitEnv(env), input), ...timeoutOptions(timeout) });
  const stderr = result.stderr?.toString() ?? "";
  if (result.error) throwFailure(cwd, args, result.error, result.pid, stderr, { timeout, bound });
  if (result.status !== 0) throwFailure(cwd, args, Object.assign(new Error(`Command failed: git ${args.join(" ")}\n${stderr}`), { status: result.status, stderr }), result.pid, stderr, { timeout, bound });
  return { stdout: result.stdout.toString(), stderr };
}

/** ADR 0356 決定5 / ADR 0339 決定1: build the local environment and keep transport restricted to file. */
function localGitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

/** The spawn options `startGit` and `gitReporting` share (with `timeoutOptions` and `throwFailure`). `env` is passed as built. */
const runOptions = (cwd: string, env: NodeJS.ProcessEnv, input: string | Buffer | undefined) => ({
  cwd,
  env,
  maxBuffer: 64 * 1024 * 1024,
  input,
  stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] as ("ignore" | "pipe")[],
});

// ADR 0334: Node's timeout kills only the parent git, so it runs in its own process group and `throwTimedOut` also
// reaches a child (`upload-pack`, a git blocked in `open()`). SIGTERM so git removes its lock files
const timeoutOptions = (timeout: number | undefined) => timeout !== undefined && { timeout, killSignal: "SIGTERM" as const, detached: true };

/** A call `timeoutOptions` bounded ran out: kill its process group and name `bound`. */
function throwTimedOut(err: unknown, pid: number | undefined, stderr: Buffer | string | undefined, args: string[], bound: number): never {
  try {
    if (pid) process.kill(-pid, "SIGTERM");
  } catch {
    // the group has already exited
  }
  throw new WorkerTreeGitTimeoutError(subcommandOf(args), bound, stderr?.toString().split("\n")[0]?.trim() ?? "", { cause: err });
}

/** The local runner: `env` overrides `localGitEnv`. `timeout` kills the call; `bound` is the limit its expiry names (the stage's, when
 *  the call ran on what remained of it). `verb` is `Launch`'s. */
function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string | Buffer, timeout?: number, bound = timeout, verb?: string): Buffer {
  return startGit(cwd, args, localGitEnv(env), { input, timeout, bound, verb });
}

/** ADR 0441 決定2・4: the network git's launch, with github-auth's built env as it is. Only a missing cwd and this host's failure come
 *  back typed; any other failure is thrown as git failed, and github-auth classifies it. A lint keeps this to github-auth (決定3). */
export function networkGit(cwd: string, args: string[], env: NodeJS.ProcessEnv): Buffer {
  return startGit(cwd, args, env, { network: true });
}

type Launch = {
  input?: string | Buffer;
  timeout?: number;
  bound?: number;
  /** the subcommand a missing cwd names, when the call stands for another (`readOriginConfig`) */
  verb?: string;
  /** ADR 0441 決定4: network git —— a failure that is neither a missing cwd nor this host's is thrown as git failed, and the lines the
   *  remote wrote on stderr do not count as this host running out of space */
  network?: boolean;
};

/** ADR 0441 決定1: `startGit` and `gitReporting` are the git module's launch points —— every board git child starts at one of them, with
 *  `env` built by the caller, and its failure is typed once (`throwFailure`). */
function startGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, launch: Launch): Buffer {
  try {
    return execFileSync("git", args, { ...runOptions(cwd, env, launch.input), ...timeoutOptions(launch.timeout) });
  } catch (err) {
    const { pid, stderr } = err as { pid?: number; stderr?: Buffer };
    throwFailure(cwd, args, err as Error, pid, stderr, launch);
  }
}

/** A failed launch: a bounded call that ran out kills its process group (`throwTimedOut`); any other failure is typed (`gitFailure`). */
function throwFailure(
  cwd: string,
  args: string[],
  err: Error & GitToolFields,
  pid: number | undefined,
  stderr: Buffer | string | undefined,
  { timeout, bound = timeout, verb, network = false }: Launch,
): never {
  if (timeout !== undefined && err.code === "ETIMEDOUT") throwTimedOut(err, pid, stderr, args, bound ?? timeout);
  throw gitFailure(cwd, verb ? [verb] : args, err, network);
}

/** #3826: git that lists refs or reflog entries skips one it cannot read with only a warning on stderr, its exit still 0 (or 1, a
 *  predicate's "no"), so this read looks at stderr whatever the exit and throws on that warning — the one place that matches its words.
 *  A non-zero exit throws like `git`; `bounded` bounds the call like `workerRepoGit` (ADR 0357 決定1). */
export function gitListing(cwd: string, args: string[], bounded = false): string {
  let reported: { stdout: string; stderr: string };
  try {
    reported = bounded ? runOnWorkerTree(cwd, args, undefined, undefined, undefined, gitReporting) : gitReporting(cwd, args);
  } catch (err) {
    const said = String((err as { stderr?: unknown }).stderr ?? "").trim();
    // 述語の「no」(exit 1)が stderr に何か言えば、それは答えでなく読めなかったもの
    if ((err as { status?: unknown }).status === 1 && said) throw new ListingUnreadableError(`git could not read a ref (${said})`, { cause: err });
    throw err;
  }
  const skipped = /^warning: ignoring (?:broken ref|dangling symref) .*$/m.exec(reported.stderr)?.[0];
  if (skipped) throw new ListingUnreadableError(`git could not read a ref (${skipped})`);
  return reported.stdout.trim();
}

/** ADR 0357 決定1: the one runner for the git the board runs on a worker's tree or repo, bounded by one constant. ADR 0364 決定3: a call
 *  inside one bounded stage runs on what remains before the stage's `deadline`, and its expiry names the constant. It spawns with `run`,
 *  or with `gitReporting` when the caller reads stderr (`gitListing`). */
function runOnWorkerTree<T = Buffer>(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  input?: string | Buffer,
  deadline = Date.now() + WORKER_TREE_GIT_TIMEOUT_MS,
  spawn = run as (cwd: string, args: string[], env: NodeJS.ProcessEnv | undefined, input: string | Buffer | undefined, timeout: number, bound: number) => T,
): T {
  const remaining = deadline - Date.now();
  // execFileSync の timeout 0 は無期限 —— 使い切った段では撃たない
  if (remaining <= 0) throw new WorkerTreeGitTimeoutError(subcommandOf(args), WORKER_TREE_GIT_TIMEOUT_MS, "");
  return spawn(cwd, args, env, input, remaining, WORKER_TREE_GIT_TIMEOUT_MS);
}

/** ADR 0357 決定1 / ADR 0364 決定3: bounded Git for worker bytes, including reads and fetches from board-owned copies. */
export function workerRepoGit(cwd: string, ...args: string[]): string {
  return runOnWorkerTree(cwd, args).toString().trim();
}

/** ADR 0364 決定3: git inside the copy-and-verify stage, all bounded by the stage's one `deadline`. */
export function workerRepoGitUntil(deadline: number, cwd: string, args: string[], input?: string | Buffer): string {
  return runOnWorkerTree(cwd, args, undefined, input, deadline).toString().trim();
}

/** Node は cwd が無いときも git が PATH に無いときも在り処を言わない「spawnSync git ENOENT」だけを投げ、それが quarantine の理由にそのまま
 *  載る(issue #2722)—— cwd が無いほうだけを在り処を名指す git の道具の失敗(ADR 0433 決定3)にする。 */
const missingCwd = (code: string | undefined, cwd: string, args: string[], cause: unknown) =>
  code === "ENOENT" && !existsSync(cwd) ? new GitToolError(`\`git ${subcommandOf(args)}\` cannot run: the directory ${cwd} does not exist`, { cause }) : undefined;

/** The fields a failed git call carries — `execFileSync`'s, or `gitReporting`'s `status` and `stderr`. */
type GitToolFields = Pick<GitToolError, "status" | "stderr" | "stdout" | "code" | "pid">;

/** ADR 0433 決定3: 盤面の git が非零で終わった・起動できなかった・cwd が無い失敗。message と欄は `execFileSync` の失敗のまま —— 述語の答え
 *  (`status` 1)と stderr を読む手が今までどおり読む。path は持たない —— どの場所かは段の帰責が決める。 */
export class GitToolError extends Error {
  status?: number | null;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
  code?: string;
  pid?: number;
}

/** ADR 0433 決定3・5: `throwFailure` の失敗 `err` の出所 —— disk が満ちた失敗は host の失敗、残りは git の道具の失敗。元の失敗は欄に写すので
 *  cause に持たない(cwd が無い失敗だけが今までどおり持つ)。`network` は `Launch` のもの。 */
function gitFailure(cwd: string, args: string[], err: Error & GitToolFields, network: boolean): Error {
  const { message, status, stderr, stdout, code, pid } = err;
  const missing = missingCwd(code, cwd, args, err);
  if (missing) return missing;
  // 述語の「no」(exit 1)は答え —— 空き 0 を返す fs でも host の失敗にしない。空きを見るのは git が容量切れと言わない失敗だけ
  if (saysOutOfSpace(network ? { code, stderr: ownLines(stderr) } : err) || (status !== 1 && noFreeSpace(cwd))) {
    // `stderr` と `code` も持つ —— 写す段の `outOfSpace` が同じ欄で読む。staging と写す段はこの型を見て段の文で包み直す
    return Object.assign(new GitOutOfSpaceError(`the host is out of space: ${message}`), { code, stderr });
  }
  // ADR 0441 決定4: 網に出る git の一般の失敗の型は #3999 が決める —— git が投げたまま返す
  return network ? err : Object.assign(new GitToolError(message), { status, stderr, stdout, code, pid });
}

/** ADR 0441 決定4: 網に出る git の stderr のうち手元の git の行 —— 相手が書いた行(`remote: …`、`fatal: remote error: …`)は相手の disk の話。 */
const ownLines = (stderr: Buffer | string | undefined) =>
  String(stderr ?? "").split("\n").filter((line) => !/^(remote: |fatal: remote error: )/.test(line)).join("\n");
