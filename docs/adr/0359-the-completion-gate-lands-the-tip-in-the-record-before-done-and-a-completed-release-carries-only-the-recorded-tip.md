# 完了の門は tip を記録に着けるまで `done` にせず、完了済みの解放は記録の tip だけを運ぶ —— 報告後の書き込みは記録され、名前の場所を止めない

**Status 追記: 決定2・5 の「完了済みの解放」は門の掛かる work の解放を指す —— review と Interview の役は門を持たないので、完了済みでも解放の fetch が初回の転送を担い、その失敗の帰責は写す段 / fetch する段 / host の3段([ADR 0364](0364-the-board-never-opens-the-workers-git-as-a-repository-and-fetches-the-tip-from-a-board-owned-copy-of-its-regular-files.md) 決定2、2026-11-09、issue #3097)。**

**Status 追記: 決定4 の「verb の時点の名前の場所の失敗は資源の停止を登録せず拒むだけ」は、署名を持つ drift(名前が解けない)にも広がる —— 後始末が一歩あとに同じ drift を観測するので verb で登録しても止まるものが無い([ADR 0363](0363-drift-is-observed-by-the-pickup-gate-before-running-and-by-teardown-after-and-the-completion-gate-rejects-an-unresolvable-name.md) 決定2、2026-11-09、issue #3094)。**

2026-11-08 の grilling(issue #3053、#3030 の実装で見えた形)で決定。ADR 0356 の後、完了の門は worker の tip を名前の場所の `task/<id>` へ引いてから
`done` にするが、名前の場所の側の失敗は飲んで `done` にする(ADR 0084 決定2 の写し)。飲むので「記録に tip があるか」が記録から分からず、
完了済みの解放が worker の checkout を tip の出所として**読み直す** —— #3030 の確認済み決定1「`done` の後の解放は名前の場所に既にある ref を
読むだけ」に反する写しで、ADR 0356 決定2 も ADR 0109 決定3 もこの読み直しを決めていない。読み直しのせいで、同じ事象(`done` と報告した後に
task の checkout に起きた書き込み)が3つに割れる: `.git` が消えていれば merge back が走らず `done` のまま成果が祖先に届かない(#3053)、
commit が足されていれば ref が進んで祖先へ運ばれる、未 commit なら名前の場所の quarantine。実測の表と `file:line` は #3053 のコメントに置く。

## 決定

1. **完了の門は、worker の tip が名前の場所の `task/<id>` になるまで `done` にしない。** 名前の場所の側で書けなければ DomainError で拒み、
   盤面の側の失敗と名指す —— worker は呼び直すか escalate する。ADR 0084 決定2 の「ツリーを観測できなければ素通し」は task の checkout には
   掛からない: 観測できない側(worker の repo)は #3030 で既に拒んでおり、残る名前の場所の側も拒む。`done` ⇔ tip が記録にある。
2. **完了済みの解放は記録の tip だけを運ぶ。** worker の checkout を tip の出所として読み直さず、merge back・remote の追従・休止位置は
   checkout の状態に依らない。
3. **報告後の書き込み**(未 commit の変更・commit の前進・repo が読めない)**は1つの事象で、task の event として記録し、名前の場所は止めず、
   question も立てない。** ADR 0109 決定3 の quarantine は、worker と `.git` を共有していた名前の場所で「次の merge back が報告後の書き込みを
   運ぶ」のを止めるためのものだった。2つの `.git` では運搬は決定2 が構造的に止め、名前の場所は worker が書けない。観測できない側(`.git` の
   消失・view の上限超過)で着地を進めるのは fail-open だが、守るものが無い —— tip は門で確定し、名前の場所は汚れていない —— ので、既定の
   fail-closed の例外として明示する。checkout は解放の最後の step で今日どおり消す: 解放は失敗しておらず、worker の振る舞いの記録は
   transcript が持つ(ADR 0149)。
4. **verb の時点の名前の場所の失敗は資源の停止を登録せず、拒むだけである。** そこで起きる失敗は lock・disk・`update-ref` の旧値の不一致で、
   どれも資源の署名を持たない(ADR 0331 決定1 の「署名の無い throw」)。ref の門(`writeBoardRefs`)は verb では基準を比較せず、人間の
   ref の移動は解放の基準比較(ADR 0351)が今日どおり名前の場所の quarantine にする。
5. **ADR 0356 決定2 の「worker の repo の故障は task の失敗」は決着していない task(`todo` に戻る解放)に限る。** `done` の task では
   決定3 の観測である。ADR 0357 決定2 の view の上限超過も、完了済みの解放では fetch が走らないので決定3 の「読めない」観測になる。

## 退けた形

- **門は飲んだまま、観測した sha を記録に書き、解放はその sha だけ引く** —— 飲んだ場合に worker が動かした ref から sha を引く手が要り、
  tip の出所が2経路のまま残る。
- **報告後の書き込みを quarantine のまま**(未 commit の形だけ保つ)—— 止める相手の名前の場所は汚れておらず、人間に修理するものが無い。
  3つの形が割れたまま。
- **報告後の書き込みで question を立てる** —— 判断が無い。内容は正しく着地している。
- **観測した checkout を証拠として残す** —— 読み手を1人も挙げられず、#3057 の片付けを増やす。

## 派生

- Status 追記: ADR 0084 決定2、ADR 0109 決定3、ADR 0350 決定1、ADR 0356 決定2、ADR 0357 決定2。GLOSSARY.md: 「報告後の書き込み」を立て、
  Slot-release tree rule と task の checkout の行を直す。
- 名前の場所で走る完了経路の検査(task の checkout でない分岐)は site を持たない —— work は全部 task の checkout で走る。spec で消す。
- `cancelled` の解放(ADR 0304)は決定3 でも決定5 でもなく今日の形のまま —— 読めなければ event を書いて checkout を残し、question は立てない(唯一の写しを消さない)。
- 実装は1 slice、#3053 のコメントが spec。#3031(受験者の解放)と #3033(view の上限)はこの決定に乗る。
