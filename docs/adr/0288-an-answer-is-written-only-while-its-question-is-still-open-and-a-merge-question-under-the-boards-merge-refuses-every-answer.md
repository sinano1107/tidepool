# 回答は書き込みの時点で question が開いているときだけ書く —— 盤面が merge 中の merge question はどの回答も拒む

2026-10-20 の grilling(issue #1821、#1759 の派生)で決定。人間の回答は、書き込みの前に await をはさむ種類が4つある ——
PR 昇格の retry(収束)、merge question(PR の読み取りと merge)、quarantine(検査)、registry の提案の approve(registry への
commit)。その間に別の経路が同じ question を観測で閉じうる。閉じる経路は7か所あり(遅い走査、回答受理直前のバックストップ、
表の書き口の hook、meta-review の due 判定、memory の陳腐化、断られた対象の掃除、retry の収束)、どれも「まだ todo なら」の
条件つきで閉じる。回答の書き込みは、呼び手が最初に読んだ時点の状態しか確かめていなかった。実測では、quarantine の検査を
await している間に観測が question を閉じ、閉じた question の上に `question_answered` が書かれて解除の event が2件残った。
窓と実測は #1821 に置く。

## 決定

1. **回答は、書き込みの時点で question がまだ開いているときだけ書く。** 閉じていれば回答の transaction ごと止める。
   条件は書き込みの1か所に置き、観測決着と同じ綴りにする。閉じる経路がどこにあっても効き、経路が増えても漏れない。
2. **印の付いた PR の merge question は、値に依らずどの回答も拒む(ADR 0236 決定3 の拡張)。** 印の付いた merge
   question を閉じうる経路は、別の人間面からの `hold` 回答だけである(merge question は親を持たず、question の直接
   cancel は門が拒む)。進行中の merge は止められないので、hold を受理すると merge を執行した回答が決定1 で止まり、
   `pr_merged` が残らず ADR 0236 決定1 が破れる。拒めば merge question を閉じる経路は無くなり、`merge` 回答の
   `question_answered` と `pr_merged` は同じ transaction のまま残る(ADR 0265 決定1)。
3. **書き込みより先に済んだ外への効果の記録は、回答と切り離して残す。** registry の提案の approve は commit が着地
   してから回答を書く(ADR 0150 決定5 —— 順だけを決め、transaction は縛っていない)。commit が返った直後に自分の
   transaction で `agent_tier_changed` を刻み、回答はその後に試みる。question が閉じていて回答が止まっても registry が
   変わった事実は真なので、残さなければ盤面の記録と registry が食い違う。
4. **止まった回答への応答は、閉じた理由で分ける。** 観測で閉じていれば 200 と観測で閉じた印(ADR 0265 決定7 の形 ——
   バックストップが回答を観測に変えたときと同じ)。人間の意図は満たされたか無意味になっている。別の回答か cancel で
   閉じていれば DomainError。

## Considered options

- **回答中の question に処理中の印を持たせ、閉じる7か所が印を読む** —— retry の `answering` 集合(ADR 0106 決定5)が
  既にこの形で、札の仕組みが2つになる。閉じる経路を足すたびに読み忘れうる。
- **`submitAnswer` の transaction の中で question を読み直す** —— 門が2か所になる。
- **効果のある種類だけ、閉じていても回答を書く** —— 誰も決めていない question に決定を残さないという決定1 の規則に穴を開ける。
- **今のまま** —— 閉じた question に決定が残り、解除の event が二重になる。
