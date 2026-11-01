# 後始末の step は冪等であるか記録から2度目を飛ばせなければならず、盤面自身の HEAD の移動も ref の口を通る

**Status 追記: 決定2 の「比較には畳まない」は、`assertOnlyTaskBranchMoved` が HEAD の行を比較から外す形で実装した(2026-11-02、issue #2889)。**

**Status 追記: 決定3 の「残存 process が書いた形だけがここに来る」は成り立たない —— タスクブランチの `.gitignore` だけが無視していたファイルも、休止位置への checkout の後に untracked として現れてここに来る(2026-11-02、issue #2889)。**

**Status 追記: 決定4 の「HEAD はタスクブランチのまま」は merge back の conflict では成り立たない —— HEAD は帰り先に居り、再実行は盤面が動かしたと読んで同じ conflict に着き、`quarantine_refired` を足す(2026-11-02、issue #2889)。**

2026-11-01 の grilling(issue #2889、#2879 の実装で見えた形)で決定。後始末 `teardown()` は [tree rule → 状態遷移と印を消す tx → 枠の解放]
の1手で、tx が投げると受理の撃ち直し(ADR 0112 決定3)も再起動の復旧(ADR 0254 決定2 / ADR 0315 決定1)も tree rule から走り直す。
tree rule の最初の読み(HEAD が `task/<id>` か —— #234 ケース1 の検出)を、同じ tree rule の最後の書き(休止位置への `git checkout`)が
壊すので、2度目は「`main` に居る、commit を拒む」という偽の workspace Quarantine を立て、その workspace の task が枠に入れなくなる。
欠陥は commit 点の位置ではなく tree rule の性質にある: 自分の事後条件が自分の事前条件を破る手は再実行できない。
「後始末の再実行は安全」は ADR 0112 決定3・ADR 0254 決定2・ADR 0315 決定1・ADR 0342 決定6 が共有する前提だったが、決めた ADR も測った
ADR も無かった。runner が撃つ全 step の再実行の分類は #2889 のコメントに置く —— process 内で2度目の効果を生むのは tree rule だけである。

## 決定

1. **後始末の step は、冪等であるか、記録から2度目を飛ばせなければならない。** 落ちた後始末の受理(ADR 0112 決定3)、再起動の復旧
   (ADR 0254 決定2 / ADR 0315 決定1)、投げた手からの撃ち直し(ADR 0342 決定6)はこの性質に乗る。step に外の副作用(git・ファイル)が
   あり、その完了を記録からも実物からも導けないなら、その step は再実行安全ではなく、この決定の違反である。印は足さない —— 完了の
   事実は、その step 自身の書き込みの予告(決定2)か、既存の記録(status・event・基準)から導く。
2. **盤面自身の HEAD の移動も ref の口(ADR 0243 決定4)を通る。** 基準(ADR 0064 決定6)に HEAD の行を1本持つ —— pickup の撮りで
   `symref=refs/heads/task/<id> HEAD`、盤面が checkout を動かすとき(後始末の merge back の帰り先への checkout、休止位置への checkout、
   quarantine 受理のやり直しの同じ2つ)は `<old>|<new>` に予告→checkout→畳む。HEAD は symbolic ref であり、ADR 0243 決定4 の
   「盤面の ref の書き込みはすべて口を通る」が今は片側(値を動かす書き込み)だけに掛かっていた非対称を閉じる。#2889 は ADR 0243 が
   ref の値について塞いだ #1846 の族の、HEAD の位置の instance である。worker が終わりに自分のブランチに居ないことは今日どおり
   tree rule の HEAD 検査が先に捕まえる(退避の commit より前に読む必要があるので、比較には畳まない)。
3. **tree rule の HEAD 検査は基準を読む。** HEAD が基準の予告した位置か畳んだ位置(タスクブランチ以外)にあれば盤面が動かしたと
   読み、退避と ref の比較 —— session が残したものの判定で、1度しか成り立たない —— を飛ばす。merge back(`isAncestor` で no-op)と
   休止位置(`checkout` + `ff-only`)は冪等なので再走させる。HEAD がその位置にあって tree が dirty なら「盤面が休止させた後に書かれた」を
   理由に workspace Quarantine に落とす(fail-closed。落ちた盤面の裏で残存 process が書いた形だけがここに来る。通常の完走の後に人間が
   dirty にした checkout は後始末を通らないので当たらない)。HEAD がタスクブランチにも予告の位置にも無ければ今日どおり違反である。
   git が終わって記録が書けないまま落ちる窓は、予告の2値一致(ADR 0243 決定2)が吸う。
4. **Quarantine に落ちて返った tree rule の再実行は、同じ観測の再発火である。** HEAD はタスクブランチのままなので tree rule は再走し、
   `registerQuarantine` が開いた question に `quarantine_refired` を足す(question は1枚のまま)。実際に同じ壊れた checkout を読み直して
   いるので記録は足さない —— ADR 0274 決定3 の「同じ観測で2度撃たない」が退けたのは偽の2度目である。

## 退けた形

- **tree rule の完走の event を書き、後始末がそれを読んで tree rule を丸ごと飛ばす**(triage の推奨、使い捨てで4経路とも緑) —— 進捗の
  事実を1つ足す。ADR 0274 が「止まった段階を payload に書く」を退けた根拠(決着の event と checkout の実物から導けるので要らない)が、
  決定2 で導出可能になった後はそのままこの形に向く。git 完了から event までの窓も残る。
- **checkout を読んで「休止位置・clean・merge back 済み」なら通ったと見なす** —— 通すのは「worker が `main` に移って clean なまま終わり
  ref は1本も動いていない」の1形だけで、失うのは不変条件でなく信号だが、記録で解ける形があるのに信号を捨てる理由が無い。
- **`teardown()` を [tree rule, tx, 解放] の手に割り、runner に通す** —— 効くのは process が生きている受理だけで、再起動を跨ぐ復旧
  (ADR 0342 決定1 の (A) の後、(B) の再デプロイの後 —— 実際に来る2形はどちらも再起動を跨ぐ)では tree rule から走り直す。
- **再実行では tree rule を飛ばし、次の pickup に任せる** —— tree rule の走っていない workspace へ次の session が入る #382 の形。
- **比較も再走させ、完了経路の fetch を口に通してから**(#2459) —— 比較は session の終わりの判定で、再走に新しい事実が無い。#2459 は独立のまま。

## 派生

- Status 追記: ADR 0064 決定1(集合に HEAD の行)、ADR 0243 決定4(checkout も口)、ADR 0112 決定3・ADR 0254 決定2・ADR 0315 決定1・
  ADR 0342 決定6・ADR 0343 決定2(前提の持ち主は本 ADR 決定1。ADR 0344 決定3 の閉じ直しは記録から導く冪等な step で、決定1 を既に満たす)。
- GLOSSARY.md の Slot-release tree rule と branch discipline の項。
- 実装は1 slice、#2889 のコメントが spec。step の分類で見えた範囲外の2形(再起動を跨ぐ `quarantineContainment` の記録の門、
  `settleAndReclaim` の `record` が門より前に走る形)は別 issue。
