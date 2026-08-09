# WebUI E2E ハーネス — 実ブラウザで `public/index.html` を駆動する

自動テストはサーバー境界で止める(ADR 0027)。`webui/app.jsx` と
`ui_kits/tidepool-webui/*.jsx` の React 配線層は TypeScript の型検査が効かない唯一の層で、
ここは生成された `public/app.js` を実ブラウザで駆動して確かめる。かつては人間の受け入れ確認に委ねていたが、いまはエージェントが
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
実 WebUI を **Playwright 同梱の Chromium** で叩く。`@playwright/test` と同じ lockfile で
ブラウザ版も pin される。フェイクは `bootTidepool` の seam(`agentAdmin`・`hostSkills` など)で
差し込むので、実 registry / git を用意せずに UI 配線だけを検証できる。

- `playwright.config.ts` — `webServer` は使わない(サーバーは各テストが in-process で起こす)。
  初回昇格では CI 実測前なので `expect.timeout` 15s / test timeout 45s を据え置いた。
- `e2e/fixtures.ts` — `boot(opts)` **関数**を配る fixture。事前起動したインスタンスではなく
  関数を配るのは、画面ごとに要る seam が違うから。起こした台は fixture が全部 `stop()` する。
- **`boot()` は bootstrap まで済ませる**(issue #153 / ADR 0036)。人間面は credential を
  要求するので、cookie を持たない `page` は盤面ではなく 401 の token 入力ページに着地する。
  fixture が `page.goto(bootstrapUrl(t.baseUrl))` を1回踏んで cookie を張るので、spec 本文は
  これまでどおり `page.goto(t.baseUrl)` でよい。**無認証の見え方そのものを確かめたい spec**
  だけが、その前に `page.context().clearCookies()` する。

```ts
import { expect, test } from "./fixtures.js";

test("空ボードが triage 空状態を実ブラウザで描く", async ({ boot, page }) => {
  const t = await boot(); // 画面が要る seam だけ opts で差す
  await page.goto(t.baseUrl);
  await expect(page.getByText("Low tide. Go enjoy your coffee.")).toBeVisible();
});
```

`scripts/build-webui-bundle.mjs` は kit 4本と `webui/app.jsx` を esbuild で事前変換し、
`public/app.js` に現在の script 順で連結する。React / ReactDOM / lucide も `public/vendor/` から
same-origin 配信され、盤面の実行コードは外部 CDN に依存しない。Google Fonts は従来どおり
外部配信で、失敗時は CSS の fallback font に落ちる。待ちは引き続き `networkidle` ではなく
**locator の auto-wait** に任せる。

## 昇格の基盤(ADR 0055)

issue #208 の最初の昇格で、かつて未達だった precondition はすべて解消した:

- WebUI 実行コードは vendor + precompile 済み。`tests/generated-assets.test.ts` が
  `public/app.js` / `public/vendor/*` / `_ds_bundle.js` の鮮度を守る。
- CI に独立した `e2e` job があり、同梱 Chromium を install して `e2e/*.spec.ts` を回す。
- `tsconfig.json` は `e2e` を含み、ローカル専用の `*.scratch.spec.ts` だけを除外する。
- 最初の恒久資産は `e2e/settings-drilldown.spec.ts`。追加昇格は引き続き明示指示された
  クリティカルパスだけに限る(ADR 0027 の「網羅を狙わない」線は変わらない)。

ローカルで同梱 Chromium が無ければ `npx playwright install chromium` を一度実行する。

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
所有する JSX (`webui/app.jsx`、共有部品なら `design-system/components/`、kit 固有なら
`ui_kits/`) に `data-testid` を足して文言変更に強くする。Design System の掴み方:
`Select` は native `<select>`(`selectOption`)、`Input` は placeholder 付き native `<input>`。

## 参照

- ADR 0027(自動テストはサーバー境界で止め、ブラウザ駆動は積み上げない)
- ADR 0029(WebUI ブラウザ確認をエージェントが担い、人間の受け入れ確認ステップを廃止)
- `tests/harness.ts`(`bootTidepool`)/ `e2e/fixtures.ts`(`boot` fixture)
- `e2e/settings-drilldown.spec.ts`(最初の昇格済みスモーク)
- ADR 0055(WebUI の事前ビルドと最初の E2E 昇格基盤)
- issue #108(dotfile 404 の root cause と修正)/ issue #106(初出:skills ピッカー)
