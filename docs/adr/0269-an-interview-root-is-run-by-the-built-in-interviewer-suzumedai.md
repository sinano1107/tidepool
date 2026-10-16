# Interview の root は組み込みの Interviewer `suzumedai` が走らせる

2026-10-16 の grilling(issue #2109)で決定。Interview の root を誰が走らせるかを決めた ADR は無く、「review type のルート task」
(ADR 0111 決定6)と「review の空の assignee は Auditor ポインタへの参照」(ADR 0233 決定3)の合成で Auditor `fugu` が走っていた。
fugu の本文は空(ADR 0017 / 0089)で、Interview の手順は verb の説明(`pose_probe` / `complete_interview`)が運ぶが、見分けの
つく probe と rubric の書き方・採点の規律という**観点**はどこにも無い。root への異議から立つ RCA の Behavior は root を走らせた
agent 宛てなので(ADR 0268 決定3)、Interview ごとに別の agent を名指すと学びの宛先が散る。

## 決定

1. **組み込み agent `suzumedai` 🐠 を置く。** ADR 0117 の機構そのまま —— code が定義を運び、review 専用(ADR 0228)、profile は
   reviewer 定数で授権は増えない、registry の同名エントリに shadow される。本文は観点(probe・rubric・採点)だけで、手順は verb の
   説明に残す(ADR 0017 の「本文は専門性のみ」)。初版は実装が書き、PR で人間がレビューする —— shadow で差し替えられるので初版の
   完成度は門ではない。名前は潮だまりの住人から(ADR 0017)。
2. **役割ポインタ `TIDEPOOL_INTERVIEWER`(env、既定 = `suzumedai`)を足し、Interview の root の空の assignee はそこに解決する。**
   ADR 0117 決定4 の2本(`TIDEPOOL_AGENT` / `TIDEPOOL_AUDITOR`)と同じ形で、ADR 0233 決定3「review の空の assignee は Auditor」の
   Interview の root だけの例外になる。人間は Register で別の agent を名指せる。
3. **学習は名前宛ての Behavior で届く。** registry への diff(authority / agent の `tier`)は組み込みに当たらないが、authority は reviewer
   定数(ADR 0013 —— 強制床への diff を提案させない)で、review の段は task の `review_tier` なので、当たる先が無いのは Auditor と
   同じ。判断の優先順位は Behavior が圧縮形として引き受ける(ADR 0083 追記3)。本文を変えたければ shadow が勝つ。
4. **本文を持つ最初の組み込み agent である。** ADR 0117 が #567 に預けた「専門 agent の本文の存在価値」は、suzumedai が走れば測れる
   —— 条件を満たしたのではなく、測れる対象が現れる。

## 退けた形

- **今のまま Auditor に任せる** —— 観点が無く、名指すたびに学びの宛先が散る。
- **ポインタだけ足し、組み込みは置かない(既定 = Auditor)** —— 最初から Interview を機能させる本文を盤面が持てない。
- **専門 agent を registry の種に置く** —— 種まきは消した(ADR 0089 / 0117)。shadow で同じ自由が残る。
