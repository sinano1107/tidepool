import { defineConfig } from "@playwright/test";

// WebUI ブラウザ確認の土台(ADR 0027 / docs/webui-e2e-harness.md)。サーバーは
// `webServer` で別プロセス起動せず、各テストが e2e/fixtures.ts の `boot` で
// bootTidepool を in-process 起動して seam フェイクを差す。だからここには
// baseURL も webServer も無い。
//
// 通常の `npm run e2e` は昇格済みスモークだけを回す。使い捨ての突発確認は
// `npm run e2e:scratch -- <file>` で明示的に含めるので、ローカルの scratch が
// 恒久回帰や CI を赤くしない。
export default defineConfig({
  testDir: "./e2e",
  testIgnore: process.env.PLAYWRIGHT_SCRATCH ? undefined : /.*\.scratch\.spec\.ts/,
  // 各テストが自前のサーバーを ephemeral port で起動する。ポート衝突は無いが、
  // 並列数は控えめにして in-process サーバーの多重起動を抑える。
  workers: process.env.CI ? 2 : 4,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "list" : "line",
  use: {
    // @playwright/test と同じ lockfile で pin された同梱 Chromium を使う。
    // CI もローカルも `npx playwright install chromium` で同じ browser を得る。
    headless: true,
    // 失敗した突発確認を目視するための痕跡。
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // 15s / 45s は最初の昇格時点では据え置く(ADR 0055)。事前ビルドで描画は
  // 速くなったが、CI の実測を見ずに timeout まで同時に変えない。
  expect: { timeout: 15_000 },
  timeout: 45_000,
});
