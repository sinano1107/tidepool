import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { GhVersionError } from "./gh-cli-version.js";
import type { GitHubClient } from "./github.js";
import { openQuarantineQuestion, registerQuarantine } from "./quarantine.js";
import { settleQuestionAsObserved } from "./tasks.js";

/** gh を撃つ GitHubClient の呼び出し —— PR の作成(REST)・push の準備・token の問い合わせは撃たない。merge の版の門は prepare にあるので、
 *  prepare が通れば版が通った(ADR 0402 決定2)。 */
const GH_CALLS = new Set<string | symbol>([
  "readPullRequest", "prepareMerge", "getPullRequestState", "findPullRequestByHead", "getIssue", "getIssueWithState",
  "listIssues", "addIssueComment", "repositoryParent", "forkPrCredentialSettings",
] satisfies Array<keyof GitHubClient>);

/** 信号の書き込みが投げても gh の呼び出しの結末(merge 済みなど)は差し替えない —— log に留めて飲み込む。 */
function logAndSwallow(write: () => void): void {
  try {
    write();
  } catch (err) {
    console.error("[github] could not record the gh version signal:", err);
  }
}

/** ADR 0402 決定3: 止めるのは client の版の門で、これは信号だけ —— 門の拒否を観測すれば「gh の版」の question を1枚立て、gh の呼び出しが
 *  通れば回答なしで決着させる(ADR 0184 決定5 の形)。読めなかった PR(`unreadable`)は通った証拠に数えない。 */
export function withGhVersionQuarantine(github: GitHubClient, db: Db, clock: Clock): GitHubClient {
  return new Proxy(github, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function" || !GH_CALLS.has(key)) return value;
      return async (...args: unknown[]) => {
        let result: unknown;
        try {
          result = await value.apply(target, args);
        } catch (err) {
          if (err instanceof GhVersionError) logAndSwallow(() => registerQuarantine(db, "ghVersion", null, err.message, clock.now()));
          throw err;
        }
        if ((result as { state?: unknown } | null)?.state !== "unreadable") {
          logAndSwallow(() => {
            const open = openQuarantineQuestion(db, "ghVersion", null);
            if (open) settleQuestionAsObserved(db, open.id, { kind: "quarantine_released", quarantine: "ghVersion", value: null }, clock.now());
          });
        }
        return result;
      };
    },
  });
}
