# checkout は最初の pickup 以降、休止中も盤面の専有領域であり、ref の基準は切れない

**Status 追記: 決定2・7 の基準の行は、作るときの宣言の repo も一緒に覚える —— 盤面は行き先を決めるたびに今の宣言と比べ、publish の扉が書き換え、削除の扉が行ごと落とす。基準そのものは `refs/*` と HEAD のままで、`remote.origin.url` は足さない(置き場所は spec。[ADR 0378](0378-the-boards-network-destination-for-a-workspace-comes-from-the-declared-repo-and-an-origin-or-a-declaration-that-points-elsewhere-is-a-workspace-quarantine.md) 決定5・6・10、2026-11-15、issue #3178)。**

**Status 追記: 決定7 の「path だけ差し替えた登録は…回答が受理する」は、名指しの選択肢「失われた ref を諦めて基準へ戻す」に限る —— `repaired by hand` と「基準へ戻す」は差し替えを受け入れず、正規の道は 削除の扉 → 再登録である。「面接室…の行も残る」は、「空の面接室で走らせる」が面接室の行を消す場合を除く。行の寿命は登録から削除までのままで、扉を経ずに registry から消えた名前の行は、registry から引く名前の最初の撮りを止める([ADR 0373](0373-the-acceptance-of-a-quarantine-only-confirms-that-every-ref-equals-the-baseline-moved-refs-are-restored-by-the-board-and-only-lost-refs-enter-the-baseline-through-a-named-option.md) 決定5・6・11・13・14、2026-11-15、issue #3178)。**

**Status 追記: 決定1 の「コストは触れば1枚の1択 question」は、選択肢3つの question になる(「verb か question の回答を通ってだけ基準に入る」は残る)。決定2 の全撮りを撮る場面から quarantine の受理が外れ、最初の撮りには確認が掛かる。release の比較のうち門の掛からない解放は、書く前に `task/<id>` の行を突き合わせ、行は読み返した値でなく書いた値で畳む([ADR 0373](0373-the-acceptance-of-a-quarantine-only-confirms-that-every-ref-equals-the-baseline-moved-refs-are-restored-by-the-board-and-only-lost-refs-enter-the-baseline-through-a-named-option.md) 決定1・2・12・13、2026-11-15、issue #3178)。**

**Status 追記: 決定4 の「quarantine の受理が基準を撮り直す」「回答は『動いた ref のほうが正しい』の受理」は偽になる —— 受理は全 ref が基準と同じであることを確かめ、全撮りはしない(末文の、落ちて残った2値行の畳みは残る)。下の追記の「決定4 の受理は変えていない」「直し方は #3158 に渡した」はここで閉じる([ADR 0373](0373-the-acceptance-of-a-quarantine-only-confirms-that-every-ref-equals-the-baseline-moved-refs-are-restored-by-the-board-and-only-lost-refs-enter-the-baseline-through-a-named-option.md) 決定1・7)。同じ決定4 の「ADR 0239 帰結の手の `merge -s ours` は quarantine 中の checkout で行い、同じ回答で受理されるので」も偽になる —— その merge は作業台で commit し、回答が取り込む。「verb は作らない」は、この文が指す場面(conflict の修理と、修理を捨てる merge)について残る: 入口は今ある回答のままである。人間の内容のために操作を足さない、という一般則としては読めない —— purely-local の保護ブランチ向けに、作業台を開く操作を1つ足す(内容を運ぶのはその question の回答)([ADR 0371](0371-a-human-writes-in-a-workbench-the-board-opens-and-the-board-takes-its-tip-in-through-the-answers-that-already-exist.md) 決定2・6、2026-11-15、issue #3178)。**

**Status 追記: 決定2 の比較の置き場所に着地が加わる —— 着地が名前の場所の ref を読んで運ぶか記録を決めるときは、同じ同期区間の頭で全 ref を基準と比べ、基準の行そのものが無い workspace では着地も pickup と同じ手続きで最初の撮りをする。決定7 の「次の pickup で1枚の question が立ち」は、着地の候補があれば着地の比較が先に立てる。決定4 の受理は変えていない: Quarantine が開いている間に動いた ref を見せないまま受け入れる穴は実測済みで、直し方は人間の内容の扉の設計(#3158)に渡した([ADR 0370](0370-landing-compares-every-ref-of-the-named-place-against-the-baseline-before-it-carries-or-records-and-the-acceptance-hole-goes-to-the-door-design.md) 決定1、2026-11-12、issue #3151)。**

**Status 追記: 決定2 の release 側の比較と task branch の行の畳み、決定5 の pickup の clean 検査の対象は、worker が書かない名前の場所だけになる。決定1・3・4・6・7 は残る([ADR 0356](0356-the-workers-bench-and-the-boards-record-are-different-git-directories.md)、2026-11-07、issue #2956)。**

**Status 追記: 決定5 の「dirty は休止後に書かれた」は、タスクブランチだけが無視するファイルを盤面が HEAD を動かす手で消すこと([ADR 0352](0352-files-the-task-branch-ignores-are-removed-when-the-board-moves-head-off-it.md))に乗って成り立つ —— 述語は HEAD の branch の ignore 規則に相対である(2026-11-02、issue #2912)。**

2026-11-02 の grilling(issue #2911、#2889 の review で見えた形)で決定。基準(pickup で撮った全 ref のスナップショット、ADR 0064)は
release の比較の後も残り、着地の帯域外判定(ADR 0103 決定1)が休止中に読むのに、次の pickup の全撮りが丸ごと上書きする。休止中に
保護ブランチが動くと、着地の回答が次の pickup より前なら quarantine、後なら通る —— 同じ書き込みの行き先が時刻で変わる。休止位置で
dirty になった tree は再実行の後始末だけが止め(ADR 0345 決定3)、通常の pickup は次のタスクブランチへ持ち越して次の worker の WIP
として記録する。祖先のタスクブランチは休止中に誰も見ない。根は「休止中の checkout の持ち主」を決めた ADR が無いことである ——
ADR 0064 は専有を session の窓に限り、ADR 0064 決定7・ADR 0239 帰結・ADR 0243 決定5 は休止中の人間の書き込みを正当と前提し、
ADR 0103 決定1・ADR 0052 §7・ADR 0345 決定3 は違反と前提していた。#2911 が名指した書き手(残存 process)は Linux では封じ込めが
閉じている —— 後始末は cgroup の `populated 0` の後にしか走らず、盤面が死ねば `KillMode=control-group`、起動の preflight は populated な
残骸で進まない —— ので、残る休止中の書き手は人間とその道具である。code の読み・封じ込めの経路・退けた形の表は #2911 のコメントに置く。

## 決定

1. **checkout は最初の pickup 以降、休止中も盤面の専有領域である。** 人間の変更は verb か question の回答を通ってだけ基準に入る。
   ADR 0064 決定3 の「違反」は session の窓から休止へ広がる。同決定が誤検知コストの根拠にした窓の短さは、「人間は盤面の checkout に
   書かない」(人間用の checkout を分ける運用、#2842 の前提)に置き換わる —— コストは触れば1枚の1択 question、触らなければゼロ。
2. **基準は切れない。** 全撮りは、盤面がこの checkout をまだ持ったことがない開き(行が無いか NULL の pickup と、読む場所の最初の開き —— 決定6)と
   quarantine の受理(決定4)だけが撮る。以後の pickup は fetch・park より前に基準と比べ、違反は動いた ref を名指して workspace quarantine に落とす。release の
   比較は今日どおりで、比較の直後にタスクブランチの行を基準へ畳む —— この畳みは冪等(タスクブランチは session の後に動かない)なので、
   ADR 0345 決定3 の再実行の経路でも無条件に走る(同 決定1)。比較器は1つで、除外集合が release(タスクブランチ)と pickup(無し)で
   違うだけ。release での行無しは今日どおり違反(ADR 0064 決定6)。remote-backed の休止位置の先行検査(ADR 0052 §7)は remote 側の
   事象を捕まえる別の検査で、両方残す。
3. **盤面の書き込みはすべて口(ADR 0243 決定4)を通る —— pickup の fetch・park・タスクブランチの作成・checkout、release の merge back
   の fetch、読む場所の fetch・park も。** 基準が切れない以上、口の外の書き込みは次の比較で盤面自身の違反になる。ADR 0329 追記 決定14 の
   「pickup は口の外のまま」と #2459 の3項はここで畳む。
4. **quarantine の受理が基準を撮り直す。** 受理の検査(clean・後半・merge back のやり直し)の後に全撮りをする。回答は「動いた ref の
   ほうが正しい」の受理(ADR 0064 決定7 の修理の線)で、受理は走行中の session が無いときしか通らないので、全撮りが worker の逸脱を飲む
   窓は無い。ADR 0064 決定7 の「次の pickup が撮り直す」はこれに置き換わる。ADR 0239 帰結の手の `merge -s ours` は quarantine 中の
   checkout で行い、同じ回答で受理されるので verb は作らない。落ちて残った2値行(ADR 0243 決定5)は次の比較で ref が持つ側に畳む ——
   どちらも予告した値である。
5. **tree も同じ不変に入る。** pickup は名前の場所の休止位置が clean であることを検査し(受理と同じ集合、ADR 0329 追記 決定12 ——
   受験者の checkout は記録なので当てない)、dirty は「休止後に書かれた」で workspace quarantine に落とす。ADR 0345 決定3 の再実行の
   dirty 検査はこの不変の観測点の1つになる。ADR 0069 の shadow 残骸の例外は当てない —— 休止中に sandbox は走らない。
6. **読む場所も比べる。** Interview の root が読む実環境は開くときに基準と比べ、行が無ければ最初の撮りをする(ADR 0329 追記 決定10 の
   後半の位置)。
7. **行の寿命は workspace の寿命である。** 削除の扉が行を消す(今日の扉は registry のエントリしか消さない)。path だけ差し替えた登録は次の
   pickup で1枚の question が立ち、回答が受理する。面接室と受験者の checkout は消されない(ADR 0276 決定4)ので、その行も残る。

## 退けた形

- **再実行でも比較を撃つ**(#2911 本文、ADR 0345 退けた形)—— 再実行の窓だけ閉じ、通常の完走の後の休止の窓が残る。ADR 0239 の出口の
  手の merge も止める(sweep の表)。
- **直さず、残存 process の回収に任せる** —— 回収は成り立つが、残る書き手の書き込みの行き先が時刻で変わる非対称は消えない。
- **`refs/heads/<protected>` と `refs/heads/task/*` に範囲を狭める** —— ADR 0064 決定1 が退けた列挙。人間が盤面の checkout に書かない
  以上、狭める理由が無い。

## 派生

- Status 追記: ADR 0064 決定3・5・6・7、ADR 0066、ADR 0081、ADR 0239 帰結、ADR 0243 決定5、ADR 0276 決定3、ADR 0329 追記 決定14、ADR 0345 決定3。
- GLOSSARY.md の Branch discipline・Workspace・Slot-release tree rule・Quarantine の項。
- 実装は複数 slice(基準の連続と口、受理の撮り直し、pickup の clean 検査 —— #2912 に blocked-by、読む場所、行の寿命)。#2459 はこの spec
  に畳む。#2842 はこの決定を前提に問いが狭まる。
