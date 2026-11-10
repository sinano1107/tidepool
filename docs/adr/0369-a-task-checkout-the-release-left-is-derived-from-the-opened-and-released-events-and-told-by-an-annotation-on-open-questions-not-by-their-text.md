# 解放が残した task の checkout は開いた event と解放の event から導き、在り処は開いた question を読むときの注釈で告げる —— question の本文に書かない

2026-11-11 の grilling(issue #3147、#3126 の実装 review の派生)で決定。ADR 0356 決定2 は「解放のどの失敗でも checkout は残す」と決め、盤面は
残した checkout を再利用も移動もしない —— 中の成果を拾えるのは在り処を知った人間だけである。その告知は残す出口ごとに別の器に実装されていた:
worker の repo が読めない出口は failure question の本文、drift は workspace の Quarantine の理由(ADR 0363 決定4)、名前の場所の故障で
Quarantine に落ちる2つの出口は何も書かない。本文は登録した観測者が知っていたことしか載らないので、ADR 0366 が登録を冪等にした後は、別の
観測者(landing の poll など)が先に同じ鍵の Quarantine を立てると drift の在り処も消える。failure question が既に開いている task でも同じ穴が
あった。実測と出口の表は #3147 に置く。

## 決定

1. **盤面は残した成果を運ばず、告げるだけである**(ADR 0363 決定4 の線を、checkout を残す出口すべてに広げる)。Quarantine の受理で退避を
   やり直さない。workspace の Quarantine が開いている間その task は pickup されないので、人間には回答の前に成果を運ぶ窓がある。
2. **残した checkout の集合は記録から導く。** 開いた event があり、その在り処を名指す解放の event が無い checkout がそれで、読み手は1つ。
   解放の event を書くのは checkout を消す出口1つなので、残す出口が増えても漏れない —— 出口ごとに「残した」を書かせない。今の pickup の
   checkout は、session も後始末も終わってから数える(走行中の checkout は残したものではない)。決着した受験者の最後の checkout は記録として
   残すもの(ADR 0276 決定4)なので数えない。
3. **在り処は開いた question を読むときの注釈で告げ、登録するときの本文に書かない。** 誰が先に question を立てたかに依らない。載せるのは
   (a) workspace の Quarantine の question —— その名前が、task が開く場所の名前(停止の門と同じ集合)に入る task のもの、(b) 残した checkout を
   持つ task を親に持つ question —— 種類を問わない。回答済みの question には載せない。
4. **並べるのは task の決着を問わず全部。** 完了済みの task の checkout が唯一の写しである出口があり、未決着に絞ると告知から漏れる。
5. **列挙は disk を読まない。** 並びから外れるのは盤面が消して解放の event を書いたときだけ —— いつ消すかは #3057 が決める。path が一時的に
   読めないだけで告知が消える形を採らない。
6. **残した理由は注釈に載せない。** 理由の持ち主は止めた question(failure question か Quarantine)で、question を足さない解放の失敗では
   解放の失敗の event が持つ。

## 受け入れた限界

- 決着した受験者の checkout は、解放が落ちて残った場合も列挙に入らない(記録として残すものと区別できない)。在り処は Interview の詳細が出す。
- push 通知の本文(question の本文)は在り処を運ばなくなる。通知は question への link を持ち、開けば注釈がある。
- (a) は停止の門の集合を使うので、Interview の root が読むだけの面接室の Quarantine にもその root の checkout が並ぶ(過剰側)。

## 退けた形

- **drift の出口だけ直す**(landing が先でも理由に書き足す、など)—— 名前の場所の故障の出口が固有の成果を持つ checkout を告げないまま残り、
  登録の冪等(ADR 0366 決定1)に例外が要る。
- **残す出口ごとに「残した」event を書く** —— 4 つの出口のうち 3 つが書いていなかったのが今回の欠陥で、次の出口が同じ形で忘れる。
- **未決着の task の checkout だけ並べる** —— 決定4 の唯一の写しが漏れる。
- **読むときに disk の有無を確かめる** —— 決定5。読み口に filesystem の依存が入る。

## 影響

- Status 追記: ADR 0363 決定4(理由に在り処を書く)、ADR 0356 決定2(残して既存の失敗経路へ)。
- GLOSSARY.md: task の checkout、tree rule(drift の後始末の文)。
- #3057(残した checkout を片付ける契機)はこの実装の後に決める。実装は 1 slice、#3147 のコメントが spec。
