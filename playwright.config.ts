import { defineConfig } from "@playwright/test";

// WebUI ブラウザ確認の土台(ADR 0027 / docs/webui-e2e-harness.md)。サーバーは
// `webServer` で別プロセス起動せず、各テストが e2e/fixtures.ts の `boot` で
// bootTidepool を in-process 起動して seam フェイクを差す。だからここには
// baseURL も webServer も無い。
//
// 実行は 2 系統を同じ config で回す:
//   - e2e/*.spec.ts         昇格済みスモーク(git 管理・CI 対象)
//   - e2e/*.scratch.spec.ts 使い捨ての突発確認(.gitignore 済み)
// どちらも `.spec.ts` 終端なので default testMatch がそのまま拾う。
export default defineConfig({
  testDir: "./e2e",
  // 各テストが自前のサーバーを ephemeral port で起動する。ポート衝突は無いが、
  // 並列数は控えめにして in-process サーバーの多重起動を抑える。
  workers: process.env.CI ? 2 : 4,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "list" : "line",
  use: {
    // システムに入っている Chrome を使う(Chromium バイナリの DL 不要)。
    channel: "chrome",
    headless: true,
    // 失敗した突発確認を目視するための痕跡。
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // public/index.html は React / Babel standalone / lucide を unpkg CDN から読み、
  // 全 .jsx を in-browser で Babel コンパイルしてからマウントする。初回描画は
  // ミリ秒でなく秒単位になり得るので、locator の待ちは寛容に取る。
  // (この CDN 依存が「CI で回す資産」への昇格前提: docs/webui-e2e-harness.md)
  expect: { timeout: 15_000 },
  timeout: 45_000,
});
