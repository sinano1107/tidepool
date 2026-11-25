# task の checkout を読む盤面の view は盤面所有の写しを借りる —— worktree が供給しない path は記録の値のまま

2026-11-24 の grilling(issue #3139、#3111 の ponytail-review の疑いと #3734 の triage の派生)で決定。ADR 0356 決定3 は、盤面が worker の worktree を読む view(盤面所有の使い捨て GIT_DIR + 新規 index)に名前の場所の objects を使わせた。当時は task の checkout 自体が名前の場所を借りていたので、借りる先はそれしか無かった。ADR 0411 決定1 がその前提を消した後も、task の checkout の view の2つの呼び手(完了の門と完了後の観測、解放の stage)は名前の場所を渡し続けていた —— 作業台と出題の写しの呼び手は、worker の tip を写して検証した盤面所有の写し(ADR 0364 決定1)を既に渡している。名前の場所を借りる view は、`add -A` / `write-tree` / `status` の1回の呼び出しで worker の worktree と名前の場所の blob の両方を読み、落ちたときの帰責を落ちた手から推す。ADR 0411 が task の checkout について退けた形が、view に残っていた。ADR 0411 決定4 の入れ直しが stage の前に tip の閉包を直すので届く形は縮んだが、基準がその閉包の外にある2つの形(完了の後に名前の場所が壊れた門付きの完了解放、worker が記録済みの commit から巻き戻した未決着の解放)では、名前の場所の blob の損傷が worker の「読めない」観測と task の失敗として刻まれる。実測の表と `file:line` は #3139 に置く。

1. **task の checkout を読む view は、worker の tip を写して検証した盤面所有の写しを借りる。** 完了の門、完了後の観測、解放の stage のどれも同じ。ADR 0356 決定3 の「名前の場所の objects」を置き換える。view が読むのは worker の worktree と、盤面が検証した写しだけになり、stage と観測の失敗は作りの上で worker の側になる —— ADR 0367 決定1 の「記録から index を作る失敗を分ける」手と、ADR 0359 決定3 の「status の段だけを観測の失敗にする」分け方は、分ける相手が無くなる。
2. **view の index の種は worker の tip。** 名前の場所の ref が worker の tip より先にある解放(worker が巻き戻した形)でも同じで、ref は WIP の commit の親としてだけ使う。名前の場所の object を読むのは、ref の値を解く手、決定3 の手、commit を作る段の親だけで、`add -A` / `write-tree` / `status` は読まない。
3. **worktree が供給しない path は、記録の値のまま WIP に入る。** view が外す path(隠す settings、記録の gitlink、既知の残骸)は、ref が tip より先にあるとき、今どおり名前の場所の ref から導き、その entry を ref から読んで index に重ねる —— WIP の tree は、種を ref にしていたときと同じになる。導く手と読む手は名前の場所の側の段で、blob は読まない。ref が tip と同じなら、外す path は写しの中の tip から導く。種を tip にしただけでは、盤面名義の WIP が人間だけが書く path と gitlink を tip の値に書き戻す —— worker は fork 元より前にも巻き戻せる。
4. **完了の門は、tip を記録する手と view に1つの写しを使う。** 検証は1回で、view が比べる相手は記録した tip と同じ写しの中にある。
5. **名前の場所の損傷を、view は見つけない。** 見つけるのは、運ぶ段と運んだ後の確かめ(ADR 0411 決定4)、ref と重ねる entry を読む名前の場所の側の手である。完了後の観測は写しを作るので、完了の後に worker が自分の repo を壊した形と、写しが上限を越えた形は、変更の列でなく「読めない」観測になる(ADR 0359 決定5 の語彙のまま)。費用は ADR 0411 決定6 と同じ受け入れで、完了後の解放に閉包の複製と検証が1回増える。

## Considered Options

- **view が基準の tree の object を自分の store に写す段を足す** —— 写す段と検証の手がもう1組増え、既にある盤面所有の写しと役が重なる。
- **stage の前の入れ直しを基準にも延ばす** —— 巻き戻しの形では基準の object を worker が持たず、入れ直しの出所が無い。
- **巻き戻しの形だけ種を ref の値にし、写しに名前の場所を借りさせる** —— `add -A` と `write-tree` が名前の場所の blob を読む形が、その形にだけ残る。
- **worktree が供給しない path も tip の値にする** —— 手は1つ減るが、盤面名義の commit が人間だけが書く path と gitlink を書き換える。
- **門の view のために写しをもう1度作る** —— 検証が門ごとに2回になり、2回の間に worker の tip が動いた場合の規則が要る。

## Consequences

- Status 追記: ADR 0356 決定3、ADR 0359 決定3、ADR 0360 の Status 追記(#3111)、ADR 0365 決定3、ADR 0367 決定1。GLOSSARY.md: 「退避は worker の `.git` を読まずに撃つ」の行を直す。
- 完了の門が view の失敗を名指さず拒むだけなのは ADR 0359 決定4 のままで、ここでは変えない。
- 実装は #3139。作業台と使い捨ての checkout の側(#3763)の後に入れる —— 同じ view の呼び手と、写しに名前の場所を借りさせる機構を触る。

## 追記(2026-11-25 の実装、issue #3139)

決定3 の「WIP の tree は、種を ref にしていたときと同じになる」は、外す path に入れ子の repo が絡む形では成り立たない。(i) tip の gitlink を ref が普通の dir に置き換えた形と、(ii) ref が足した dir を worker の worktree が入れ子の repo にした形である。種を ref にしていたときの WIP は、`add -A` がその dir を ref の entry に対して stage するので、`text=auto` の判定を通じて ref の blob の中身に依る。同じ tree を作るには ref の blob を読む必要があり、決定2 がそれを禁じる。これらの形でも決定3 の原則(worktree が供給しない path は記録の値のまま)を取り、外す path には ref の entry を重ねる。実測は #3139。

## 追記(2026-11-25 の実装、issue #3814)

出題の写し(ADR 0273 決定3)も、決定1・2 の「task の checkout を読む view」に入る —— root の task の checkout を読む。出題の写しは stage の前に写しへ面接室の objects を借りさせていたので、git が alternates を推移的に辿り、worktree が面接室にだけある tree / blob を再現すると `add -A` / `write-tree` がそれを書かずに借りた。面接室のその object の破損は stage の中で落ち、root の worktree の故障として刻まれた。解放の WIP と同じく、借りは `write-tree` の後(親を読む手の前)に置く。

決定2 の不変条件(`add -A` / `write-tree` は名前の場所の object を読まない)は、呼び出しの順序だけでなく stage の入口で強制する: stage の view が借りる repo が `objects/info/alternates` を持てば、view を作らず worktree を読む前に止まる。盤面の不変条件の破れなので型を付けず、worker の故障にも host の失敗にも数えない。実測は #3814。
