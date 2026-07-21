import { test as base } from "@playwright/test";
import { type BootOptions, bootTidepool, type Tidepool } from "../tests/harness.js";

// Playwright から使う bootTidepool の口。事前起動したインスタンスを配るのでは
// なく `boot(opts)` 関数を配るのは、画面ごとに要る seam が違うから(skills
// ピッカーは hostSkills、settings は agentAdmin、…)。テストは必要な seam だけ
// フェイクで差してボードを一台起こす。起こした台は fixture 側で全部 stop する。
type Fixtures = {
  boot: (opts?: BootOptions) => Promise<Tidepool>;
};

export const test = base.extend<Fixtures>({
  // 第一引数は Playwright が object destructuring を必須にしている(依存 fixture
  // を名前で解決するため)。boot は他 fixture に依存しないので空 `{}`。biome の
  // noEmptyPattern はこの Playwright イディオムと衝突するので個別に無効化する。
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture requires object destructuring
  boot: async ({}, use) => {
    const booted: Tidepool[] = [];
    await use(async (opts) => {
      const t = await bootTidepool(opts);
      booted.push(t);
      return t;
    });
    for (const t of booted) await t.stop();
  },
});

export { expect } from "@playwright/test";
