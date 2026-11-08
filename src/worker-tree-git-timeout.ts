/** 盤面が worker の tree / repo に撃つ git の上限(ADR 0357 決定5)。理由は worker の tree の大きさ —— 網の往復
 *  (`GIT_NETWORK_TIMEOUT_MS`)とも local binary の probe(`CAPABILITY_PROBE_TIMEOUT_MS`)とも違うので数を共有しない。 */
export const WORKER_TREE_GIT_TIMEOUT_MS = 30_000;

/** ADR 0357 決定2・3: 上限で止まった手。git が即座に落ちた「観測の失敗」とは型で分け、worker の repo の故障として扱う。 */
export class WorkerTreeGitTimeoutError extends Error {
  constructor(readonly subcommand: string, readonly timeoutMs: number, readonly stderrLine: string, options?: ErrorOptions) {
    super(`\`git ${subcommand}\` on the worker's tree did not finish within ${timeoutMs / 1000} s${stderrLine ? `: ${stderrLine}` : ""}`, options);
  }
}
