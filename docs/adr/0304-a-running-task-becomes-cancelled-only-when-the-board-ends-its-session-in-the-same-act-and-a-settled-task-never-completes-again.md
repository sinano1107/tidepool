# 走っている task は盤面が同じ行為でその session を終わらせない限り cancelled にならず、決着済みの task は二度と完了しない

2026-10-23 の grilling(issue #2527)で決定。祖先の直接 cancel の cascade は in_progress の子孫も cancelled にするが、その session は止まらない。
以後、盤面はその session を見失う —— watchdog の cap・worker の exit・回収の observer はすべて `in_progress` で門番しているので何も反応せず、
worker が `complete_task` を呼べば `done` に戻って cancel の記録が上書きされ、呼ばずに exit すれば slot は再起動まで握られたままになる。
この状態を生む経路は cascade だけで、他の扉(edit・自身の直接 cancel・pickup の行の再検査)はすべて「走っている task には触らない」線を守っている。
ADR 0006 の根拠3「単一 slot の下で cascade は todo にしか触れないので session kill は不要」は abandon の前提で、祖先の直接 cancel(ADR 0198)が
それを破っていた。実測の表と `file:line` は #2527 のコメントに置く。

## 決定

1. **不変条件: 走っている task は、盤面が同じ行為でその session を終わらせない限り cancelled にならない。** 門は cascade の共通部に1つ置き、
   倒す範囲に in_progress の task があれば cancel 全体を DomainError で拒む。3つの入口(abandon・直接 cancel・redecompose)が同時に守られ、
   abandon と redecompose が「走行中に届かないはず」であることも偶然の前提から規則になる。拒否文は走っている task を名指しし、
   止める手段(ADR 0305 の人間の停止と cancel の停止承認)を指す。session の後始末に入っている task(cap の中断で回収待ちの `in_progress`)も
   この門に掛かるが、回収済み観測で自然に解けるので特別扱いしない。
2. **決着済み(done / cancelled)の task は完了できない。** 床は完了の本体(`finishTask` —— complete_task・人間の扉・採点完了・統合レビュー・
   監査・meta-review の完了がすべて通る1本)に置き、transaction の中で行を読み直して判定する(引数の task は snapshot)。判定と文言は
   人間の扉が使う「settled」の線(`assertUnsettledNotInProgress`)の決着済みの半分を切り出して共有し、写しを作らない。done → done の
   二重完了(event 2件・統合レビュー2本)もこの床で閉じる。#964 が人間の扉だけを塞いで「本体は out of scope」と残した取りこぼしの回収。

## 退けた形

- **床だけ**(決定2 のみ): 走っている task を cascade が倒す状態は残り、worker の出口が escalate(cancelled の親の下に question が立つ)か
  黙った exit(slot 漏れ)になる —— 記録の欠陥を盤面停止に置き換えるだけ。
- **cancel が session を止める**: cancel は「計画を捨てる」操作で、session を止めた後の task の行き先と記録は別の主題。bundle すると
  その決定が cancel の中に隠れて書かれる(ADR 0305 で、人間が明示に承認した cancel だけがそれを行う)。
- **verb ごとの status の門**(`resolveAttributedTask` や各 verb): 不変条件が立てば slot task は in_progress 以外にならないので、写しが増えるだけ。
- **直接 cancel の扉だけに門**: 今届くのはその扉だけだが、それは ADR 0006 の根拠3と同じ「偶然成り立つ前提」。

## 帰結

- ADR 0006 の根拠3は「規則が守る前提」に変わる(同 ADR に追記)。
- #2240(走っている受験者の root を cancel すると session が slot を持ち続ける疑い)は同じ機構で、決定1 で状態そのものが起きなくなる。
