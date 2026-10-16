import { execFileSync } from "node:child_process";

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

/** ADR 0266 決定1: 盤面の git は background の `gc --auto` を起こさない —— pin の子の pickup の準備の repack / prune と競合する。
 *  引数でなく env の config に足すのは、コマンド行(失敗の本文に載る)を変えないため。ambient な `GIT_CONFIG_*` の後ろに足す。
 *  ponytail: registry clone のように盤面しか触らない clone は自動の gc を失う。loose object の溜まりが観測されたら明示の gc を */
export function withoutAutoGc(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const n = Number(env.GIT_CONFIG_COUNT ?? 0);
  return { ...env, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: "gc.auto", [`GIT_CONFIG_VALUE_${n}`]: "0" };
}

/** Shared by every board-driven git call (workspace.ts and workspace-create.ts).
 *  stderr captured, not inherited: git narrates checkouts on stderr and the
 *  board's console is not the place for it. */
export function git(cwd: string, ...args: string[]): string {
  return gitBytes(cwd, ...args).toString().trim();
}

/** `git` の生の stdout(`bundle create -` のような binary の出力用)。 */
export function gitBytes(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    env: withoutAutoGc({ ...process.env, ...TIDEPOOL_GIT_IDENTITY_ENV }),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: Infinity,
  });
}
