# registry clone は workspace にならない —— 固定点として workspace との交差を拒み、registry の床は repo の同一性で掛ける

2026-11-14 の wayfinder(map #3178、ticket #3238、問いの出どころは #3234)で決定。registry clone(盤面が Registry を読む clone)は
「Registry の正本」と「workspace」の二役を持てた。二役からは特例が出続けていた —— registry の書き込みを workspace の基準に束ねる口と
その fallback、2つの宣言の突き合わせ、保護剥奪・削除・publish の3つの拒否、registry の default branch の Quarantine。兼ねる理由を
書いた ADR は無く、ADR 0040 は「むしろ設計上 workspace」と断定するだけで、ADR 0064 は兼ねることを「不変条件が最も弱くなる」と書く。
この ADR は二役をやめ、禁止の掛け方と、registry の床の鍵を決める。網の行き先は ADR 0378 が持つ。読んだコード・`file:line`・Pi の
確認は ticket に置く。決定はコード・ADR・docs の読みで、この形の盤面は走らせていない。

## 決定

1. **二役をやめる。** registry clone は盤面が Registry を読むだけの場所で、workspace にしない。基準の行も `task/<id>` も持たない。
2. **worker が registry を書く道は、registry の repo の別の clone を workspace にした registry-edit タスク → PR → 人間 merge → refresh で
   残る。** 守られていたのは「agent が registry を編集できること」で、別の clone で成り立つ(remote-backed の盤面は origin の main を読む)。
   purely-local の Registry には、worker が registry を書く道を持たない —— 書けるのは人間面の扉だけで、別の clone の着地を盤面の読む
   clone へ運ぶ機構は足さない。purely-local の Registry は test の構成にしか無い。
3. **禁止は ADR 0040 の固定点に registry clone を足す形にする。** 6つ目の固定点で、ADR 0040 の「registryDir は意図的に対象外」を反転する。
   拒むのは registry clone に解決する path だけでなく、中の path と外側を包む path もである(ほかの固定点と同じ包含の規則)。名前の場所を
   固定点と比べる既存の3箇所 —— 登録の扉、起動時の sweep、workspace の Quarantine の受理 —— がそのまま拒む。
4. **pickup の側に、名前の場所と固定点の交差の検査を1つ足す。** spawn の検査が見るのは task の checkout の番地(ADR 0356)で、名前の
   場所ではない。足さなければ、起動の後に手編集で届いた交差する entry を次の起動まで誰も拒まず、pickup がその間に registry clone へ
   `task/<id>` と基準を書きうる。置き場所は spec が決める。
5. **registry の床(ADR 0013「registry の変更は常に人間 merge」)の鍵を、path から repo の同一性に替える。** 床は、registry clone の
   origin と同じ repo を origin に持つ workspace の全部に掛かる。path が鍵のままでは、registry の repo の2つ目の clone を保護なしで
   登録すれば床を通らない(#3246)。
6. **床は保護の判定の計算で掛ける。** 保護 = entry の `protected` が true、または checkout の origin が registry clone の origin と
   同じ repo。比べるのは checkout の origin で、「同じ repo」の比べ方は ADR 0378 決定4 と出所を1つにする。保護剥奪の扉は、計算で保護が
   掛かる workspace を今どおり確認では買えない拒否で拒む。
7. **registry の default branch の検査は、registry の到達性の検査(ADR 0052 決定5)へ移す。** `origin/HEAD` が `origin/main` を
   指さなければ、registry に到達できないのと同じ盤面全体の停止である。受理は同じ検査を撃ち直し、harness に依らず掛かる。直す手
   (`git remote set-head`)は人間が registry clone で打つ —— 基準を持たないので違反にならない。
8. **registry の fetch・push・`update-ref` は、どの workspace の基準にも予告しない。** 束ねる先が無い。ADR 0243 決定4 の「盤面の ref の
   書き込みはすべて口を通る」の対象は、名前の場所の ref に限る。2つの宣言の突き合わせと、削除・publish の扉が registry clone を拒む
   項目は、当たる相手が無くなって消える。

## 退けた形

- **二役を残し、特例を1つずつ直す** —— 口の fallback の予告(#2980)、進む先の commit で名前が変わった場合(#3234)、default branch の
  Quarantine(#3193)が並んでいた。根は二役で、やめて壊れる運用は挙げられなかった(worker が workspace `registry` で走った実績は
  試行の1回)。
- **purely-local の Registry で、別の clone の着地を盤面の読む clone へ運ぶ** —— 本番に無い構成のための機構になる。
- **Pi の付け替え手順を作る** —— Pi は実稼働の前に作り直す。seed は registry clone を登録しない。

## 帰結

- 偽になる文に `Status 追記` を置いた: ADR 0040(対象外と「5点」)、ADR 0052 決定3(2つの宣言)、ADR 0064 決定4(表の registry の3行、
  「唯一の保護 workspace」、「registry の fetch で即座に露見する」)、ADR 0066 決定5(拒むのは3つ)、ADR 0087 決定3、ADR 0243 決定3・4、
  ADR 0020 決定1(default branch の不一致の行き先)、ADR 0013(「registry 自身は保護 workspace」)。ADR 0052 決定5 には default branch の
  検査が足され、ADR 0291 の「registry workspace」は registry の repo の clone を workspace にしたものと読む。
- map の中で当たらなくなった決定: registry clone の口の fallback の直し、進む先の commit の名前の扱い、「registry clone に当たる
  workspace は拒む」「registry clone も除外しない」(ADR 0371・0376 には書かれていない)。
- 手編集で入った交差する entry の publish は、remote-backed の Registry では registry clone が origin を持つので、既に origin が在る
  workspace の拒否(ADR 0066 決定5)が止める(読み)。purely-local の Registry では止めるものが無く、spec が確かめる。
- spec が決める(#3178 の「Spec へ渡すもの」): GitHub の URL として読めない origin の比べ方。origin が読めない workspace を保護と扱うか。
  default branch の検査が local の symref を読むままか remote を直接読むか。保護剥奪の拒否の名前と文面。一覧と wire の `registrySelf` と
  `protected` を計算の結果に合わせるか。registry の fetch に「値を先に知る」形(ADR 0243 決定3)を残すか —— ticket は決めていない。
- 限界: ADR 0013 は床を「データの状態に依存させない」と書き、決定6 は checkout の origin を読む。ticket はこの2つを照合していない
  (origin が宣言と別の repo を指す workspace は ADR 0378 決定3 が pickup で止める、までが書く session の読み)。ADR 0064 の
  Considered options が registry の書き込みを理由に退けた案(盤面自身の書き込みの直列化)は、理由が当たらなくなるが、採り直さない。
