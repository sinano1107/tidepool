# 異議は読んだ記憶にも帰責され、cause `memory` は worker ではなく記憶側の閉路に流れる

2026-09-28 の triage(issue #1045、#1038 後の記憶機構の見直し)で決定。approved の Behavior が誤っていても、それへ戻る負の信号が
無かった。帰責 Board call の入力はエントリ本文・steering・決定ログだけで、worker がその decision の前に読んだ記憶は渡らず、cause の
語彙(ADR 0115 決定1)に「従った指針が誤っていた」に当たる値が無い。誤った Behavior に従って異議されると `capability` が付き、worker
宛の RCA と candidate が立つ —— 記録が worker の落ち度と言い続け、routing 学習器の負の信号にも数えられる。閉路を閉じられる者は
`list_precedents` の `entries_read` を読む meta-review だけだが、そう指示されてもいなかった(RCA には Precedent の読み口が無い)。
今の機構でもこの失敗は記録には残る(Precedent の `entries_read` + cause)が、誰にも見ろと言っていないので観測待ちは成立しない。

## 決定

1. **cause の語彙に `memory` を足す —— 持ち主は記憶。** worker が異議された decision の前に `read_memory` で読んだ entry が誤っていた、
   の判定。語彙は1本のまま(ADR 0115 決定1)なので配分評価の値域にも入るが、`preference` / `requirement_change` と同じく異議でしか
   現れず、配分評価の prompt には載せない —— 配分評価の入力に読んだ記憶が無いため。種別は問わない: Behavior / Exemplar / Knowledge の
   どれを読んで従ったかで cause は分けない(無効化・置き換えの口が種別で分かれるのは記憶側の既存の分岐)。
2. **帰責 Board call の入力に「異議された decision より前に、同じ worker session で `read_memory` が返した entry」の本文を足す。**
   id・種別・title・text。集合は session 単位(その `worker_spawned` から decision event まで、Precedent の `entries_read` と同じ線)
   —— 上限到達で再 spawn した task の前 session の pull は、今の worker の文脈に無かった。event 順で組み、transcript の結合には
   依らない —— 帰責は commit 時の同期処理で、transcript の無い session でも判定する。
3. **判定は cause に加えて `entries`(誤っていた entry の id 列)を持ち、`memory` のときだけ必須。** 門は構造で引く: 名指した id が
   すべて入力の読んだ集合に含まれること。含まれない・空なら `uncertain` に倒す(読んでいない指針には帰責できない)。ADR 0115 決定1 が
   「影響の軸は散文の evidence にとどめる —— 振る舞いを変える消費者がまだ無い」とした条件が変わる: meta-review(Precedent)と人間の
   面が消費者になる。cause 以外の構造化された列はこの1つ。
4. **`memory` は worker 側に何も立てない。** commit 時は修理だけ(ADR 0115 決定3 の `requirement_change` / `environment` の列)、
   Behavior / Knowledge の candidate は書かず(決定4 に `memory` → 書かない)、routing 学習器の負の信号に数えない(決定5 の除外に
   `memory`)。worker に落ち度が無い cause では self RCA の問いが空で、実行設定のセルが悪かったのでもない。
5. **記憶側の閉路は meta-review が閉じる。** `objection_attributed` は既に meta-review の材料で、Precedent は cause と `entries` を運ぶ。
   purpose に「cause `memory` の Precedent はその `entries` を読み、誤った entry を落とすか置き換える」を足す —— Behavior / Exemplar
   は提案 question、Knowledge は直接適用、という既存の分岐に乗る。帰責の Board call が置き換えを起草する経路は作らない。
6. **人間の面は帰責を見せる。** ログ読取面の異議の注釈は今 comment だけを運ぶ。cause と `entries`(entry への参照)を併せて出し、異議を
   打った人間がその場で settings から無効化できるようにする。周期は破らない —— `memory` の帰責で meta-review を即時に due にする
   経路は足さず、急ぐ無効化は人間の手に置く(観測は issue #1045 の派生)。
7. **`memory` は無効化の理由コードにならない。** 理由コードは cause の一部(`capability` = 誤っていた、`environment` /
   `requirement_change` = 陳腐化した)を再利用するが、記憶を「記憶が誤っていたから」落とすのは循環で、誤っていた記憶の理由は
   `capability` のまま。

## 退けた案

- **cause は据え置き、`objection_attributed` に従った entry の id 列だけ足す** —— 「保存する値は cause 1つ、持ち主は cause からの
  読み方」(ADR 0115 決定1)を崩し、`capability` のまま worker 宛の RCA と candidate、負の信号が立ち続ける。
- **何も足さず meta-review の purpose に「`capability` の Precedent は `entries_read` を見よ」と指示する** —— 記録が worker の落ち度と
  言い続ける。判定の持ち主を変えない指示は閉路にならない。
- **帰責の Board call が置き換えの candidate も起草する** —— approved Behavior の置き換えは meta-review の提案の仕事(ADR 0120
  決定3)で、起草 client には INDEX しか渡っておらず、2つ目の起草経路になる。
- **`memory` の帰責で meta-review を即時に due にする** —— 盤面が周期を破って起動する経路を1つ足すより、人間の面に参照を出す方が
  安い(決定6)。
- **誤った entry の id は evidence の散文で名指すだけ** —— meta-review と人間の面が LLM の散文を解析することになる。消費者ができた
  ので列にする(決定3)。

## 既知の穴

Definition は注入で本文が INDEX に乗り、`read_memory` を経ないので読んだ集合に入らず、誤った Definition は `memory` を受けられない。
Definition は枝の担当範囲の宣言で、それに従って外れた decision の形がまだ観測されていないので、線は置かない(派生 issue)。
