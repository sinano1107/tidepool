import { configDefaults, defineConfig } from "vitest/config";
import { DurationSequencer } from "./scripts/test-sequencer.js";

// vitest の default include は `**/*.spec.ts` も拾うが、`e2e/` の spec は Playwright
// のもので vitest では動かない。サーバー境界までの vitest テストは `tests/*.test.ts`、
// ブラウザ E2E は `e2e/*.spec.ts`(ADR 0027 / 0029)と層で分ける。ここで e2e を除外する。
// tests/canary/ は実カーネルの機構を実 process で測る opt-in の contract suite
// (ADR 0027 / ADR 0099 決定5)。既定の `npm test` からは外れ、`npm run canary:container`
// だけがこの env で拾う。CLI の `--exclude` は config の exclude に**足す**ので上書きに
// 使えず、実行契機の分岐はここに置くしかない。
const canary = process.env.TIDEPOOL_CANARY !== undefined;

export default defineConfig({
  test: {
    // globalSetup は main process で順に走り、worker は main process の env を受け継ぐ。先頭で呼び手の GIT_DIR などを落とすと(#3334)、
    // 次の test lock の `git rev-parse --git-common-dir` も全 worker の git も覆う —— 順を入れ替えると lock が呼び手の repo に queue を作る。
    // test lock は worktree 間の直列化。main process で1度だけ走る面なので globalSetup に置く(worker ごとの setupFiles ではない)
    globalSetup: ["scripts/repo-location-git-env.mjs", "scripts/test-lock.ts"],
    // --shard を CI の実測の所要秒で均す(scripts/test-sequencer.ts)。shard しない run の順は既定のまま
    sequence: { sequencer: DurationSequencer },
    // テストの git(src/ から起動するものも含む)に auto maintenance を走らせない(issue #842)
    env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false" },
    // docs/experiments/ の review 対象は欠陥を仕込んだ教材で、node:test 形式。盤面のテストではない。
    // .claude/worktrees/ は並行実装中の別 checkout で、拾うと main の実行が worktree の数だけ重くなる。
    exclude: [
      ...configDefaults.exclude,
      "e2e/**",
      "docs/experiments/**",
      ".claude/worktrees/**",
      ...(canary ? [] : ["tests/canary/**"]),
    ],
    // 実 process の canary は敵対的な子孫の生存確認に秒単位で待つので、時限もここで一緒に切り替える
    ...(canary ? { testTimeout: 60_000, hookTimeout: 60_000 } : {}),
  },
});
