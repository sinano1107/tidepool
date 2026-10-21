# worker の消費の記録は親スレッドの分であり、Codex の subagent の消費は観測しない

2026-10-22 の triage → grilling(issue #2427)で決定。#1887 の実測で、Codex worker の `turn.completed.usage` は親 thread の累計だけで、
subagent(子 thread)の消費は入らず、subagent を使った session では入力の4〜5割が記録から抜けていた。同じことを Claude で測ると
(pin 2.1.286、fixture 2.1.237)、result 行の上位の usage も親スレッドの分だけで、subagent と advisor の分はモデルごとの内訳と費用にだけ
載っていた。範囲は Provider 間で揃っていて、違いは subagent の消費を運ぶ経路が Claude にあって Codex に無いことだった。実測の表と
vendor source の `file:line` は #2427 のコメントに置く。

## 決定

1. **`worker_exited.usage` の上位の token の4欄は、Provider を問わず、CLI が報告した親スレッド(worker 本人の main model)の消費である。**
   session 全体の消費ではない。Claude では、同じ上位にある `estimated_cost_usd` とモデルごとの内訳 `models`(ADR 0094 決定2)が
   subagent と advisor の分を含む —— token の4欄と費用で範囲が違う。Codex では、subagent の消費が4欄に入らず、remote compaction V2 の
   呼び出しの消費も親の累計に足されない(コードを読んだだけ、測定は #2430)。
2. **Codex の子 thread の消費を盤面が読む経路は作らない。** 「Codex では subagent の消費は観測できない」を Harness の事実とし、読み手
   に渡す。上位の token の欄を読むのは配分評価だけで、その prompt に書く。学習器が読むのは費用で、Codex ではもともと null なので、
   子の消費を測っても学習器が読む値は変わらない —— ADR 0287 決定1(subagent の仕事は親の行の実績に数える)はこの決定で崩れない。
3. **session ごとの印(子 thread が走った回数)は付けない。** 観測できるかどうかは記録の印でなく Harness で決める —— ADR 0083 追記10 が
   Codex の行動列で取った線と同じ。SubagentStart の hook は `--ephemeral` でも発火して回数と model を数えられるが、hook から盤面へ値を
   運ぶ経路を新しく作っても、読み手の判定は変わらない。ADR 0287 決定5 が subagent の model を記録しなかったのと同じ理由である。

## 退けた案

- **`--ephemeral` を外し、exec の終了後に子の rollout の累計を読む** —— ADR 0134 が退けた案の開け直しになる。過去の rollout を新しい
  exec の prompt に持ち込む読み手は、feature の閉じで既に閉じている。それでも、rollout が共有の CODEX_HOME に溜まる、exec の出力が
  変わる、`"all"` の fork が成功するようになる(盤面の文面の `"none"` は今、fork の失敗で守られている)の3つを、読み手1つのために
  変えることになる。終わった task の会話を resume する機能(#2431)の形が決まったら見直す —— Codex で本当の resume をするには rollout が要る。
- **`CODEX_ROLLOUT_TRACE_ROOT` で trace を書かせ、thread ごとに足す** —— 診断用の機能で、推論のたびに prompt 全体をディスクに書く。
  盤面が頼る面にしない。
- **上位の欄を session 全体の値にする**(Claude なら `models` の和)—— advisor の分まで混ざり、ADR 0094 決定2 が `models` で分けた形と
  重なる。Codex では子の消費が取れないので、どちらにしても Provider 間で揃わない。
- **Codex worker から subagent を外す** —— 記録は完全になるが、ADR 0134 が開けた能力を Codex だけ閉じ、Claude の行と中身が食い違う。
