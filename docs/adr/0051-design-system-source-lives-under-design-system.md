# デザインシステムの実ソースは design-system/ 配下に集約する

`components/`(18コンポーネントの実ソース)、`tokens/`、`styles.css` はリポジトリルートに直置きされ、
アプリ本体(`public/`, `src/`, `tests/`, `e2e/`)と見分けがつかない形で混在していた。同じルートにある
`design-system/` はさらに紛らわしい名前を持ちながら中身は別物 — 実コンポーネントではなく、
design-sync コンバータに package-shape の入り口を与えるためだけの薄いラッパー(`package.json` /
`src/index.js` バレル / `docs/`)だった。この配置は 2026-07-11 の hybrid セットアップ(issue #18)に
由来し、その後 `/design-sync` の標準 package flow へ移行した際(同日、`.design-sync/NOTES.md` 参照)も
「別途相談」として先送りにされていた。

## 決定

`components/`・`tokens/`・`styles.css` を `design-system/` 直下へ移し、既存の `design-system/`(コンバータ
専用パッケージ)は `design-system/pkg/` へ一段降格する。

```
design-system/
  components/        (was root components/, 内容無変更)
  tokens/             (was root tokens/)
  styles.css          (was root styles.css)
  pkg/                (was root design-system/ — converter package)
    package.json
    src/index.js       (barrel, ../../components/** を re-export)
    docs/
    dist/               (gitignored, ビルド生成物)
    styles.css          (gitignored, ビルド生成物)
```

**`pkg/` という一段が必要な理由は `.gitignore` との衝突。** `design-system/dist/` と
`design-system/styles.css` は元々ビルド生成物として無視されていた。素朴に `components/`・`tokens/`・
`styles.css` をそのまま `design-system/` 直下へ統合すると、実ソースの `styles.css` が同じ無視パターンに
飲み込まれてしまう — ローカルには残るのでテストは通るが、新規 clone やデプロイ先には存在しない
ファイルになる。コンバータパッケージを `pkg/` へ押し下げることで、生成物の無視パターン
(`design-system/pkg/dist/`, `design-system/pkg/styles.css`)と実ソースの置き場所が衝突しなくなる。

**`componentSrcMap` / `cssEntry` / `docsDir` はいずれも無編集で解決先が一致する。** 移行前は
`design-system/`(コンバータパッケージのルート = `PKG_DIR`)から見て `../components/...` が repo root の
`components/` を指していた。`pkg/` へ一段掘り下げた後は `design-system/pkg/`(新 `PKG_DIR`)から見て
`../components/...` が `design-system/components/` を指す — パス文字列はそのままで参照先だけ新配置に
追従する。バレル (`design-system/pkg/src/index.js`) の `../../components/...` も同様。実ビルド
(`.ds-sync/package-build.mjs` をローカル実行)で 18/18 コンポーネントが src-matched することを確認済み。

## スコープ外

- **`_ds_bundle.js` / `ds-bundle/`(本番ビルド生成物)。** リポジトリルートに意図的にコミットされており
  (Pi デプロイがビルドを要さないため)、動かすなら `src/server.ts` / `public/index.html` /
  `ui_kits/**/*.html` の参照を同時に触ることになる。今回の再配置とは独立した判断。
- **`ui_kits/`。** 中の相対パス(`../../styles.css` 等)は Design 側の Product Design プロジェクトとも
  紐づくファイル群を経由してファイルシステムパスではなく URL(`/kit/...`)として解決されている。
  かつ Design 側の未整理コピー(`.design-sync/NOTES.md` 参照)とも関わるため、動かすなら別途判断する。

## 影響したファイル

- `.gitignore`(生成物パターンの付け替え)
- `src/server.ts`(`/tokens` と `/styles.css` の静的配信元 — URL パスは変更なし)
- `scripts/build-ds-bundle.mjs`(18コンポーネントの相対パス)
- `scripts/build-ds-package.mjs`(root styles.css 読み込み・tokens 読み込み・生成物出力先)
- `scripts/preview-settings.ts`(`components/` の watch パス)
- `.design-sync/config.json` は無編集(上記の理由)
- `.design-sync/NOTES.md`(resync コマンドと経緯の記録)

## 検証

- `node scripts/build-ds-bundle.mjs` 後の `_ds_bundle.js` diff はパス文字列とコメント行のみ(コンポーネント
  本体の出力に差分なし)
- `node scripts/build-ds-package.mjs` → `.ds-sync/package-build.mjs` ローカル実行で 18/18 コンポーネント
  src-matched、`_ds_sync.json` の検証アンカーも正常生成
- `npm run typecheck` / `npm test -- --run`(1077件)全て通過
- 実ブラウザ(Playwright, 使い捨て scratch spec): triage/board/queue/register の4画面と `/kit` の相対パス
  解決を確認、コンソールエラーなし

## Considered options

- **全部を `design-system/` 直下にフラットに置く** — 上記 `.gitignore` 衝突で実ソースが無視される。却下。
- **`design-system/`(コンバータパッケージ)を別名(例 `design-system-pkg/`)に改名し、`components/` 等は
  ルートに残す** — 名前の紛らわしさだけは解消するが、リポジトリルートの散らばり自体は変わらず、
  今回の動機(アプリ本体と見分けをつける)を満たさない。却下。
- **現状維持** — ルートの散らばりと `design-system/` という誤解を招く名前を放置し続けることになる。
  再配置のコストは大半が機械的なパス置き換えで、影響ファイルも実測で1桁台に収まったため見送る理由がない。
