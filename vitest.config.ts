import { configDefaults, defineConfig } from "vitest/config";

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
    // docs/experiments/ の review 対象は欠陥を仕込んだ教材で、node:test 形式。盤面のテストではない。
    exclude: [...configDefaults.exclude, "e2e/**", "docs/experiments/**", ...(canary ? [] : ["tests/canary/**"])],
    // 実 process の canary は敵対的な子孫の生存確認に秒単位で待つので、時限もここで一緒に切り替える
    ...(canary ? { testTimeout: 60_000, hookTimeout: 60_000 } : {}),
  },
});
