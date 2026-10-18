# 受験者は本番の work と同じ面を読み、伏せる・揃えるのは「測られていると知らせるもの」と「対象どうしの条件をそろえないもの」だけにする

**Status 追記: 決定5 の「決着した pin の子のブランチの ref を外す」は [ADR 0276](0276-an-interview-examinee-solves-in-its-own-checkout-fetched-from-the-posed-head-and-a-settled-examinees-checkout-stays-as-the-record.md) で要らなくなった(2026-10-19)—— 受験者は出題の head から fetch した自分の checkout で解き、兄弟の checkout は床の外にある。決定6 の「出題が記録した head から分岐する」はそのまま(分岐の形が fetch になる)。**

2026-10-15 の grilling(issue #2008)で決定。受験者(Interview の pin の子)が読む面は、漏れが見つかるたびに1か所ずつ塞いできた
(ADR 0245 決定2、ADR 0253 決定2、#1899 のレビュー、#1932)。面を全部洗い出すと、親の欄(人間が書いた root の題・目的)は
何も伏せておらず、兄弟の答案は親の history のほか checkout の git と記憶からも読め、対象ごとに解く土台のコードが違いうることが
分かった。面の一覧と経路の照合は #2008 のコメントに置く。

## 決定

1. **受験者は本番の work と同じ面を読み、伏せる・揃えるものだけを理由つきで列挙する。** Interview の結果は本番の episode と
   同じセル・同じ段の観測に数えられる(ADR 0181 / 0210)ので、本番と違う条件はそれだけで測るものを変える(ADR 0253 決定3)。
2. **理由は2つ —— 測られていると知らせるものと、対象どうしの条件をそろえないもの。** 前者は明示されたものに限る: Interview の
   語、rubric、測定の帰結、他の対象が同じ問題を解いていること。構造の差は残す —— pin の子が分けないことを言う doctrine の文、
   decompose / redecompose が無いこと、前提の破綻が常に question になりその選択肢に retry があること、`declare_premise_breach`
   の説明文が pin の子の経路(ADR 0248)を書かないこと。分けないことは伝えなければ拒否で知るだけで、見分けがつかないところまでは
   消せない。この許容は、checkout が盤面自身を説明しないことを前提にする(tidepool 自身の workspace は #2011)。
3. **受験者から見える親は出題そのもの。** 親の題・目的・完了基準は出題の値、handoff は無く、history は出題の行(rubric も他の
   対象も言わない)だけ。root に人間が書いた欄、root の他の判断ログの行、root の question は見せない。出題が仕事の情報を全部子に
   写す(ADR 0253 決定1)ので、root の残りは測定の装置である。
4. **兄弟の行は全部伏せる**(#1917)。受験者が兄弟の行から要るものは無い —— 兄弟の前提の破綻の間は自分も held で、continue は
   「probe は出題のまま」の意味である。答案だけを伏せると状態・cancel の由来・破綻の理由が残り、後から走る対象ほど多くを読む。
   決定3 と合わせ、受験者には本番の1子の分解と同じ見え方になる。ADR 0045 決定3(決着した兄弟の handoff を読ませる)の例外である。
5. **決着した pin の子のブランチは、後から走る兄弟の checkout に残さない。** ref を外し、head を記録に残す —— ADR 0111 決定6 の
   「ブランチは残す」をこう読み替える。全 pin の子が同じ checkout で走るので、history を伏せても git で答案を写せる。
6. **全 pin の子は、出題が記録した保護ブランチの head から分岐する。** pickup ごとの head から分岐すると、対象の実行の合間に
   main が進めば対象ごとに違うコードを解く。probe は出題の時点のコードを前提に書かれている。
7. **受験者は、pin の子が書いた記憶をどの Interview のものでも読まない**(注入でも pull でも)。書く verb は残す(決定1)。
   どの Interview にも広げるのは、retry した Interview が同じ probe の旧い答案を読まないためである。書いた記憶が本番に入ることは #2012。
8. **前提の破綻への continue に人間が書いたコメントは、宣言した子にも届けない**(#2007)。破綻は probe についての観測で全対象に
   共通し(ADR 0245 決定2)、probe を直す道は retry である(コメントは新しい root に渡る —— ADR 0248 決定3)。回答の画面はそれを示し、
   コメントは question の記録に残る。
9. **failure の retry のコメントと、受験者の escalate への答えは本番どおり届ける。** その対象が自分で起こした事態への応答で、
   自分の問いに助けを得るのは本番の条件である。回答の画面は「この対象にだけ届く」と示す。escalate で probe の不備が分かったときに
   全対象へ出し直す道は無い(#2013)。
10. **面はこの一覧が正本で、server 境界の sweep テスト1本が守る。** 面は、spawn 文・doctrine・tool の説明文と拒否文(本番と同じ、
    決定2 の差を除く)、自分の欄と history(本番と同じ、question の文は ADR 0245 決定2・#1899・#1932 のとおり伏せる)、親の欄と
    history(決定3・4)、人間の答えのコメント(決定8・9)、checkout(決定5・6)、記憶(決定7)、env・id・path(本番と同じ)。
    テストは pin の子が読むもの全部 —— `get_current_task`、登録された全 verb の説明文、記憶の注入 —— に Interview の語・rubric・
    対象の model 名・兄弟の id と答案が出ないことを確かめる。説明文は登録された verb を全部回すので、新しい verb は自動で入る。

## 退けた案

- **許可リストで組む** —— 本番に面が足されるたびに受験者だけ取り残され、本番と違う条件になる。
- **本番の task と見分けがつかないところまで消す** —— 決定2。
- **親を見せない(root の task として読ませる)** —— `declare_premise_breach` の説明文が「root は escalate する」と言うので、壊れた
  probe が前提の破綻でなく escalation に上がり、ADR 0248 の retry に乗らない。
- **root をそのまま見せ、Interview の語が出る欄ごとに伏せる** —— 人間が書く自由文で、語の検査では塞げない。
- **continue のコメントを全受験者に届ける** —— done の対象は補足なしで解き終えており、揃わない。
- **pin の子に記憶を書く verb を見せない** —— 本番と違う条件を作る。
- **pin の子の escalation に盤面が retry を足す** —— agent の書いた設問に盤面が手を入れ、ADR 0248 が退けた「escalate を状況で
  読み替える」に近づく。
- **pin の子の verb 一覧を完全一致で固定する** —— 漏れと関係ない変更で落ちる。新しい verb は説明文の sweep で拾える。

## 追記1(2026-10-16 の grilling、issue #2020 / ADR 0266)

決定5 の「ref を外し、head を記録に残す」だけでは、HEAD の reflog と到達できない object から答案が読めた。外すときは答案を先に
盤面の記録の器へ写し、HEAD の reflog と checkout 中のどこからも辿れない object も落とす(ADR 0266 決定1・2)。

## 追記2(2026-10-16 の grilling、issue #2099 / ADR 0267)

決定3(合成した親)・決定4(兄弟隠し)・決定8(continue のコメント)は ADR 0267 で消えた —— 受験者は親も兄弟も前提の破綻も
持たない。決定2 の構造の差は「decompose / redecompose が無い」だけに縮み、決定10 の面もそれに合わせる。決定1・5・6・7・9 はそのまま。

## 追記3(2026-10-16 の grilling、issue #2109 / ADR 0268)

決定7 の「書く verb は残す」は消えた —— 受験者は記憶を書かない(ADR 0268 決定2)。退けた案「pin の子に記憶を書く verb を見せない」の根拠
「本番と違う条件を作る」は、決定2 の2つの理由のどちらでもなく、採点されるのは成果物で書き込みは副作用である。決定10 の sweep は、受験者の
tools/list に記憶を書く verb が無いことも釘にする。

## 追記4(2026-10-17 の triage、issue #2022)

決定6 の「出題が記録した保護ブランチの head」は **root の分岐元** —— root の pickup の時点の保護ブランチの head —— を指す。
出題の verb が呼ばれた時点の remote-tracking ref ではない: 着地の収束は root の session の最中にも保護ブランチの写しを進める
(session を見る門があるのは merge back のやり直しだけ)ので、その時点の ref は root が probe を書いたときに読んでいたコードより
新しくなりうる。#2014 の「root の pickup の fetch 以降、fetch はしていない」は偽だった。読み方は出題の verb の gate の中で、
root の checkout の保護ブランチの ref と HEAD の merge-base —— HEAD そのものでないのは root の branch に commit があっても
保護ブランチ上の sha にするため、pickup の ref の写し(baseline)でないのは盤面自身の書き込みで畳まれるためである。
全 pin の子が同じ sha から分岐すること(決定6 の主眼)は変わらない。
退けた形: 着地の収束の写しの更新に session の門を足す —— landing 側を変える案で、出題側で分岐元を記録すれば足りる。

## 追記5(2026-10-17 の triage、issue #2021)

root の workspace が解決できない(registry drift —— ADR 0009 が設計で認める経路)まま出題すると、head の無い出題が残り、受験者の
pickup は head を引けず workspace の quarantine に落ち続け、直す道が Interview の retry しか無かった。出題は head を記録できないときに
**拒む**: workspace を解決できなければ verb は domain error で止まり(session は続く)、root は escalate で人間に渡す。退けた形:
head の無い出題を通し retry で直す —— 受験者が立ってから pickup のたびに同じ quarantine に戻るのは、root が出題の時点で知れた不備である。

## 追記6(2026-10-18 の grilling、issue #2184 / ADR 0273)

決定2 の許容の前提「checkout が盤面自身を説明しない」は、受験者が面接室(root が実環境を読んで匿名化して組んだ環境)で解くことと Interviewer の規律に置き換わった(#2011 の決着)。決定6 と追記4 の head は、出題が面接室の写しを commit した sha になり、merge-base の読み方は要らない(#2182 も消える)。決定1・5・7・9・10 と追記1〜3・5 はそのまま。
