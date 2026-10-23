# meta-review の材料・shadow 行・提案の detail は、1つの定義の session の軸で組む —— 材料と shadow 行は全軸、detail は対象が固定する軸を落とす

2026-10-23 の triage / grilling(issue #2541、#2524 の triage で見つけた欠陥)で決定。routing meta-review の prompt は「段の説明が
workspace・書き手をまたいで違う仕事を引いているか、1 workspace / 1 書き手の癖か」を分けて提案せよと言う(ADR 0200 決定7)が、材料の
配分評価の組は (床の出所, 段, 走った agent, allocation, cause) で、workspace も書き手も無かった。人間は detail の組
(workspace, 文面の書き手 —— ADR 0302 決定2)でその軸を見られるが、提案を出す側は見えないまま出す。根は点の欠けではない:
配分評価の組の鍵は ADR 0111 追記2 の時点の唯一の読み手(`agent_tier`)に合わせて決まり、ADR 0200 決定7 が第2の判断を足したときも、
ADR 0302 が根拠の組の鍵を名指したときも、導き直されていない。同じ穴に `row` の判断の「行」もある(組に走った行の鍵が無く、同じ段で
同じ agent が2行を走ると分けられない)。材料・shadow 行・detail の照合は #2541 のコメントに置く。

## 決定

1. **session の軸は6つで、定義は1か所。** 床の出所(`source.tier`)・走った行・走った段・走った agent・workspace・文面の書き手
   (CONTEXT.md の Registrant、ADR 0197 決定2・4)。走った agent と文面の書き手は別物で、出所は「床を決めたのが誰か」である。
   学習器の「episode の文脈」(workspace と走った段、ADR 0210)は、このうち学習器が事前分布を層にする2軸を指す別の語で、変えない。
2. **材料の配分評価の組は、6軸すべて × (allocation, cause) で畳む。** 単位は窓の中に書かれた注釈のまま(ADR 0193)で、
   `judged_by_same_model` も残す(ADR 0150 決定8)。読み口 `list_allocations` を共有する routing meta-review・Interview の root・
   `routing_repair` が同じ組を読む。prompt の「出所と agent で分ける」は軸の名指しに変わり、「癖か定義か」の判断は求めたまま
   (ADR 0200 決定7 は変えない)。
3. **shadow 行は6軸すべてを運ぶ。** 行は走った行・出所・agent・workspace を既に運び、走った段と文面の書き手を足す。meta-review が
   根拠に引ける id を持つのは shadow 行だけなので、組の軸で見えた偏りを、同じ軸で session の id に戻せる。
4. **detail の組の鍵は、6軸から op の対象が固定する軸を落としたものである。** ADR 0302 決定2 の「session の文脈のうち対象が
   固定しないもの」の文脈をこの6軸に置き換え、同 ADR の表の鍵の列は手書きから導出に変わる(`row` は行と段を固定し、残り4軸で
   組む。`tier_description` は出所と段を固定する)。引用の外の1行は変わらない。学習器の昇格 / 降格の根拠は shadow 行のセルで
   session の軸ではなく、ADR 0181 追記 決定2 のまま導出の外に置く。

## 帰結

- 人間が見る detail の行は全 op で細かくなる(`row` は1鍵から4鍵)。引用の外の1行と件数の内訳は同じ。
- `list_allocations` と `list_routing_shadow` の行に欄が増え、同じ読み口を持つ Interview の root と `routing_repair` も同じ形を読む。
- 判断を prompt に足すとき、材料・shadow 行・detail の鍵は触らない —— 軸が足りなければ、足すのは定義の1か所である。

## 退けた案

- **材料の組に workspace と書き手だけ足す** —— `row` の判断の「行」が同じ穴に残り、判断を足すたびに prompt・材料の鍵・detail の
  鍵の3か所が別々に動く形が続く。
- **shadow 行に書き手と配分評価の cause を足し、配分評価を shadow 行から読ませる** —— shadow 行を配分評価の器の代用にする。
  一致した行は材料に注入されないので(ADR 0180)、集計を meta-review が手でやることになる。
- **prompt から「1 workspace / 1 書き手の癖は Behavior」の判断を外し、人間が detail でふるう** —— 引用は meta-review が依拠した
  判断で(ADR 0302 が退けた「盤面が母集団を丸ごと見せる」の理由)、軸の見えない引用はその退けた案の実質になる。
- **材料の単位を注釈から session にし、detail と同じ行を注入する** —— outcome と注釈は別の時に書かれ、どちらで窓に入るかの定義
  (ADR 0193)に触る。痛みが観測されてから。
