import { test as base } from "@playwright/test";
import { type BootOptions, bootstrapUrl, bootTidepool, type Tidepool } from "../tests/harness.js";

// Playwright から使う bootTidepool の口。事前起動したインスタンスを配るのでは
// なく `boot(opts)` 関数を配るのは、画面ごとに要る seam が違うから(skills
// ピッカーは hostSkills、settings は agentAdmin、…)。テストは必要な seam だけ
// フェイクで差してボードを一台起こす。起こした台は fixture 側で全部 stop する。
type Fixtures = {
  boot: (opts?: BootOptions) => Promise<Tidepool>;
};

export const test = base.extend<Fixtures>({
  // 起こした台の bootstrap まで fixture が済ませる(issue #153 / ADR 0036): 人間面は
  // credential を要求するので、素の `page.goto(t.baseUrl)` は盤面ではなく 401 の
  // token 入力ページに着地する。vitest 側で `api()` が bearer を付けているのと同じ
  // 判断 — spec 本文は認証の存在を知らないままでよい。無認証の見え方そのものを
  // 確かめたい spec だけが、この前に `page.context().clearCookies()` する。
  boot: async ({ page }, use) => {
    const booted: Tidepool[] = [];
    await use(async (opts) => {
      const t = await bootTidepool(opts);
      booted.push(t);
      // cookie はオリジン単位。台ごとに1回ここを踏めば以後の遷移は cookie で通る
      await page.goto(bootstrapUrl(t.baseUrl));
      return t;
    });
    for (const t of booted) await t.stop();
  },
});

export { expect } from "@playwright/test";
