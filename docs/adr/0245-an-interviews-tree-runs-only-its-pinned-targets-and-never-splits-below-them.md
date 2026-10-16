# Interview の木で走る work は pin した対象だけで、その下は分けない

2026-10-13 の grilling(issue #1883)で決定。#550 の review で、Interview の対象を pin した子が decompose できることが
見つかった。孫は pin を持たないので表の行で走り、成果は pin の子のブランチへ merge back されて、採点される handoff に
別の model の仕事が混ざる。pin の子が done のあとブランチが保護ブランチに収束していれば、孫は着地の根になって PR を
開きうる。ADR 0199 決定3 の「走る対象は人間が1つずつ承認したものだけ」は root の直接の子にしか効いていなかった。
コードの照合は #1883 のコメントに置く。

## 決定

1. **pin の子は分解できない。** agent には分解の verb を見せず(ADR 0122 決定2 と同じ、task ごとの verb の差し替え)、
   盤面は人間の扉を含めて分解を拒む。孫に pin を継がせる案は、採点を「この model が分解して統合する力」に変え、
   ADR 0199 決定2 の問い「この model はこのティアの品質を満たすか」と単位がずれる。
2. **大きすぎると判断した pin の子は、1子のまま完了し、終えられなかった部分を handoff に書く。** pin の子に注入する
   board doctrine の分解の文はこれに差し替え、Interview であることは書かない(測られていると知ると振る舞いが変わりうる)。
   前提の破綻は probe 自体が壊れていたときに残る —— その破綻は全対象に共通なので、兄弟を held にするのが正しい。
   「この対象には大きすぎる」は対象についての観測で前提の破綻ではなく、breach にすると承認済みの兄弟の対象まで止まる
   (ADR 0199 決定4 の「兄弟は続く」)。他の対象が1子で完了していれば、採点の比較で見える。
3. **Interview の root は作り直さない。** breach を受けた root は `continue_decomposition` で続行させるか、escalate で
   人間に上げ、人間が abandon して直した probe で登録し直す。盤面は root の作り直しを拒み、verb も見せない。採点者に
   model を伏せるため root は pin の子があると対象の一覧を読めず、作り直すと pin の無い子に黙って置き換わる。probe と
   rubric を回答前に確定する(ADR 0111 決定6)のは Interview 1件につき1回で保つ。
4. **Interview の root の子は全部 pin を持つ。** pin の無い子は表の行で走り、採点もされない。ADR 0111 決定6 も
   ADR 0199 も対象ごとの子しか置いていない。
5. **pin の子の failure question の `abandon` は、その子のサブツリーだけを cancel する。** 兄弟も親も動かさず、question が
   開いているあいだの held もその子だけにする(held と cancel されうる範囲は一致する —— ADR 0048)。失敗は対象1つについての
   観測で、ADR 0199 決定4 の「この対象は測らない」と同じく、人間が1つずつ承認した他の対象の測定を止めない。前提の破綻の範囲は
   決定2 のとおり分解判断ごとのまま —— 破綻は probe についての観測で全対象に共通する。このため Interview の pin の子では、
   failure question と前提の破綻の範囲が分かれる(issue #1893)。

## 退けた案

- **孫に pin を継がせる** —— 決定1。着地の除外も孫まで広げることになる。
- **許して採点の読み手に任せる** —— root の history は直接の子しか並べず、読み手には孫が見えない。PR の経路も残る。
- **pin の子の失敗の abandon も分解判断ごと破棄する(ADR 0048 のまま)** —— 決定5。1つの対象が1回落ちるだけで、承認済みの他の対象の
  測定が held になり、abandon で cancel される。
- **breach した子を `rejected` で直接採点する** —— breach は1子に収まるかの判断で品質の判定ではなく、「完了していない
  仕事の採点」という意味が増える。
- **root の作り直しで旧い子の id から pin を引き継ぐ / breach の早期復帰の間だけ対象の一覧を見せる** —— 欄が増えるか、
  伏せる線が崩れ、1つの Interview に旧い probe と新しい probe が混ざる。

## 帰結

- pin の子の下に入る経路は triage の修理子(objection の修理)と、Agent tool の subagent が残る。前者は #1886、後者は
  #1887 で扱う。
- board doctrine は task ごとにも変わる(分けるか否か)。ADR 0157 決定3 のスロット2つは Harness の語の数で、この分岐は
  Harness の語ではない別の入力として足す。

## 追記(2026-10-14 の triage / grilling、issue #1899)

決定3 の「breach を受けた root は `continue_decomposition` で続行させるか、escalate で人間に上げ、人間が abandon して直した
probe で登録し直す」は ADR 0248 に置き換わった —— pin の子の前提の破綻は root を起こさず初回から人間の question になり、
人間はその場で retry(同じ対象で登録し直す)を選べる。root を作り直さない線は変わらない。

## 追記2(2026-10-14 の triage / grilling、issue #1901 / ADR 0253)

決定3 の「probe と rubric を回答前に確定するのは Interview 1件につき1回」は、分解の回数ではなく出題の回数で保たれる ——
Interview の root は `decompose` / `redecompose` を持たず、出題の verb で一度だけ子を立てる(ADR 0253 決定1・5)。

## 追記3(2026-10-16 の grilling、issue #2099 / ADR 0267)

決定2・4・5 は ADR 0267 で置き換わった —— 受験者は root の子でも分解判断に乗る task でもなくなり、前提の破綻を持たず、
abandon が倒すのは規則どおり自分のサブツリーだけになる(例外ではなくなる)。決定1(分けない)と決定3(root は作り直さない)は残る。
