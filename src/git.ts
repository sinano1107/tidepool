import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The board's own git identity: the author on the tree rule's WIP commits
 *  (releaseTree) and on the registry commits the WebUI flows make (issue #57,
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

/** ADR 0356 決定3: borrow the checkout's objects while keeping its config, index, and ignore metadata out of the board's view. */
export function withBoardGit<T>(cwd: string, use: (view: (args: string[], overrides?: NodeJS.ProcessEnv) => string, gitDir: string) => T): T {
  const format = git(cwd, "rev-parse", "--show-object-format");
  const objects = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "objects");
  const dir = mkdtempSync(join(tmpdir(), "tidepool-git-view-"));
  try {
    git(dir, "init", "--bare", "--quiet", "--template=", `--object-format=${format}`);
    const env = { GIT_DIR: dir, GIT_WORK_TREE: resolve(cwd), GIT_INDEX_FILE: join(dir, "index"), GIT_OBJECT_DIRECTORY: objects };
    return use((args, overrides) => run(dir, args, { ...env, ...overrides }).toString(), dir);
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

export function boardWorktreeStatus(cwd: string, sparse?: SparsePolicy, against?: string): WorktreeChange[] {
  const index = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index");
  let head: string | undefined;
  try {
    head = against ?? git(cwd, "rev-parse", "--verify", "--quiet", "HEAD");
  } catch (err) {
    if ((err as { status?: number }).status !== 1) throw err;
  }
  return withBoardGit(cwd, (view, dir) => {
    if (head !== undefined) {
      view(["update-ref", "--no-deref", "HEAD", head]);
      view(["read-tree", head]);
    }
    const config = sparseOptions(dir, sparse);
    if (sparse && head !== undefined) {
      // ADR 0293 決定3 / ADR 0356 決定3: apply sparse policy on a blank tree instead of trusting the real index's marks.
      const empty = join(dir, "empty");
      mkdirSync(empty);
      view(["-C", empty, "-c", "core.bare=false", ...config, "sparse-checkout", "reapply"], { GIT_WORK_TREE: empty });
    }
    const worktree = view([...config, "status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=dirty"]);
    const paths = new Map(worktree.split("\0").filter(Boolean).map((line) => [line.slice(3), line.slice(0, 2)]));
    // ADR 0084 決定1: the real index can hold staged content that is absent from the worktree.
    const staged = view(["diff", "--cached", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--ignore-submodules=dirty", "--"], { GIT_INDEX_FILE: index }).split("\0");
    for (let i = 0; i + 1 < staged.length; i += 2) {
      const path = staged[i + 1]!;
      if (!paths.has(path)) paths.set(path, `${staged[i]} `);
    }
    // ADR 0356 決定3: Git's recursive status would run each populated submodule's own filters.
    for (const entry of view(["ls-files", "--stage", "-z"]).split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const path = entry.slice(entry.indexOf("\t") + 1);
      if (paths.has(path)) continue;
      const submodule = join(cwd, path);
      if (!lstatSync(submodule, { throwIfNoEntry: false })?.isDirectory() || !existsSync(join(submodule, ".git"))) continue;
      if (boardWorktreeStatus(submodule).length > 0) paths.set(path, " M");
    }
    return [...paths].map(([path, status]) => ({ path, status }));
  });
}

/** `git` に env を足したもの(一時 index の `GIT_INDEX_FILE` 用)。 */
export function gitWithEnv(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): string {
  return run(cwd, args, env).toString().trim();
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

function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Buffer {
  try {
    return execFileSync("git", args, {
      cwd,
      env: localGitEnv(env),
      maxBuffer: 64 * 1024 * 1024,
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (err) {
    rethrowNamingMissingCwd(err, cwd, args);
  }
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
