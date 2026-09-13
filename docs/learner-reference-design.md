# 学習器(shadow)の参照設計

spec #541「学習器(shadow)」/ ADR 0110 決定4 / issue #548 の実装が置いた統計モデルの記述。
コードは `src/learner.ts`、用語は CONTEXT.md「学習器」「実行設定」「要求」「Selector」「帰責」「配分評価」。
この文書は「なぜこの式か」を持ち、コードは「何をするか」だけを持つ。

## 位置

学習器は selector の**候補**として shadow で走る。work task の pickup ごとに、除外を当てた後の候補
(selector が並べたもの)から「自分ならこう選ぶ」を1つ引き、selector が実際に選んだ設定と並べて
`learner_shadow` に1行残す。選択には介入しない —— 学習器が倒れても pickup は進む(scheduler の
try/catch)。review task では学習器を参照しない(ADR 0111 決定3)。昇格フラグ・設定面・meta-review
はこの実装の外(spec #541 の後続)。

## セル

セルは観測された具体の `(provider, model, effort, advisor)`。

- `model` は `worker_exited.usage.models` の鍵のうち spawn の pin(表の綴り)に当たるものが
  **ちょうど1つ**ならその具体 id、そうでなければ pin の綴り。alias 行(`fable`)は世代が進むと
  `claude-fable-5` → `claude-fable-5-1` のように別セルになり、どちらも表の同じ行に当たる。
- `advisor` は spawn 時の **pin**(`worker_spawned.advisor`)。相談回数(`usage.advisor.consultations`)
  は読まない —— 「pin あり・相談0回」を advisor 無しのセルに合流させると両セルの受理率が歪む
  (ADR 0110 退けた案、AC4)。`usage.models` の内訳から advisor を推定しない(events.ts の注記)。
- セルと表の候補行の照合は `windowMatchesModel(候補の綴り, 観測された id)` —— 除外の照合と同じ
  1つの式(issue #544)。advisor も pin どうしを同じ式で照合する。

文脈のうちセルを割るのは **workspace** だけ(プーリングの段)。要求ティアは候補集合を既に絞って
いる(ティアは床、ADR 0114 決定3)。agent / 優先順位 / interview 種別は episode の記録として運ぶが
セルを割らない(interview 種別は今は常に null)。

## outcome

1 worker session = 1 episode。`outcome` は3値:

| 値 | 条件 |
| --- | --- |
| `rejected` | その session の窓の中のエントリに `capability` の帰責(最新の `objection_attributed`)がある、または その session を指す `allocation_reviewed` が `underpowered` × `capability` |
| `accepted` | task が受理されている(統合点レビューがすべて完了 —— `acceptedSql`、ADR 0111 決定1)かつ task の**最後の** session |
| `excluded` | それ以外(レビュー保留 / 判定なし / 帰責が `preference` `requirement_change` `environment` `task_ambiguity` `missing_information` `uncertain` の異議のみ) |

- 負は受理より強い: 受理された task に capability の異議が残っていれば `rejected`。
- 受理は task の派生なので task の最後の session にだけ付く。前の session(retry / decompose の統合復帰
  / quarantine 復帰の前)は、自分の窓の中の負の信号でしか数えない。窓は Precedent と同じ規則
  (spawn より後、exit または次の spawn より前)。
- `acceptedSql` の 0 は失敗ではない(保留を含む)—— だから `excluded` が要る。
- ADR 0115 決定5: 帰責が worker の落ち度でない異議は負の信号に数えない。配分評価の cause で環境要因
  を除くのと同じ機構。
- 費用 = `worker_exited.usage.estimated_cost_usd`(session 合計、advisor の帰属は要らない。codex は null)。
  時間 = `worker_exited.created_at − worker_spawned.created_at`。どちらも観測された平均として運ぶ。

## 事前分布と事後分布(Beta-Bernoulli)

候補行 1つの受理率を Beta-Bernoulli で持つ。

- **事前分布 = 表の行 = 受理1件分の疑似観測**(α₀ = 1, β₀ = 0)。行が表にあることは「その model は
  そのティアの品質を満たす」という分類(ADR 0114 決定2)なので、受理1件として読む。重みは固定慣習で
  設定に出さない(ADR 0110 決定4)。表の価格列から費用の事前分布は作らない —— USD/MTok は session
  の USD ではない。
- 事後平均 = (1 + A) / (1 + A + R)。A / R はその候補行に当たる全セルの `accepted` / `rejected` の和。
- この事前分布の性質: データが無ければ全行が 1.0 で同点 → selector の並びのまま(AC1)。受理1件では
  1.0 のままなので、順位が上のデータ無しの行を追い越さない —— 「少データでも表より悪くならない」
  (ADR 0110 決定4、退けた案「一様事前分布」)。不受理1件で 0.5 に落ちる。表に反する観測が積もれば
  追い越す(1勝1敗の 2/3 に対し 3勝0敗は 1.0)。

## 階層プーリング

盤面全体の事後分布が各 workspace の事前分布。実装は

    α_ws = α₀ + A_board + A_ws,   β_ws = β₀ + R_board + R_ws

で、`A_board` は全 workspace の和(この workspace を含む)。つまりこの workspace 自身の観測は盤面の段と
workspace の段で **2度**数えられ、他所の観測の 2倍の重みを持つ。これが workspace の段が効く機構その
もので、盤面の和からこの workspace を引く(leave-one-out)と等重みで workspace の段が消える。
観測の無い workspace は盤面の事後分布に従う。task の `workspace` が null(盤面既定)はそれ自身を1つの
pool として扱う。

## 推薦

1. 候補(除外を当てた後、selector の並び)ごとに事後平均を出す。比較は整数の交差乗算
   (`(1+A_a)(1+A_b+R_b)` vs `(1+A_b)(1+A_a+R_a)`)で、浮動小数の同点で決定論が崩れない。
2. 事後平均の降順。同点は selector の並びのまま。
3. task の優先順位が `cost` のときだけ、同点の間で観測された session 費用の平均(小さい順)が鍵になる。
   **両方に観測があるときに限る**。`quality` では Provider 順位が selector の並びに既に入っている
   ので費用は読まない。
4. `source` は `data`(候補のどれかに数えた episode が1件以上ある)か `prior`(表そのまま)。

**乱数は持たない**。spec の「乱数は seed 注入で決定論に」は Thompson sampling を採る場合の条件で、
事後平均で並べる限り seed は要らない(AC2)。Thompson sampling に切り替えるなら seed を入力に足す。

## shadow 行

`learner_shadow (id, task_id, cell_recommended, cell_actual, source, created_at)`。セルは
`{provider, model, effort, advisor}` の JSON(実行設定の形 —— pickup 時点では具体 id は未観測なので
表の綴り)。spawn 前に書くので `worker_spawned` の id は持たず、task_id と時刻で session に並ぶ。
読み手は routing meta-review(spec #541、未実装)。

## 触らない線

- 選択(`firstSelectable`)は動かない。学習器は同じ候補列の**別の並べ方**を記録するだけ。
- review task の実行設定は表のみ(ADR 0111 決定3)。
- 昇格の閾値は置かない —— 昇格は meta-review の判断 + 承認 question(ADR 0110 決定4)。
