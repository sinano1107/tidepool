# WebUI のブラウザ確認はエージェントが Playwright で担い、人間の受け入れ確認ステップを廃止する

`public/index.html` の React 配線層(in-browser Babel・型検査なし)は自動テストで守られない唯一の層(ADR 0027)で、従来はここを **人間が実機で一度見る受け入れ確認**で確かめていた。この人間ステップを廃止し、エージェントが Playwright + システム Chrome + `bootTidepool` in-process(`e2e/fixtures.ts` の `boot` seam フェイク)でブラウザ確認まで担う。既定は使い捨ての `e2e/*.scratch.spec.ts`(`.gitignore` 済み・資産にしない)を書いて `npm run e2e:scratch -- <file>` で回すだけ。恒久リグレッションが要る導線は、ユーザーの明示指示があったときだけ `e2e/*.spec.ts` へ昇格させる(ADR 0027 の「積み上げるならスモーク数本」の受け皿)。

理由: 人間の受け入れ確認はボトルネックで、確認のたびに人手を要していた。ブラウザ確認をコード化された Playwright に寄せれば、突発確認はエージェントが即座に回せ、価値ある導線は書式そのままで恒久スモークへ昇格できる(scratch と昇格版が同じ Playwright Test 形式なので昇格は rename + セレクタ整形で済む)。ADR 0027 は改訂しない — 「サーバー境界で止める / ブラウザ駆動は積み上げない」という骨子は不変で、本 ADR はその上に「誰がブラウザ確認をやるか(人間 → エージェント)」と「昇格ルート」を足すもの。

## Consequences

- **昇格の precondition(CDN を CI でどう賄うか)。** `public/index.html` は React/Babel/lucide を unpkg CDN から実行時に読み、`.jsx` を in-browser で Babel コンパイルする。つまり **ローカルで緑 ≠ CI で回る**。ADR 0027 の資産要件「CI に載る」を満たすには、昇格前に (1) CI ランナーから unpkg 到達可能にする、または (2) 依存と `.jsx` を vendor/precompile して CDN 依存を切る、のどちらかを解決していること。**未解決の spec は昇格させない**(= コミットしない)。突発 scratch にはこの縛りは無い。詳細は `docs/webui-e2e-harness.md`。
- **ツールは Playwright に一本化。** 旧 puppeteer-core 手駆動は廃止。`fill()`/`getByRole` により制御 input の onChange 発火と text-transform ズレのハマりが消える(ただし `page.evaluate` 内の esbuild `__name` ハザードは Playwright でも残る)。

## Considered options

- **人間の受け入れ確認を維持する** — 確実だが人手ボトルネックが残り、突発確認のたびに人を待たせる。運用メモリ [[e2e-acceptance-is-human-executed]] の方針だったが本 ADR で反転。
- **突発確認も昇格資産も無く、UI 層は一切ブラウザで見ない** — ADR 0027 の「型検査すら効かない UI 配線のバグが無検出で残る」空白がそのまま。
- **すべての scratch を貯めて恒久スイート化する** — 維持コストが便益に見合わず、脆いテスト群を抱える(ADR 0027 が警戒するとおり)。だから既定は使い捨て、昇格は少数精鋭・明示指示のみ。
