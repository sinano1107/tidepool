/** 盤面が worker の tree / repo に撃つ git の上限(ADR 0357 決定5)。理由は worker の tree の大きさ —— 網の往復
 *  (`GIT_NETWORK_TIMEOUT_MS`)とも local binary の probe(`CAPABILITY_PROBE_TIMEOUT_MS`)とも違うので数を共有しない。 */
export const WORKER_TREE_GIT_TIMEOUT_MS = 30_000;

/** ADR 0357 決定2・3: 上限で止まった手。git が即座に落ちた「観測の失敗」とは型で分け、worker の repo の故障として扱う。 */
export class WorkerTreeGitTimeoutError extends Error {
  constructor(readonly subcommand: string, readonly timeoutMs: number, readonly stderrLine: string, options?: ErrorOptions) {
    super(`\`git ${subcommand}\` on the worker's tree did not finish within ${timeoutMs / 1000} s${stderrLine ? `: ${stderrLine}` : ""}`, options);
  }
}

/** ADR 0364 決定3: 盤面が worker の `.git` の file を読み写す手も同じ上限で、超過は同じ型(worker の repo の故障)。 */
export class WorkerGitCopyTimeoutError extends WorkerTreeGitTimeoutError {
  constructor(timeoutMs: number) {
    super("", timeoutMs, "");
    this.message = `reading the git files of the worker's tree did not finish within ${timeoutMs / 1000} s`;
  }
}
