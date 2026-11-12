# Quarantine の登録は冪等で、開いた question が停止の唯一の記録 —— 再発火の event は持たない

**Status 追記: 決定4 の landing の poll は、drift に加えて ref の帯域外の移動の観測者にもなる —— 無人 merge の tick は積み残しを読む同期区間の頭で、外部 merge の走査は閉じた PR の下に取り残された子を告げる読み(lineage と内容)の頭で、全 ref を基準と比べ、動いていれば workspace の Quarantine を登録する。走査が PR の状態を観測して刻むところは ref を読まないので比べない。決定4 が挙げていない収束も同じ比較をする([ADR 0370](0370-landing-compares-every-ref-of-the-named-place-against-the-baseline-before-it-carries-or-records-and-the-acceptance-hole-goes-to-the-door-design.md) 決定1、2026-11-12、issue #3151)。**

**Status 追記: 決定2 が挙げる session 側の記録は、停止が session を止めた経路のものである(2026-11-11、issue #3146)** —— 走行中の session の verb が開いた agent の Quarantine に当たる経路(`attributedAuthorityOrQuarantine`、ADR 0224)は session を止めず、verb を拒否文で拒むだけで、`pickup_stopped` / `session_stopped_by_resource` / failure question のどれも書かない。当たった事実の持ち主は worker の transcript(ADR 0149 決定1)で、Episode の投影はその verb を失敗した行動として持つ。盤面 DB の event には写さない —— transcript を読まずに session を跨いで数える読み手(meta-review の材料、Episode、WebUI、人間の手順)は無い。その読み手が現れたら session 側の event を足す。

2026-11-10 の grilling(issue #3121 / #3122、#3094 の実装 review の派生)で決定。Quarantine の登録口 `registerQuarantine` は、鍵
(kind, value)の question が開いていれば既存の question に `quarantine_refired` を足していた。「開いていれば足してよい2度目」と「足しては
いけない2度目」を分ける線は登録口に無く、呼び手ごとに別の書き方で守られていた —— pickup の門はループが止めた資源を読み直す、
`quarantineUnlessClear` は開いていれば検査を撃たない、poll の失敗は `openQuarantineQuestion` を先読みする、watchdog の梯子は `settled` の
旗、ADR 0274 決定3 は記録から「撃ち済み」を導く。守りを持たない呼び手が、再起動した後始末の drift の解き直し(#3121)と landing の
tick ごとの名前の解決(#3122)で、開いた question に `quarantine_refired` を tick ごと・復旧ごとに積んだ(実測は両 issue のコメント)。
全呼び出し箇所を数えると、守りを持たない盤面自身の読み直しは他に8箇所あり、`quarantine_refired` を読むコードは落ちた後始末の受理の
確認 1 つだけで、人間が読む面は無かった。

## 決定

1. **Quarantine の登録は冪等である。** 鍵の question が開いていれば何もしない、閉じていれば 1 枚立てる。登録口は 1 つで、呼び手は自分が
   門か後始末か poll か起動かを登録口に伝えない。ADR 0137 の「開いた question が唯一の状態」の帰結で、「同じ観測で2度撃たない」
   (ADR 0274 決定3)は呼び手の導出ではなく登録口の性質になる。
2. **`quarantine_refired` は廃止する。** 「ある session が開いた停止に当たった」事実の持ち主は session 側の記録(`pickup_stopped` /
   `session_stopped_by_resource` / failure question)で、question 側に写さない。落ちた後始末の受理の確認が「同期区間で step がまた投げた
   本文」を読む経路は、投げた手が持つ `cause` を slot の残りに添えて同じ process の中で渡す —— 受理の検査と確認は同じ回答の同期区間に
   居る(ADR 0343 決定1)ので、event を経由する理由が無い。
3. **「撃ち直さない」だけが目的の呼び手側の守りは消す。** poll の失敗と issue 展開の `openQuarantineQuestion` の先読み、後始末の
   `neverRan` による登録の抑止がそれで、登録口が冪等なら要らない。別の目的を持つ守りは残す —— `quarantineUnlessClear` は検査(probe)の
   費用と副作用を省くため、pickup の門のループは止めた資源の task を候補から外すためのもので、登録の重複を防ぐためではない。
4. **session の後に workspace の名前を読む landing の poll は drift の観測者である。** 走る前は pickup の門、走った後は後始末、session が
   終わって PR が待つ間は landing の 2 つの poll(無人 merge・外部 merge の走査)—— landing が登録をやめると、drift した workspace の
   PR は誰にも告げられずに待ち続ける。ADR 0363 決定2 の「走った後の観測者は後始末 1 人」は slot を握る session の中の話で、landing は
   その外に居る。

## 退けた形

- **登録口を 2 つに分け、「盤面の外から来た新しい契機」(worker session の観測、人間の回答)だけが `quarantine_refired` を積む** —— 契機の
  単位(session か呼び出し 1 回か)の線と約60箇所の分類が要り、守る対象は読み手を持たない event 1 つだった。ADR 0345 決定4 が
  「本物の再発火」と呼んだ受理の再実行の throw も、人間には拒否文で届いており、event は写しだった。
- **#3121 / #3122 の 2 箇所に `openQuarantineQuestion` の門を足す点修正** —— 写しを 6 つ目・7 つ目にするだけで、次の読み直しの呼び手が
  また忘れる。

## 影響

- Status 追記: ADR 0274 決定3(drift の箇条)、ADR 0345 決定4、ADR 0363 決定2(「呼び直すたびの `quarantine_refired`」の文)。
- GLOSSARY.md: Quarantine(drift の観測者に landing を足す)。
- ADR 0067 の「`quarantine_refired` と同じ形」・ADR 0137 決定4 の「再発火の記録が既にそうであり」は、形の先例として引いただけで決定は
  変わらない。
