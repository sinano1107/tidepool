# routing の提案は前提を pin して人間の編集に道を譲り、学習器の降格は人間が直接、昇格は question だけで行う

2026-09-23 の grilling(issue #549)で決定。`/implement-tidepool 549` が seam の合意で止め、4つの問い(根拠 cell と
レバー tier の型違い / 昇格後に降格の根拠が消える / 表 diff と人間の編集の競合 / 下げ先に行が無い表)を grilling へ
戻した。ADR 0110 決定4・ADR 0111 決定5・追記2・ADR 0120 決定3・4 を前提に、routing の提案の適用先ごとの形を決める。
既存実装の調査と `file:line`、実装判断(材料 event・verb の形・読み物の定義)は issue #549 のコメントに置く。

## 決定

1. **routing の提案は前提を pin し、pin が崩れたら盤面が question を observed で決着させる(ADR 0120 決定4 と同型)。**
   pin は提案が実際に依拠したものだけ: 表の行の提案はその1行の全欄、昇格 / 降格の提案はフラグの現在値、agent の
   tier の提案は **(agent 名, tier の値)** と**根拠の episode が走った行**。registry の commit hash や「ティア T の行全部」を
   pin にすると、無関係な agent の編集や T への行の追加で他の提案が巻き添えで消える。表と設定の変更は
   `execution_settings_changed` の1点で観測できるので hook を置き、registry には変更の event が無いので approve 時
   (書き込み前の fetch の直後)と次の due 判定時の2点で照合する —— event を新設しない。「根拠は cell、レバーは tier」の
   型違いは、pin が有効な間は「T を実体化した行 X が過剰 ⇒ T の宣言が過剰」の推論が健全なので、pin の有効期間の外に
   しか当たらない。

2. **修正は question の中で行う: approve に種別ごとの修正値を添えられる。** 表の行は `tier` / `effort`、agent の tier は
   `tier`、Interview は purpose、昇格 / 降格は修正無し。適用は提案に修正値を重ねた値、pin の照合は元の前提のまま、
   下げ先に行があるかの検査は修正後の値で回答時に再実行し、無ければ回答ごと拒否する。修正つき approve は推奨受理率で
   推奨どおりに数えない。question の外での直接編集(settings タブ / 管理MCP / agent 編集)は決定1 の pin で提案を退ける
   ので、人間は question を答えずに直せる。意見だけなら reject にコメントを添え、meta-review は過去の提案と回答・修正値を
   読める。退けた提案の実体(candidate 相当)は作らず、同じ提案を機械で塞がない —— 人間の reject は「今は違う」で、根拠は
   増え続ける。

3. **昇格後は shadow の役割が反転し、降格の読み物は「表と分かれた episode の outcome」になる。** 昇格後の pickup では
   学習器の推薦が走り、shadow 行には「表ならこう選んだ」が残る(列は増えない、意味が反転する)。`worker_spawned.source.provider`
   に `learner` が1値増える。分かれなかった episode は表と同じなので情報が無く、それで正しい —— 昇格前の読み物も対称に
   「表が走った episode のうち学習器が別を推薦したもの」である。

4. **降格は人間が settings タブ / 管理MCP から直接できる。昇格は routing meta-review の提案 + 承認 question だけ。**
   ADR 0110 決定4 が縛るのは昇格で、信頼の過程は上り方向にだけ要る。学習器が誤配している週に meta-review の周期を
   待たせない。フラグは盤面設定の1列で盤面全体に1つ。

5. **agent の tier を下げる提案は、承認で盤面が registry のリモート main へ直接 commit する。** 承認回答は ADR 0020 の
   「WebUI 操作 = 人間の明示行為」と同じ位置にあり、tier の欄を1つ付け替える機械的な編集に registry-edit タスク → PR →
   merge の agent 発の経路は要らない。push は DB transaction の外なので、失敗は回答ごと拒否する(WebUI 編集の失敗と同型)。
   提案は1段だけ下げ(`overpowered` は幅を言わない)、下げ先に行が無い提案は verb が拒む(実装判断は #549 のコメント)。

6. **Interview の提案は `question_proposal` の種別で、approve が人間名義の root review を登録する。** ADR 0111 決定6 の
   「escalation → 承認 question」は pending child が work 固定・親の子固定なので Interview の root review に使えず、
   ADR 0120 の付帯子 question(親を塞がない)に揃える(ADR 0111 決定6 への追記)。Interview の走り方(#550)が入る前に
   この種別を開くと「走り方を知らない review task」が立つので、種別は #550 の後に開く。

7. **周期 meta-review は両主題とも `review_tier = frontier` で登録する。** memory の meta-review は盤面既定の economy で
   走っていた。判断で繰り返しを見る task が経済で走る理由は無く、週1 session の費用は小さい。

8. **`allocation_reviewed` は Board call 自身の実行設定(judge)を持つ。** ADR 0111 決定5 の「同じモデルが評価したかは
   Precedent から読める」は成り立っていなかった(event に judge が無い)。読み物は worker の cell と judge の model の一致。
   Board call が盤面設定でなくコード固定である発見は派生 issue。

## 退けた案

- **人間の修正は直接扉に任せ、question は approve / reject のみ** —— 3画面またぐ UX で、修正できる欄は enum か短い文字列
  だけなので検証の負担は無い(決定2)。
- **退けた提案の表を持ち、同内容の提案 verb を DomainError にする** —— 再提案の条件を機械で決めることになり、閾値を
  持たない線(ADR 0083 決定9)に反する。
- **registry 変更の event を新設して stale の hook にする** —— 照合点2つで足り、最長でも次周期で片づく(決定1)。
- **昇格 / 降格とも question のみ、または両方とも直接可** —— 決定4。
- **pending child を review root に拡張する** —— decompose の扉を触る(決定6)。
- **表の行の提案で行の追加・削除・価格も動かす** —— meta-review が根拠を持てるのは分類と effort だけ。追加は Interview と
  人間、削除と価格は人間。
- **agent の tier を任意の下位ティアへ下げる提案** —— 決定5。人間は修正値で複数段下げられる(決定2)。
