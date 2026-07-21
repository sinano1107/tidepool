import { configDefaults, defineConfig } from "vitest/config";

// vitest の default include は `**/*.spec.ts` も拾うが、`e2e/` の spec は Playwright
// のもので vitest では動かない。サーバー境界までの vitest テストは `tests/*.test.ts`、
// ブラウザ E2E は `e2e/*.spec.ts`(ADR 0027 / 0029)と層で分ける。ここで e2e を除外する。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
