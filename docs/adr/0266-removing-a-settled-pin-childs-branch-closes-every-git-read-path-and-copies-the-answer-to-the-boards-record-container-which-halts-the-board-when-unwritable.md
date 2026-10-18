# 決着した pin の子のブランチを外すときは checkout の git の読み口を全部閉じ、答案は盤面の記録の器に写す —— 器が書けなければ盤面全体が止まる

**Status 追記: 決定1(reflog expire / repack / prune)と決定2(答案の bundle への写し)は [ADR 0276](0276-an-interview-examinee-solves-in-its-own-checkout-fetched-from-the-posed-head-and-a-settled-examinees-checkout-stays-as-the-record.md) で要らなくなった(2026-10-19)—— 受験者ごとの checkout が決着後も記録として残る。決定3 の停止種別は残り、入口は transcript の open の1つになる。**

2026-10-16 の grilling(issue #2020)で決定。ADR 0263 決定5 は決着した pin の子のブランチの ref を外して head を記録に残すが、
`git branch -D` が消すのはそのブランチの reflog だけで、HEAD の reflog に兄弟への checkout と答案の commit の行が残り、
reflog を消しても到達できない object は `git fsck --unreachable` → `git show` で読める。受験者は Interview の語を知らずに
解くこと(ADR 0263 決定1・2)が採点を本番の観測に数える前提なので、git の読み口を全部閉じる。実測の表と手順は #2020 のコメントに置く。

## 決定

1. **ref を外すときは、HEAD の reflog を全部消し、checkout 中のどこからも辿れない object を落とす。** `git reflog expire --expire=now HEAD`
   に `git repack -a -d` と `git prune --expire=now` を続ける。到達できない行だけを消す形では「task/<兄弟 id> へ移動」の行が残り
   (移動先は到達できる)、prune だけでは兄弟の走行中に pack に入った object が残るので、この3つで1組である。走るのは、外した
   ブランチが1本以上あった pin の子の pickup の準備だけで、時点は fetch の後・ref の snapshot の前(ADR 0064)のまま。巻き添えは
   どの ref・ブランチ自身の reflog・index からも辿れない object だけで、本番の記録(event・タスクブランチ)と fetch した object は残る。
   git に「この head から辿れるものだけ消す」操作は無く、checkout 全体を1回掃除するのがこの決定の正体である。
2. **答案は外す前に盤面の記録の器に写す。** `git bundle create <head> ^<出題の head>` を worker transcript と同じ盤面の状態の下に
   task id で引ける名で置き、`task_branch_removed` に写した先を並べる(加法)。写すものが無い(head が出題の head と同じ)ときは
   写さず、event は head だけ持つ。#2014 の「object は gc で消えうる。長期の保存先は要ると観測されてから」は、決定1 で gc の
   猶予が無くなるので上書きする —— 指す先の無い head は記録でない(worker transcript と同じ線、ADR 0149)。人間は自分の clone に
   fetch して読む。worker の床は Claude(ADR 0038)も Codex(ADR 0256)も checkout の外を読めないので、受験者からは見えない。
3. **盤面の記録の器が書けなければ、盤面全体の停止になる。** 停止の種別を1つ足し(ADR 0068 決定3 の列挙、形は ADR 0112 の反応型)、
   実際の書き込み失敗が止める。踏んだ task は失敗にせず todo の先頭へ戻す —— 盤面の落ち度で、session は走っていない。Tidepool
   名義の確認 question が1枚立ち、解放の門は同じ器への書き込みの検査で、まだ書けなければ回答を拒む(quarantine 族と同じ)。
   器は盤面全体の資源で、止められるより狭い資源が無い(Registry reachability と同じ理路)。先行の検査は足さない —— 書き込み
   そのものが検査である(ADR 0149 決定2 の線)。
4. **入口は2つ —— 受験者の写しと、ADR 0149 決定2 の transcript の open。** ADR 0149 が「question なし・todo 先頭へ」を退けた理由は
   再開の門が無いことで、この停止がその門になる。決定2(記録の口は spawn より先に開く)は変えない。決定4 の session 途中の
   `transcript_failed` は、その session の failure question を残したまま、この停止も立てる —— session は走ったので後始末が要る。
   ADR 0118 決定4 と ADR 0149 はこの形を「question の積み上がりが観測されるまで」退け、観測は #910 が受けていた。受験者の写しが
   入口になったことで、原因1つに受験者の数だけ pickup が失敗する形は機構として確定し、観測を待つ対象ではなくなった。同じ器の
   失敗が入口ごとに別の行き先を持てば停止の種別が2つになるので、#910 はこの ADR で決着とする。

## 退けた案

- **HEAD の reflog だけ消す** —— `fsck --unreachable` の経路が gc の猶予の間残る。fsck は agent が失った commit を探すとき普通に打つ。
- **pin の子ごとに fresh clone で走らせる** —— 消す操作は要らないが、workspace = checkout path の前提(ADR 0064 の snapshot、
  封じ込め判定、床の cwd)を pin の子だけ別の形にする。塞ぐ範囲に対して変える面が大きい。
- **reflog を切る**(`core.logAllRefUpdates=false`)—— `logs/HEAD` が既にあると追記は止まらない(実測)。
- **diff を捨てて sha だけ残す** —— 採点の入力(handoff、ADR 0253 決定4)は変わらないが、head が指す先を失う。
- **remote へ push / 盤面専用の bare repo / diff のテキスト保存** —— GitHub に出て fetch で checkout に戻る / bundle より部品が増える /
  commit 単位の記録が消える。
- **写せなければ workspace を quarantine** —— 本番の task は決着した pin の子のブランチを外さないので無関係なのに止まる。
  故障は checkout の性質でなく盤面の器の性質である。
- **受験者ごとの failure question(ADR 0149 の session ごとの形をそのまま)** —— 原因1つに受験者の数だけ pickup が失敗して question が立つ。
- **兄弟へ伝播(held)** —— 同じ Interview の中では1枚で済むが、他の Interview と本番の session は各自で踏む。軸は盤面である。
