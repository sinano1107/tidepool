# 統合点のレビューは必須、配分の評価は品質判定を固定した後に別の呼び出しで行う

2026-09-10 の grilling(issue #238 / #357)で決定。実行設定の選択(ADR 0110)を学習するには、全 task に一貫した受理ラベルが要る。
review flag による opt-in は「必須ではない」とだけ記録されており(ADR 0021 は付ける方向の権限を扱う)、opt-in を守る根拠は無かった。
一方で「子のレビューは統合点に委譲」「修理はそれを生んだレビューが見届ける」の線は既にあり、必須化の形を先に決めていた。
測定・実装の割り付けは #238 の spec issue に置く。

## 決定

1. **統合点でレビューは必須。** ルートの work task と、risk flag の子(親の完了前に外部影響を持つ)は登録者の宣言によらず完了時に
   レビューされる。review / question / human task は対象外。**review は終端** — findings への異議が review のレビューであり、
   review type への `review_flag` は登録時に拒否する(不発の値を受け取らない)。second opinion は人間のルート review(既存の道)。
   status は増やさない — 「受理」は統合点レビューの完了から導出される(Settled と同じ派生)。review flag は「非ルートの子を統合点を
   待たず個別に見る」の意味に狭まり、`review_by` は flag への同乗をやめて task の独立フィールド(list)になる。

2. **reviewer は agent、Auditor は「review_by 無し」の受け皿。** 観点を持つ reviewer(security、standards、UX …)は agent 名 =
   専門性(ADR 0019)で表し、read-only は type が保証する(ADR 0013)。`review_by` が list になり、1つの統合点に複数の review task が
   立ち、全部の完了(修理の見届け込み)で受理。誰を付けるかの学習は登録者(decompose する親)の Behavior であり、selector は
   「誰」を選ばない。既定 agent / Auditor のポインタは「書かなかった人間」の受け皿として残る。組み込み化は別 issue。

3. **review の実行設定は表からのみ、学習器は触れない。** 解決順は登録者の `review_tier`(task に1つ)> reviewer agent の `tier` >
   盤面既定。判定者が学習器に選ばれる輪をここで切り、判定者が一定であることが受理ラベルの一貫性になる。証拠に応じた深さの
   可変は先送り(レビュー費用が痛みとして観測されたら)。

4. **配分評価(Phase 2)は品質判定を固定した後、Board call で行う。** review session は成果物が受理可能かだけを判定し、モデル名・
   価格・routing を入力に持たない。盤面はその verdict + findings に実行設定・telemetry・Precedent の行動列(相談マーカー含む)を
   組み合わせ、盤面設定で Provider / ティアを固定した Board call に `allocation`(appropriate / underpowered / overpowered /
   uncertain)と `cause`(capability / task_ambiguity / environment / missing_information)を問う。出力は episode への**判断種別**の
   注釈で、観測と混ぜない。cause が無いと学習器は環境や情報不足の失敗を「モデルが弱い」と読み、overpowered は成功 episode からの
   唯一の下方向信号。

5. **meta-review は主題ごとに別 task。** 1つの周期(ADR 0083 決定9)が Behavior meta-review と routing meta-review を別々に登録する
   (主題ごとに未決着1本まで、積み上げない)。routing 側は shadow と実際の乖離・配分評価の分布・新セルの有無を読み、表の diff と
   Interview の提案を承認 question に出す。「同じモデルが評価した」かは Precedent から読め、禁じるのではなく偏りの手がかりにする。

6. **Interview は review type のルート task。** 発火は事象駆動(新セルの出現、meta-review / 人間の要求)で閾値は置かない。提案は
   escalation → 承認 question → 人間名義で登録(review type の登録は agent に開かれていない、ADR 0021)。その review task が probe +
   rubric を先に decision log に書き(機械 timestamp が「回答前に確定」の証拠)、候補セルごとに work type の子を使い捨てブランチで
   走らせ(PR 無し、ブランチは残す)、統合復帰後に agent / model を伏せた handoff を採点する。結果は子 episode に interview 種別の
   outcome として乗る。probe の著者は常に agent — 人間は発火の承認だけ。

## 退けた案

- **全 task(葉ごと)にレビュー** — 統合点で判断するのが最良という既存の線に反し、セッション数が倍になる。
- **Phase 2 を review session の第2段(tool call)で行う** — 観点の混在。固定入力に tools は要らず、Board call なら判定モデルを
  selector の外に置ける。
- **1つの meta-review に読み物を足す** — 主題が混ざると判断が鈍る。周期は1つのまま task を分ける。
- **Auditor を pin して全レビューを固定設定に** — `/implement-tidepool` の「review 強度を issue ごとに決める」が再現できない。
- **Interview の作問者と判定者を別 task に** — HTML の検討では「検討する」止まり。rubric の先行確定で偏りを抑え、task を増やさない。
- **不確実性の閾値で Interview を自動発火** — ADR 0083 決定9 の線。

## 追記(2026-09-13 の triage、issue #582)

決定4 の「overpowered は成功 episode からの唯一の下方向信号」の読み手は **routing meta-review(決定5)であり、学習器の推薦ではない**。
決定4 の「学習器」は routing の学習ループ全体(学習器 + meta-review)を指す。学習器(ADR 0110 決定4)は `overpowered` を受理率に
混ぜず、その episode は受理として数える —— 成果物は受理されたので、走ったセルは受理を得ている。

理由は2つ。`overpowered` は「走っていない安いセルでも同じ結果だった」という反実仮想で、セルは観測された具体 id(ADR 0110
決定4)なので未観測セルへ疑似観測を書くのは退けた案「一様事前分布」と同じ形になる。そして効かせる場所が無い —— 候補は要求
ティアの行だけ(ADR 0114 決定3)で、`quality` では安い行を上げると登録者の優先順位に背き、`cost` では価格が既に第1鍵である。
`overpowered` が指すのは「行の分類が誤り」ではなく「**要求ティアの申告が高すぎた**」なので、meta-review の提案先は agent.md の
既定 `tier`(registry diff)か登録者のティア申告(Behavior)になる。#549 の提案種別にその枠が無い点は派生 issue #583 に置く。

退けた案: **同ティアの安い行を `overpowered` で上げる**(上記)。**ティアをまたいで下げる** —— ADR 0114 退けた案「優先順位で
ティアを下回る」で既に却下(申告を濁す)。

## 追記2(2026-09-13 の triage、issue #583)

決定5 の routing meta-review の提案に **registry diff が1種増える: agent.md の既定 `tier` の引き下げ**。根拠は配分評価の `overpowered`
のうち `worker_spawned.source.tier = agent` の分 —— 床を決めたのが agent の既定ティアだった episode。ADR 0031 の「meta-review が
registry diff として蒸留する」と同じ形で、適用は表 diff の盤面適用(#549)ではなく authority の変更と同じ registry への diff
(承認 question 経由、#358 / ADR 0020 の正規経路)に乗る。読み物は `overpowered` を出所と agent で割る。

他の出所は**読み物のみ**: `task` は登録者の申告で、人間なら報告が答え、decompose の親 agent なら Behavior の領分だが入力が異議で
ない(ADR 0083 決定7)ので #584 の判断を待つ。`board` は既定 = `economy` で下げる先が無く、economy 内の安い行は表 diff か
`cost` 優先順位の領分。
