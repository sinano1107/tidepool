# WebUI はサーバーの実行時の規則を、bundle した leaf の入口1本から呼ぶ

2026-10-07 の grilling(issue #1514)で決定。WebUI は欄を出すかどうかを決めるために、サーバーの規則を手で写していた
(review flag の欄の条件、完了時レビューの起票条件)。ADR 0133 決定3 が WebUI に開いた経路は、leaf module の**型**だけを引く
インライン `import(...)` で、実行時の関数は渡せなかった。#1468 の grilling では、写しが `assignee !== 'human'` の項を落としかけた。
写しの一覧とずれ方の実測は #1514 のトリアージのコメントに置く。

## 決定

1. **型だけでなく、実行時の値も leaf から引く。** サーバー側の leaf の入口(`src/webui-rules.ts`)を、
   `esbuild.buildSync({ bundle: true, format: "iife", platform: "browser" })` で1本のグローバル(`TidepoolRules`)に変換し、
   `public/app.js` の先頭に連結する。WebUI は、そのグローバルを `declare const TidepoolRules: typeof import(...)` で型づけして呼ぶ。
   サーバーも同じ関数を import するので、写しは無くなる。正本を変えるとコミット済みの `public/app.js` が古くなり、既存の
   `--check` が CI で落とす。ずれを止めるのは、写しを見張る釘ではなく、この鮮度の検査である。
2. **bundle するのはサーバー側の leaf の入口だけである。** WebUI 自身のファイルは、今までどおりファイル単位で変換して連結する
   (ADR 0055 / ADR 0133 決定1)。ADR 0055 の「連結方式であって bundle ではない」は WebUI 自身のファイルについての決定で、
   この決定とは食い違わない。leaf の入口を bundle するのは、leaf 同士の import(`HUMAN_WORKER_ID` を持つ `src/worker-id.ts` など)
   を許すためである。ファイル単位の iife では、依存の無い隣のファイルの import も解決できない。
3. **node の世界が入り込むのは2か所で止まる。** esbuild は browser platform では `node:*` を解決できず失敗する。webui の tsc は
   node の型を持たないので失敗する。leaf の入口から届くファイルが DB や fs に触れたら、ビルドか型検査のどちらかが落ちる。

## 退けた代替案

- **写しを残して e2e で釘を打つ。** ADR 0027 は常駐 spec の数を絞る方針なので、写しが1つ増えるたびに spec を足すことになる。
  ずれを後から捕まえるだけで、写しは消えない。
- **写しを残して、vitest で WebUI のソースを文字列として読み、サーバーと照らす。** #352 が halt kind のときに捨てた案と同じ形である。
- **サーバーが判定結果を応答に乗せる。** 登録フォームには使えない。送信前でまだ task が無く、フォームの値が変わるたびに判定が変わる。
- **leaf を import ゼロに限り、ファイル単位の iife で連結する。** `HUMAN_WORKER_ID` を真偽値の引数にすると、WebUI に `'human'` の
  写しが残る。定数を leaf に移すと、leaf が新しい定数を要るたびに引っ越しが要る。
