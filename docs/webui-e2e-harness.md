# WebUI E2E ハーネス — 実ブラウザで `public/index.html` を駆動する

自動テストはサーバー境界で止める(ADR 0027)。`public/index.html` の React 配線層
(in-browser Babel・型検査なし)は自動テストで守られない唯一の層で、ここは実ブラウザで
駆動して確かめる。かつては人間の受け入れ確認に委ねていたが、いまはエージェントが
Playwright でこの確認まで担う(ADR 0029)。この doc は、その確認を回すための土台の型と、
過去に溶かしたハマりどころをまとめたもの。

**ツールは Playwright に統一した。** 素の puppeteer-core 手駆動はやめ、突発確認も昇格資産も
同じ Playwright Test で書く。理由は、突発確認と恒久スモークの書式を揃えておくと、昇格が
`rename + セレクタ整形` だけで済むから(ADR 0029)。

## 2 系統、同じ config

- `e2e/*.spec.ts` — **昇格済みスモーク**。git 管理し、CI(の e2e job)で回す恒久資産。
- `e2e/*.scratch.spec.ts` — **使い捨ての突発確認**。`.gitignore` 済み。資産にしない。

どちらも `.spec.ts` 終端なので Playwright の default testMatch が両方拾う。実行は
`npm run e2e`(= `playwright test`)。既定は **scratch を書いて回すだけ**。昇格は下記の
条件を満たしたうえで、ユーザーが明示的に指示したときだけ行う。

## 土台の型

`tests/harness.ts` の `bootTidepool` を **in-process で起動**し、その実サーバーが配信する
実 WebUI を **Playwright + システムの Chrome**(`channel: "chrome"`)で叩く。Chromium
バイナリの DL は不要。フェイクは `bootTidepool` の seam(`agentAdmin`・`hostSkills` など)で
差し込むので、実 registry / git を用意せずに UI 配線だけを検証できる。

- `playwright.config.ts` — `webServer` は使わない(サーバーは各テストが in-process で起こす)。
  `channel: "chrome"`、`expect.timeout` は CDN + Babel 描画のため寛容(15s)に。
- `e2e/fixtures.ts` — `boot(opts)` **関数**を配る fixture。事前起動したインスタンスではなく
  関数を配るのは、画面ごとに要る seam が違うから。起こした台は fixture が全部 `stop()` する。

```ts
import { expect, test } from "./fixtures.js";

test("空ボードが triage 空状態を実ブラウザで描く", async ({ boot, page }) => {
  const t = await boot(); // 画面が要る seam だけ opts で差す
  await page.goto(t.baseUrl);
  await expect(page.getByText("Low tide. Go enjoy your coffee.")).toBeVisible();
});
```

`public/index.html` は React / Babel standalone / lucide を unpkg CDN から読み、全 `.jsx` を
**in-browser で Babel コンパイル**してからマウントする。初回描画はミリ秒でなく秒単位に
なり得るので、`networkidle` 待ちに頼らず **locator の auto-wait** に待たせる。

## 昇格の前提: CDN を CI でどう賄うか(最重要)

昇格資産の要件は「コード化・**CI に載る**・再利用可」(ADR 0027)。だが `public/index.html` は
React/Babel/lucide を **unpkg CDN から実行時に読む**。つまり **ローカルで緑 ≠ CI で回る**。
`e2e/*.spec.ts` を CI で回すには、次のどちらかを先に解決していること:

1. CI ランナーから unpkg に到達できる(外部依存・SRI 検証・レートに晒される — 脆い)、または
2. React/Babel/lucide と `.jsx` を vendor / precompile して CDN 依存を切る(堅いが作業が要る)。

**この precondition を満たさない spec は昇格させない**(= コミットしない)。突発 scratch は
ローカルで CDN に届けば十分なのでこの縛りは無く、`e2e/` の恒久資産にだけ効く。

## ハマりどころ(先人が溶かした時間)

Playwright への移行で **消えた**もの:

- **制御 input への入力。** `fill()` / `type()` は React の `onChange` が要るイベントを
  ちゃんと発火する。native value setter を手で叩く小細工(旧 puppeteer 時代)は不要。
- **`text-transform` の大文字化ズレ。** `getByRole` / `getByText` は accessible name /
  textContent で照合し、CSS の大文字化は効かない。素の文言でそのまま狙える。
- **複数インスタンスの取り違え。** `getByRole(...).filter()` や `locator.getByText` の
  スコープ、`getByTestId` で各インスタンス root を絞れる。手製の root 特定は基本不要。

**残る**もの:

- **静的アセット 404(worktree)。** `.claude/worktrees/…` 配下だと `res.sendFile(絶対パス)` が
  dotfile 判定で `styles.css`/`_ds_bundle.js` を 404 にする問題は issue #108 で
  `sendFile("x", { root })` に修正済み。worktree 内でもそのまま起動できる。再発したら
  真っ先にこの経路を疑う(`tests/static-assets-endpoint.test.ts` が repro)。
- **`page.evaluate` 内の名前付き関数。** これは Playwright でも残る。Playwright も
  `evaluate` の body を esbuild で変換し、keep-names が `const 名前 = () =>` を `__name(...)` で
  ラップしてブラウザ側 `__name` 不在で落とす。**Playwright で解決したわけではない** — ただ
  `getByRole`/`fill` が揃ったので `evaluate` を書く機会がめっきり減っただけ。使うなら
  インライン化する(プロパティ代入 `window.__x = () => …` は影響なし)。

## セレクタ戦略

原則 `getByRole` / `getByLabel` などユーザー可視のロールベース。文言依存の取得は避ける
(日本語 UI コピーは変わりうる)。クリティカルな導線で壊れやすい要素にだけ
`public/index.html` に `data-testid` を足して文言変更に強くする。Design System の掴み方:
`Select` は native `<select>`(`selectOption`)、`Input` は placeholder 付き native `<input>`。

## 参照

- ADR 0027(自動テストはサーバー境界で止め、ブラウザ駆動は積み上げない)
- ADR 0029(WebUI ブラウザ確認をエージェントが担い、人間の受け入れ確認ステップを廃止)
- `tests/harness.ts`(`bootTidepool`)/ `e2e/fixtures.ts`(`boot` fixture)
- `e2e/board.scratch.spec.ts`(型が噛み合うことを通した最初の緑・使い捨て)
- issue #108(dotfile 404 の root cause と修正)/ issue #106(初出:skills ピッカー)
