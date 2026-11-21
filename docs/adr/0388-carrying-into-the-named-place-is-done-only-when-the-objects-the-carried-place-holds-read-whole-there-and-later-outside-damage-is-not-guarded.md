# 名前の場所へ運ぶのは、運んだ場所が自前で持つ object がそこで欠けも破損も無く読めて済む —— 運び終えた後の外からの損傷は守らない

**Status 追記: 決定1 の集合は「tip から自前の object だけをたどって届く、自前の object」(運んだ場所が作ったもの)と読む。借りている tree の下の object は入らない。「借りている object は消しても失われない」は前提でなく限界の言い換えで、名前の場所に運ぶ前から起きていた外からの損傷も決定4 と同じく守らない。新しい tree が直に指す自前の object は集合に入るので、決定3 の「決定1 が捕まえ決定2 が補う」はそれにも成り立つ([ADR 0398](0398-the-board-guards-what-the-carried-place-made-and-not-the-named-places-outside-damage-before-or-after-carrying.md) 決定1〜3、2026-11-21、issue #3494)。**

2026-11-21 の grilling(issue #3222、#3153 の ponytail-review の派生)で決定。完了の解放は、門の記録した tip の tree を読み、tip が
`task/<id>` から辿れれば task の checkout を消していた。tree の読みは blob を開かないので、門の後に名前の場所から blob を消すと、
checkout —— その blob の最後の写し —— が消えた。門の前から名前の場所に欠けていた blob も、object を借りる checkout では門が除外
(`--not --alternate-refs`)で pack に入れず、fetch も commit 単位のやり取りで送らないので、そのまま記録に入った。実測と消す箇所の表は
#3222 に置く。

1. **運ぶ —— 門の取り込み、退避の tip と WIP の取り込み、作業台の取り込み、Interview の出題の写し —— は、名前の場所へ入れた直後に、運んだ場所が自前の object
   store に持つ object が名前の場所で欠けも破損も無く読めて済む。** 集合は「運ぶ tip の閉包のうち、運んだ場所の自前の store にある
   object」で、借りている object は消しても失われないので入らない。退避の WIP と出題の写しの自前の store は、盤面が作業ツリーから書いた
   staging repo である。出題の写しでは、root の検証済みの tip の写し(面接室への alternates を外した形)も自前の store に数える
   —— root が commit 済みの object はそこにしか無い。確かめは ref と event を書く前に撃つ。確かめ方は集合を pack に組む形で、欠けは `rev-list` が、破損は `pack-objects` が落とす(`rev-list` だけでは zlib の破損を
   素通しする)。ADR 0369 決定7 の「運ぶ」の完了はこの確かめを含み、消す側(解放の event と checkout の削除、作業台の削除)は変えない。
2. **欠けていれば、集合を運んだ場所の自前の object の写しから pack にし、名前の場所の objects の内に置いた使い捨ての repo で
   `index-pack --strict` してから、その pack を名前の場所の `objects/pack` へ置いて確かめ直す。** fetch では直らない ——
   名前の場所は commit を既に持つので何も送られない(実測)。名前の場所そのもので `index-pack` を撃つと、同じ id の壊れた loose が
   在るとき `cannot read existing object info` で落ちる(実測、git 2.47)。pack を組む段も index する段も名前の場所の filesystem の上で
   走らせ、最後の置き換えを同じ filesystem の rename にする。確かめの `pack-objects` も名前の場所を借りる使い捨ての repo で撃ち、
   名前の場所に一時 file を書かない。入れ直した後、集合のうち loose として読めない名前の場所の loose file は、消さずに名前の場所の
   objects の内の退避先(`tidepool-damaged-*`)へ移してから確かめ直す —— git 2.56 の streaming は小さな blob で pack より loose を先に
   開くので、途中で切れた loose が正しい pack の前に立ち、確かめが通っても `cat-file -p` は読めない(git の source、CI で観測)。
   確かめ直しは pack を先に読む形と loose だけを読む形の両方で撃つ。揃わなければ運べなかったので、各入口の今の「名前の場所へ運ぶ段が落ちた」
   扱いに従う。
3. **完了の門の除外(ADR 0364 決定1)は変えない。** 除外で取りこぼした object は決定1 の確かめが捕まえ、決定2 が補う。門の pack を
   決定1 の集合に変えると、worker が `-l` 無しに repack しただけで集合が閉包全体に膨らみ、門が上限超過で task を落としうる。
4. **運び終えた後、消すまでの窓で名前の場所に起きる外からの損傷は守らない。** 盤面は名前の場所で gc・prune・repack を撃たず、git の
   自動 gc は ref から届かない object しか消さず、`task/<id>` が運んだ commit から外れれば解放の祖先の確かめが checkout を残す。借りる元の
   repo の prune は運んだ object に当たらない —— fetch は新しい object を名前の場所の自前の store に書く。残るのは人間の手と disk の損傷で、
   消した後に起きても同じだけ失われる。窓の中だけを守れば、消す箇所ごとに確かめと出口と残した場所の記録が要る。損傷を見つける側は #3484。

## Considered Options

- **消す前に確かめる**(消す箇所の全部で確かめ、揃わなければ残して Quarantine に落とし、残した作業台を記録で負わせる)—— この grilling で
  一度採って取り下げた。守るのは運んでから消すまでの窓だけで、窓の幅は解放が延びたかの偶然で決まるのに、消す箇所ごとに出口が分かれ
  (取り込みの後は回答を拒めない)、残した作業台の記録・読めない場所の閉包全体の確かめが積み上がった。保証の置き場を「運ぶ」でなく
  「消す」に付けたことが根だった。
- **何もしない** —— 門の前からの欠けは盤面の除外と fetch が作る穴で、外の損傷ではない。
- **閉包全体を確かめる** —— 解放のたびに repo の大きさに比例する。起点側の欠けは名前の場所の故障で、運んだ場所の成果ではない(#3484)。
- **消さずに一定期間保管する** —— 作業ツリーごとの保管で disk が解放ごとに増え、空にする持ち主と寿命が新たに要る。
- **確かめずに毎回、自前の object を名前の場所へ入れる** —— 人間の repo に運ぶたびに pack が増え、壊れた loose と正しい pack のどちらを
  git が読むかに依るので確かめは残る。

## Consequences

- Status 追記: ADR 0369 決定7(「運ぶ」の完了に決定1)、ADR 0364(門の後の確かめと、fetch でなく pack を直に入れる取り込み直し)、
  ADR 0367(退避の WIP も staging repo の自前の store で確かめる)、ADR 0371(作業台の取り込みも決定1)、ADR 0273 決定3(出題の写しも決定1)。
- 決定1 の「借りている object は消しても失われない」は、名前の場所で借りている側の object が先に欠けているか壊れていると
  成り立たない(walk が借りている tree で止まる・`git add` が壊れた同じ id の loose を使う、実装時の実測)。扱いは #3494 で決める。
- 借りない checkout(Interview の root と受験者)では集合が面接室の閉包全体になり、門と同じ大きさの確かめが運ぶたびに走る。
