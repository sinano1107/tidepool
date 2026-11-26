# Interview の root は実 workspace の名前の場所ではなく休止位置の head の checkout を読む —— worker に渡す実環境の在り処は、その worker が読める場所である

2026-11-26 の triage → grilling(issue #3865、#3859 の派生)で決定。ADR 0273 決定2 の床は「cwd を面接室にし実環境を読みに開ける」で、
追記(#2223)は root が読む実環境を休止位置と書いた。ところが root の sandbox の読みには実 workspace の path が丸ごと入り、ADR 0356 以後
その path は盤面の記録である名前の場所で、`.git` に他の task の `task/*`(未着地・cancel 済みを含む)を持つ。出題の写しは root の作業ツリーの
tree を運ぶので、root が `.git` 越しに読んだ未着地の内容を作業ツリーに置けば、それが受験者の環境に入る。面接室の読み手は ADR 0361 で、
task の checkout は ADR 0411 決定1 で名前の場所を開かなくなったが、root の実環境の読みはどちらの検討にも入らず、ADR 0356 以前の形の写しとして
残っていた。worker に実環境の在り処を渡す欄(root と監査の envelope の `real_environment`)も名前の場所の path のままで、監査の Auditor の
sandbox は ADR 0411 決定1 以来それを開かない。ここまではすべてコードの読みで、実行していない。

## 決定

1. **root が読む実環境は休止位置の内容だけである。** pickup が remote へ追従させた後の保護ブランチの head とその閉包(着地済みの履歴)で、
   他の task のブランチは読まない。ADR 0273 決定2 の「実環境について盤面が持つものを読める」は、実環境の側ではこの範囲を指す。
2. **root は名前の場所を開かず、盤面がその head を fetch した読み専用の checkout を読む** —— ADR 0361 決定1 の乗り物を実環境に写す。
   名前と停止・封じ込めの単位は実環境の名前のまま(ADR 0273 決定8 / 追記 #2265、ADR 0368)。ADR 0411 決定1 の「worker は名前の場所を
   開かない」は、root が読む実環境にも成り立つ。
3. **worker に渡す実環境の在り処は、その worker が読める場所である。** root にはこの session の読み専用の checkout、監査の Auditor には
   自分の cwd(保護ブランチから切った task の checkout)。記録と人間の面は実環境の名前のままで、面接室の在り処の扱い(ADR 0361)と同じ線。
4. **床の新しい実測は立てない。** 床の形(cwd は面接室、別の checkout を読みだけ開く)は変わらず、読む先が変わるだけである。面接室の
   canary(#2197)は読み先を新しい checkout に替え、名前の場所の path の読みが OS に拒まれることを確かめる行を足す。

形(記録で実環境の checkout と面接室の checkout をどう分けるか、fetch の失敗の帰責の当て方)は spec で決める(#3865)。

## 退けた案

- **名前の場所の作業ツリーは開いたまま `.git` だけ読みから外す** —— ignored のファイルなど名前の場所の他の層が残り、ADR 0411 決定1 の線から
  外れたままになる。
- **履歴を持たない tree だけを展開する** —— 着地済みの履歴を隠す理由が無く、読み専用の checkout の作り方が2つになる。
- **Auditor の在り処の食い違いを別 issue にする** —— root と同じ関数の同じ欄で、片方だけ直る形になる。

## Consequences

- root は未着地の evidence task の差分を読めない。evidence から届くのは `read_evidence_history` の決定と handoff_doc で、root はそこから
  再現を組む。
- root は名前の場所の ignored・untracked なファイル(依存の install・ビルド成果物・`.env` など)を読めない。環境は面接室で匿名化して組む
  規律(ADR 0275)なので、要る場面は見つかっていない。秘密が届かなくなるのは利点である。
- root の pickup ごとに実環境の閉包の複製を1つ作る。費用は ADR 0411 の task の checkout と同じ桁。
- Status 追記: ADR 0273 決定2、ADR 0411 決定1。
