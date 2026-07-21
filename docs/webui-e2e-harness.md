# WebUI E2E ハーネス — 実ブラウザで `public/index.html` を駆動する

自動テストはサーバー境界で止める(ADR 0027)。`public/index.html` の React 配線層
(in-browser Babel・型検査なし)は自動テストで守られない唯一の層で、ここは issue の
完了基準を実機で一度見ておく **人間実施の受け入れ確認** で確認する。この doc は、その
確認を実ブラウザで回すための土台の型と、過去に溶かしたハマりどころをまとめたもの。

**位置づけ(ADR 0027)**: これは積み上げるテスト資産ではない。恒常的な UI リグレッションが
必要になったら(UI が単一 `index.html` を超えて育ったとき)、素の puppeteer 手駆動では
なく **Playwright のスモーク数本**を CI に載せる。この doc はその時の出発点であり、それ
までは一回性の受け入れ確認の再現手順として使う。初出は issue #106(skills ピッカー)。

## 土台の型

`tests/harness.ts` の `bootTidepool` を **in-process で起動**し、その実サーバーが配信する
実 WebUI を **puppeteer-core + システムの Chrome** で叩く。フルの Playwright セットアップ
なしで実 E2E が回る。フェイクは `bootTidepool` の seam(`agentAdmin`・`hostSkills` など)で
差し込むので、実 registry / git を用意せずに UI 配線だけを検証できる。

```bash
# 一度だけ:スクラッチ領域に puppeteer-core を入れる(repo の依存にはしない)
cd <scratch> && npm init -y && npm install puppeteer-core
```

```ts
import puppeteer from "puppeteer-core";
import { bootTidepool } from "<repo>/tests/harness.ts"; // tsx で実行

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; // macOS

const t = await bootTidepool({
  // 検証したい画面が必要とする seam だけフェイクで差す
  agentAdmin: { list: () => [...], authorityProfiles: () => [...], create: async () => ({ pushed: true }), update: async () => ({ pushed: true }) },
  hostSkills: async () => ["deep-research", "plugin-a:foo"],
});
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto(t.baseUrl, { waitUntil: "networkidle2" });
// … 画面を駆動してアサート、失敗時は page.screenshot で目視 …
await browser.close();
await t.stop();
```

`npx tsx <script>.mts` で実行(tsx が `bootTidepool` の TS を都度トランスパイルする)。
`public/index.html` は React / Babel standalone / lucide を unpkg CDN から読むので、実行環境に
**ネットワークが要る**(`/styles.css`・`/_ds_bundle.js`・`/kit/*.jsx` はボードが配信)。

## ハマりどころ(先人が溶かした時間)

1. **`.claude/worktrees/…` 配下だと静的アセットが 404 → issue #108 で修正済み。**
   `res.sendFile(絶対パス)` は Express の `send` が絶対パス全体を dotfile 判定し、`.claude`
   のような dot 始まり祖先があると `dotfiles: 'ignore'` で `styles.css`/`_ds_bundle.js` が
   404、WebUI 全体が "recompile the design system" フォールバックになる。`server.ts` は
   `sendFile("styles.css", { root })` に直したので **worktree 内でもそのまま起動できる**。
   もしこの 404 が再発したら真っ先にこの経路を疑う(`tests/static-assets-endpoint.test.ts`
   がこの suite を `.claude/worktrees` 配下で走らせたときに実 repro になる)。

2. **`page.evaluate` の中で `const 名前 = () => …` を書くと落ちる。** tsx/esbuild の
   keep-names がその arrow を `__name(...)` でラップし、ブラウザ側に `__name` が無いので
   `ReferenceError: __name is not defined`。**名前付きの内部関数を作らずインライン化**する
   (プロパティ代入 `window.__x = () => …` は影響を受けない)。

3. **Design System コンポーネントの掴み方**(`_ds_bundle.js`):
   - `Select` は native `<select>`、`Input` は placeholder 付き native `<input>` →
     `input[placeholder^="…"]` で狙える。`page.select()` / native value setter が効く。
   - React 制御 input への入力は `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set` を
     `call` してから `input` イベントを bubble させる(単に `el.value=` では onChange が発火しない)。
   - `Tag` の色は `neutral|tide|sun|coral|grass` のみ(無効色は無視されて素通り)。
   - **`innerText` は CSS `text-transform` を反映する**。大文字化されるセクションラベル
     (例 "add an agent" → "ADD AN AGENT")を小文字で `includes` すると一致しない。素の
     文言で照合するか `textContent` を使う。

4. **同じコンポーネントが複数描画される時は root スコープで操作する。** 例えば skills
   ピッカーは各 AgentCard と作成フォームの両方に出る。「先頭の子が特定ラベルの `<div>`」で
   各インスタンスの root を特定し、その root 配下だけで select / tag / 自由入力を触ると
   相互汚染しない。カードの描画順は `list()` 順に一致するのでインデックスで同定できる。

5. **フルの `puppeteer` は要らない。** `puppeteer-core` + `executablePath` にシステムの
   Chrome を渡せば、Chromium のダウンロードなしで動く。

## 参照

- ADR 0027(自動テストはサーバー境界で止め、ブラウザ駆動は受け入れ確認に限る)
- `tests/harness.ts`(`bootTidepool`)/ `tests/skill-picker-endpoint.test.ts`(境界テストの例)
- issue #108(dotfile 404 の root cause と修正)/ issue #106(初出:skills ピッカー)
