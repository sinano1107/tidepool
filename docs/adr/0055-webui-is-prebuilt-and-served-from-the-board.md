# WebUI は事前ビルドして盤面から配る

issue #208 の grilling(2026-08-09)で決定。`public/index.html` は React / ReactDOM /
`@babel/standalone` / lucide を **unpkg から実行時に読み**、2757 行のインライン JSX と
`/kit/*.jsx` 4本を **ブラウザ内で Babel コンパイル**してからマウントしていた。ADR 0027 が
「in-browser Babel のビルドレス React で型検査も効かない唯一の層」と書いたのは、この姿である。

引き金は「WebUI の E2E スモークを CI に載せたい」(#208)だった。ADR 0029 はその precondition を
「CI ランナーから unpkg に到達可能にする、または依存と `.jsx` を vendor / precompile する」と
置いていた。だが**決め手は CI ではなく可用性**である。ラズパイの tidepool を Tailscale 越しに
スマホで見ている最中に unpkg が落ちれば、盤面は丸ごと白い画面になる。CDN は開発の都合として
入っていたが、実際には**本番の単一障害点**として立っていた。

## 決定

**WebUI はビルドしてから配る。実行時に外部ホストへ出る経路をプロダクト面から無くす。**

```
webui/app.jsx                              index.html のインライン JSX(切り出し先)
ui_kits/tidepool-webui/*.jsx               4本。移動しない(下記)
  ↓  scripts/build-webui-bundle.mjs
public/app.js                              連結された1本。コミットする
public/vendor/{react,react-dom,lucide}.js  UMD をそのまま。コミットする
```

- **`@babel/standalone` は捨てる。** 3.0MB をブラウザに落として毎回コンパイルさせていた当のもの。
  事前ビルドすれば要らない。取り込むのは react 12K / react-dom 132K / lucide 352K の計 500KB で、
  差し引きで配信量は減る。
- **連結方式であって bundle ではない。** ファイル毎に `esbuild.transformSync({ loader: "jsx" })` を
  かけ、今日の `<script>` の並び順どおりに繋ぐ。`import` / `export` は書かない。
  `scripts/build-ds-bundle.mjs` が `_ds_bundle.js` に対してやっているのと同じ型である。
- **`ui_kits/tidepool-webui/*.jsx` は動かさず、そのままビルド入力にする。** 実行時ロードを
  ビルド時参照に変えるだけで、ファイルは1つも移さない。
- **生成物はコミットする。** `scripts/deploy-pi.sh` にビルド工程は無く(tsx が `src/*.ts` を
  直接走らせる)、`_ds_bundle.js` が既に同じ理由でコミットされている。
- **vendor は devDependency から取る。** `react` / `react-dom` / `lucide` を devDependencies に
  置き、ビルドが `node_modules` の UMD を `public/vendor/` へ写す。バージョンの正本は
  `package-lock.json` になる。
- **鮮度は vitest で守る。** ビルドスクリプトに `--check`(生成して既存と比べるだけで書かない)を
  足し、`tests/` のテストが呼ぶ。同じ仕組みを `_ds_bundle.js` にも掛ける — こちらは今日まったくの
  無防備だった。

## 根拠

**1. CDN は開発の都合として入り、本番の単一障害点として残っていた。** 盤面は「ラズパイ1台 +
Tailscale」で完結する自己ホスト型であり、その設計と「起動のたびに unpkg に依存する画面」は
噛み合っていない。人間面は credential で守られた閉じた面(ADR 0036)なのに、その面を描くための
コードだけが公開 CDN から来ていた。

**2. 昇格の precondition は、実行時 CDN を残したままでは本質的に解けない。** unpkg に到達させる
案でも CI は緑にできる。だがそれは e2e job を外部サービスの可用性とレート制限に永久に縛り、
「ローカルで緑 ≠ CI で回る」の非対称を残したまま資産を積むことになる。ADR 0027 の資産要件
「コード化・CI に載る・再利用できる」の2つ目が、自分たちの手の中に無い状態が続く。

**3. リポジトリは既にこの型を持っていた。** esbuild は devDependency にあり、
`scripts/build-ds-bundle.mjs` は同じ変換を同じ方式でやっていて、`_ds_bundle.js` は同じ理由で
コミットされている。新しい工程を発明するのではなく、既にある工程を1本増やすだけである。

**4. `ui_kits/` を動かさないのは、それが別の判断だから。** ADR 0051 は `ui_kits/` の中の相対パスが
Design 側の Product Design プロジェクトと紐づくため「動かすなら別途判断する」と明示的に先送りした。
CDN を切るという用件のついでにその判断を引き受けない。代わりに新しいズレが1つ生まれる —
**Design 側で kit を更新してもビルドを再実行するまで本番に届かない**(今日はファイルを置けば即反映
だった)。これは上記の鮮度チェックが検出する。

## ADR 0027 の前提はどう変わるか

ADR 0027 は改訂しない。ただし、その理由づけに使われた記述の**半分が古くなる**:

- 「**in-browser Babel のビルドレス React**」は**偽になる**。ビルドレスではなくなった。
- 「**型検査も効かない**」は**真のまま**。`.jsx` は `.jsx` のままで、TypeScript にはしない。esbuild は
  型を見ずに JSX を落とすだけである。ADR 0027 が名指しした「自動テストで守られない唯一の層」は
  依然として存在し、それを埋めるのは本 ADR ではなく派生 issue の仕事になる。

ADR 0029 の precondition は本 ADR で解消される。ADR 0027 の骨子(自動テストはサーバー境界で止め、
スモークは網羅を狙わず数本に限る)は無傷である。

## CDN が消えるのはプロダクト面だけ

`ui_kits/tidepool-webui/index.html`(キットのデモ面 — ADR 0050 の authoring 面)は CDN + Babel の
ままである。ここは Design 側と往復する authoring の道具で、盤面の可用性には乗っていない。
「tidepool から CDN が消えた」ではなく「**人間が盤面を操作する面から消えた**」が正確な言い方になる。

## Considered options

- **CI ランナーから unpkg に到達させる。** 作業は最小で、`.github/workflows/ci.yml` に e2e job を
  足すだけで済む。だが本番の単一障害点は残り、e2e job は外部サービスの可用性・SRI 検証・レート制限に
  永久に晒される。`docs/webui-e2e-harness.md` が当初から「脆い」と評していた線。
- **4本とも vendor し、in-browser Babel は据え置く。** precondition はこれだけで満たせる — CI の
  ためだけなら Babel を捨てる必要は無い。だが 3.0MB をコミットしたうえで、スマホは毎回それを
  落として 2757 行をコンパイルし続ける。初回描画が秒単位なのはこれが原因で、`playwright.config.ts`
  の 15 秒タイムアウトもこれに合わせて置かれたものだった。
- **ESM 化して esbuild に bundle させる。** 依存が明示になりグローバル汚染も消える。だが 2757 行と
  kit 4本を同時に書き換えることになり、React 自体が UMD グローバル参照なので external 扱いの調整も
  要る。CDN を切るという用件と混ぜると、壊れたときの切り分けができなくなる。モジュール化は価値の
  ある作業だが、それ単体の目的で別に立てる。
- **`ui_kits/` の4本を `webui/` へ移してプロダクトのソースにする。** ADR 0051 と同じ思想
  (本番が出荷するものはプロダクト側に置く)。だが Design 側と紐づくファイル群を今触ることになる。
  上記 4 のとおり別途判断する。

## 影響するファイル

`public/index.html`(2859行 → 約100行。head・CSS・fetch ラッパーの素 JS・`<script src>` 4本だけが
残る。SRI の `integrity` / `crossorigin` は same-origin になるので消える)/ `webui/app.jsx`(新規)/
`scripts/build-webui-bundle.mjs`(新規)/ `scripts/build-ds-bundle.mjs`(`--check`)/ `package.json` /
`tests/`(鮮度テスト)/ `docs/webui-e2e-harness.md`。

`src/auth.ts` と `src/server.ts` は無変更 — 人間面の credential は経路の allowlist ではなく面まるごとに
掛かっているので `/app.js` と `/vendor/*` は自動的に守られ、`express.static(public)` がそのまま配信する
(`res.sendFile` の経路を増やさない = issue #108 の dotfile 404 を再演しない)。`public/sw.js` は
precache を持たないので無変更。
