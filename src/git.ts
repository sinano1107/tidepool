import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

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

/** `git` に env を足したもの(一時 index の `GIT_INDEX_FILE` 用)。 */
export function gitWithEnv(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): string {
  return run(cwd, args, env).toString().trim();
}

/** `git` に stdin を渡したもの(`--stdin` を取る subcommand 用)。 */
export function gitWithInput(input: string, cwd: string, ...args: string[]): string {
  return run(cwd, args, undefined, input).toString().trim();
}

/** 盤面の local の git の env の持ち主。ADR 0339 Status 追記: 転送は `file` だけ —— `insteadOf`・submodule・部分 clone の遅延 fetch が
 *  人間の身元で網に出る経路を verb を数えずに閉じる。最後に spread するので呼び手の env にも process.env にも広げさせない。 */
export function localGitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...TIDEPOOL_GIT_IDENTITY_ENV, ...env, GIT_ALLOW_PROTOCOL: "file" };
}

function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Buffer {
  try {
    return execFileSync("git", args, {
      cwd,
      env: localGitEnv(env),
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
