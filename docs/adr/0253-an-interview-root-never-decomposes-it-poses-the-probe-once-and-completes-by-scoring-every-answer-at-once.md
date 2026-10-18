# Interview の root は分解しない —— 出題で probe と rubric を確定して盤面が対象ごとの子を立て、採点完了で全答案の採点と完了を一度に行う

2026-10-14 の triage / grilling(issue #1901)で決定。ADR 0111 決定6 の「probe + rubric を先に decision log に書く」を
守らせていたのは verb の説明の1文だけで、判断ログの行は型を持たず、盤面はどれが probe かを引けなかった。pin の子の題・目的・
完了基準は root が子ごとに自由に書くので、全対象が同じ問題を解く保証も無かった。さらに pin の子は親の history から rubric を
読め、root は一度も分けずに子0のまま `complete_task` で done になれた。経路の照合は #1901 のコメントに置く。

## 決定

1. **Interview の root は分解しない。出題で進む。** 出題は、root が題・probe(問題文)・完了基準・rubric を一度に書く
   verb で、盤面は1つの transaction で (a) それを判断ログに載る型つきの event として確定し、(b) 一覧の対象ごとに pin の子を
   1つ登録する。子の題・目的・完了基準は全子に同じ出題の値、pin は一覧から、workspace は親から。root が子ごとに書くものは
   無いので、同じ問題を全対象に解かせることと、各対象にちょうど1つの子(ADR 0249 決定1)は構成で保たれる。出題は Interview
   1件につき1回(ADR 0245 決定3)。出題の event が Interview の分解判断で、子はその上に乗り(前提の破綻・abandon の範囲は
   今のまま)、登録者は root の agent(ADR 0194 決定1 —— 子が存在するのは root の出題による)。
2. **rubric は採点する側だけが読む。** root と人間は判断ログで probe・完了基準・rubric を全部読み、pin の子(受験者)には
   rubric を伏せる。rubric には採点の鍵が入り、見せると測るものが「その model がそのティアの品質を出せるか」から
   「鍵に従えるか」に変わる。
3. **pin の子は既定 agent として走る。** assignee は未指定(本番の未指定の work と同じ参照)。全対象が同じ agent 定義で走る
   ので比べられ、本番と同じ条件で測れる。走れるか(pin の provider が既定 agent の entry にあるか)は、対象を選ぶ人間に返す
   登録の扉と、既定が変わりうる出題の時点で検査する。出題の拒否は root には直せないので escalate を指す。
4. **root は採点完了で終わる。** 統合復帰した root は、done の子ごとの採点(accepted / rejected)の一覧と findings の
   handoff を1つの verb で渡し、盤面は done の子をちょうど1回ずつ採点しているかを検査して、採点の event と完了を1つの
   transaction で書く。途中まで採点した Interview という状態は無く、採り直しの規則も要らない —— ADR 0247 決定4 の
   「全部採点するまで完了できない」は拒否ではなく verb の形で保たれる。
5. **Interview の root に汎用の分解・完了の verb は無い。** `decompose` / `redecompose` / `score_interview` /
   `complete_task` を見せず、domain でも扉を問わず拒む。人間の扉は Interview の root を分けない(issue #1891)——
   ADR 0111 決定6 の「probe の著者は常に agent」を不変条件にする。子0のまま完了する経路もこれで閉じる。

## 退けた案

- **decompose に probe / rubric の必須欄を足す** —— 最初に推奨したが、対象・pin・assignee・題が全部盤面で決まるなら root が
  子を並べる意味が無い。
- **確定の専用 verb を先に打たせ、decompose は確定済みを要求する** —— 分解の前に何度も確定し直せ、どれが正本かの問いが生まれる。
- **`purpose` だけ盤面が埋め、題と完了基準は子ごとに書かせる** —— 完了基準が違えば同じ問題ではない。題は採点者の history に
  出るので、model 名を書けば伏せた採点(ADR 0199)が崩れる。
- **盤面が対象ごとに provider を持つ agent を探す / 登録時に人間が対象ごとに assignee を指定する** —— 前者は比べているのが
  model か agent 定義か分からなくなり、後者は対象の綴りに5つ目の欄を足して行・学習器のセル(4欄)と食い違う。agent ごとの
  適性を測る Interview は別の問い(issue #1918)。
- **採点を1件ずつ付けて最後に `complete_task`(今のまま)** —— 拒否で順序を守る形が残り、報告の前の採点(ADR 0251)のような
  途中の状態が生まれる。

## 帰結

- 出題の event への異議が何を意味するかは、pin の子への異議と同じ問いとして #1886 で扱う。
- 種別固有の仕事を汎用の `complete_task` で終える形は、meta-review・RCA・統合レビューにも残る(#1919)。

## 追記1(2026-10-16 の grilling、issue #2099 / ADR 0267)

決定1 の「一覧の対象ごとに pin の子を1つ登録する」「子はその上に乗り」は、親の無い受験者を対象ごとに登録する形に置き換わった ——
受験者は `parent_id` も `based_on_decision` も持たず、head と workspace は対象を経由して出題から引く。決定4 の「統合復帰」は
対象が全部決着して root の blocked が外れることを指す。決定2・3・5 はそのまま。

## 追記2(2026-10-18 の grilling、issue #2184 / ADR 0273)

追記1 の形(出題が親の無い受験者を登録する)の上で、登録の時点が出題から監査の受理に移った —— 出題は監査の review を立て、その受理で盤面が受験者を登録する。出題は面接室の写しを盤面名義で commit して分岐元の head にする。受験者が1人も立っていないあいだは出題をやり直せる。決定2・4 はそのまま。決定5 の「汎用の verb は無い」は type `interview` の verb 一覧として保たれる。
