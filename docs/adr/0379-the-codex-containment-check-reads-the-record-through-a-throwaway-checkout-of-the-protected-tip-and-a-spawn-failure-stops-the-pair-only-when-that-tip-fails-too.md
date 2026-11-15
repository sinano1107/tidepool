# Codex の封じ込めの検査は記録を読む —— 保護ブランチの tip を使い捨ての checkout に展開して列挙させ、spawn の検査は2段で組の停止と task の失敗を分ける

2026-11-13 の wayfinder(map #3178、ticket #3206)で決定。(codex, workspace) の組の検査は、spawn では task の checkout を、組の question への
回答時には名前の場所の作業ツリーを読んでいた。回答時の読み場所を決めた ADR は無い —— ADR 0360 が「記録を読む」に替えたのは Claude の組
だけで、Codex の側は実装の形だった。この形には穴が3つあった。remote-backed で origin の保護ブランチを直しても回答が通らない(受理は origin
から引かず、作業ツリーは別の session が走るまで追いつかない)。作業ツリーにだけある untracked な skill が回答だけを落とす。修理前に fork
した task は修理の後も同じ skill を持つ checkout で spawn され、直した組を止め直す。この ADR は Codex の組の検査を Claude の組(ADR 0360
決定3)と同じ骨組みに揃える。受理が全 ref を基準と比べることは ADR 0373 決定10、purely-local の取り込みは ADR 0371 決定6 が持つ。コードの
読みと `skills/list` の実測の表は ticket(#3206、#3244、#3250)に置く。この形の盤面は走らせていない。

## 決定

1. **回答時の検査は記録を読む。** 保護ブランチの tip を盤面が使い捨ての checkout に展開し、Codex 自身に列挙させる(ADR 0259 決定2 は
   不変)。remote-backed は origin から保護ブランチを引いてから読み、fetch の失敗は理由をそのまま返す回答の拒否である。名前の場所の
   作業ツリーは読まない。Claude の組の `ls-tree` と違って checkout に展開するのは、探索の規則を写さないためである —— Codex に列挙させる
   には木が disk に要る。
2. **使い捨ての checkout は task の checkout と同じ作り方の git repo にする。** objects は名前の場所から借り、task の checkout と同じ基点の
   下に置き、検査の後に消す。名前の場所には何も書かない。git repo にするのは、plain dir に展開すると、置き場所が git repo の中のとき
   外側の repo の skill を拾うからである(実測)。同じ基点は spawn と条件を揃えるためだけの決定で、実測では答えを変えなかった。
3. **spawn の検査は2段に分ける。** task の checkout の検査が落ちたら、同じ検査を保護ブランチの tip の使い捨ての checkout に当て直す。
   そこでも落ちれば (codex, workspace) の組の停止、通れば task の失敗である。ADR 0259 決定3 の「そうでなければ組を不成立にする」は
   2段目が落ちたときだけになる。`task/<id>` は組の停止で消えず、再 pickup は保護ブランチに追いつかないので、1段のままでは人間が直した
   組を修理前の task が止め直す。追加の Board call は落ちたときだけで、path の突き合わせはしない。
4. **task の失敗は Claude の先例と同じ形で記録する。** `spawn_failed` の族に kind `unhideable-task-skills` を足し、failure question の推奨は
   abandon(ADR 0360 決定3)。task の失敗になるのは worker がタスクブランチに skill を足した場合に限らない —— 修理前に fork した task と、
   その系譜から切る子も同じ形になり、出口は abandon だけである。ADR 0360 決定3 の理由「worker の仕業」が当たらない場合で、Claude の組にも
   今ある穴なので、ここでは直さず #3212 に出した。
5. **Interview の root と受験者は組を止めない。** 保護ブランチに当て直さず、常に task の失敗である(ADR 0360 決定3「面接室には人間の
   書き手が居ない」と同じ規則)。面接室の名前の組は生まれなくなる。
6. **remote-backed の修理に扉は作らない。** 自前の clone から origin の保護ブランチへ入れてから答える —— Claude の封じ込めの修理、
   人間しか書けない path(ADR 0376 決定10)と同じ道である。purely-local は Claude の組と同じ1手で、組の Quarantine の登録の時点で盤面が
   作業台を開き(ADR 0373 決定9)、回答が tip を取り込んでから検査する(ADR 0371 決定6)。盤面は skill の出所を判別しないので、host が
   原因の停止でも作業台は開き、理由の文と拒否文は「原因が記録にある場合」の道を条件つきで足すだけで、今の文は残す。
7. **回答の枝は harness で分けない。** 基準との比較・fetch・比べ直し・in-flight の鍵・拒否は1本で、harness ごとに違うのは「保護ブランチの
   tip に当てる検査」だけである。spawn の2段の分け(組の停止 / task の失敗)も1つの手に寄せる。
8. **ref を動かさない直しは対象外のまま。** host の設定の skill の直しは ref を動かさない。名前の場所の作業ツリーにだけある untracked な
   skill は、検査が読まなくなるので契機でなくなる。host 側の skill が閉じきれなければ両方の段が落ちて組の停止になる —— 今と同じ扱いである。

## 退けた形

- **回答時の検査を名前の場所のまま、fetch → park して読む** —— 変更は小さいが、手で作業ツリーを直したときの循環(回答は通り、次の spawn が
  止め直す)と、untracked な skill が回答だけを落とす食い違いが残る。
- **remote-backed に作業台を足す** —— 「remote-backed の保護ブランチ向けは origin 経由、名前の場所からは push しない」の線と食い違い、
  origin への push を誰が撃つかの問いが新しく生まれる。
- **扉を作らず、ref を動かさない直しだけを案内する** —— tracked な skill は記録から消さない限り spawn が読み続ける。
- **面接室の名前の組を残す** —— 人間が直せる場所が無い組になる。Claude の組に規則が既にある。

## 帰結

- `Status 追記` を置いた: ADR 0259(決定3 の2段、決定5 の Codex の読む場所、決定2・3 の「task の workspace」の読み)、ADR 0360 決定3
  (Codex の組にも当たる)。`GLOSSARY.md` の Workspace containment を直した。
- 決定5 と決定8 の組み合わせ: Interview の task は保護ブランチに当て直さないので、host 側の skill が原因でも task の失敗になる。Claude の
  組には host が原因の場合が無く、同じ規則でも結果が違う。
- spec が決める(#3178 の「Spec へ渡すもの」): 理由の文と拒否文の文面。2段目の列挙そのものが失敗したときの扱い(ADR 0259 決定6 の族に
  入る見込みだが、ticket は決めていない)。組の Quarantine の登録の時点で作業台を開く手を Codex の spawn の経路から撃つ形(読んでいない)。
- 限界: 列挙の実測は合成 fixture と、task の checkout の作り方を shell で写した代役に撃ったもので、盤面が作った実物の checkout は受け入れで
  確かめる。回答の経路は通していない。手で作業ツリーを直したときの循環は読みからの推論である。
