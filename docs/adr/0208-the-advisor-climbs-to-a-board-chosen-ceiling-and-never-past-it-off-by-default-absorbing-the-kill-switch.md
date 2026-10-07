# advisor は盤面設定の上限まで登り、上限を超えない —— 既定は off で、kill switch はその値に吸収する

2026-10-07 の grilling(issue #1538)で決定。ADR 0200 決定6 の advisor は、真偽値のフラグで「main と同一」か「Provider の
最上位の系列」かの2択だった。運用者自身が Fable の週次の枠が減ると Opus に切り替えていること、Fable の使用量を usage
credits に請求するプランがあること(Claude Code の文書。どのプランかは書かれていない)から、その間を選ぶ値が要った。
文書の照合・導出の表は #1538 のコメントに置く。ADR 0200 決定6 のフラグと、ADR 0043 の kill switch を置き換える。

## 決定

1. **advisor の上限は盤面設定の選択で、値は `off` / `sonnet` / `opus` / `fable` / `fable`(Fable の窓が throttled なら
   `opus`)。種の既定は `off`。** advisor は CLI の上で experimental な機能で、agent.md の opt-in(ADR 0094)に加えて盤面
   でも明示して有効にする。値の綴りは anthropic の系列名である —— 相談機構を持つ Provider は anthropic だけ(ADR 0097
   決定3)。上限は agent に持たせない(agent は計算資源を持たない —— ADR 0110)。
2. **上限は文字どおりの上限である。** 上限より下の系列の main には上限の alias、上限と同じ系列の main には main と同一の
   具体 id、上限より上の main には advisor を付けない。Fable の main は Fable の advisor しか受けないので、上限 `opus` で
   Fable の行は advisor 無しで走る。上限より上を main と同一に倒すと、Fable を避けるために選んだ上限が Fable の相談を足す。
3. **`off` は selector が見る。** advisor を有効にした entry を advisor の無い entry として選ぶので、advisor を理由にした
   候補の除外(ADR 0200 追記の Haiku、決定5 の窓)は起きない。ホストの env の kill switch は退役する —— 選択の後に
   advisor を剥がしていたので除外が残り、運用者向けの文書にも無く、切り替えに再起動が要った。「agent.md を1枚も触らず
   に全 worker を止める」(ADR 0043)は `off` が満たす。
4. **adapter は系列ごとに「上限の alias が main として受ける世代の上限」を持つ。** CLI の版は固定されている(ADR 0186)
   ので、alias の解決先は tidepool の release ごとに決まる閉じた事実である。系列の順は世代をまたいで交差する(Opus 4.7
   の main は Sonnet 5.5 を受け、Sonnet 5.5 の main は Opus 5 以上を要る)ので、「最上位だけ」では足りない。上限が
   `fable` でも同じで、adapter が知らない新しい世代の main(Opus を含む)は、上限の alias でなく main と同一に落とす
   (付く advisor)—— ADR 0200 決定6 が置いた「最上位の alias はどの main より上」も、release ごとの事実として扱う。その系列が advisor になれない
   なら行は候補から外れる(ADR 0200 追記と同じ)。版上げの門で文書の組み合わせ表と照らす(ADR 0187 と同じ場所)。
5. **上限が `fable` のとき、Throttle のゲートは advisor の窓も見る。** Fable の advisor は Fable の週次の枠を消費し、枠が
   切れると相談は使えなくなる(運用者の観測。API の文書も、advisor の rate limit は advisor model の per-model の枠を
   共有するとしている)。連動の無い `fable` は main の Fable の行と同じく窓が戻るまで待ち、連動のある値は `opus` に下げる
   —— pace line は運用者が決めた Fable の使い方で、main だけが止まり advisor が素通りする食い違いを残さない。
6. **実行設定の出所に advisor を足す。** 値は `off` / 上限どおり / 窓で下げた / 知らない世代 / main が上限より上。pin の
   綴り(`opus` や main の id)だけでは、上限から下がった理由を記録から区別できない。
7. **agent の作成・編集画面の advisor の欄に、盤面の上限の現在値を出す。** 既定が `off` なので、チェックしても効かない
   理由を画面で見せる。

## 帰結

- ADR 0200 決定6 の「要るのは最上位だけ」は前提ごと改まり、adapter は系列ごとの事実を1つ増やす。ADR 0042 の「alias の
  解決先はホストの版で動く」は ADR 0186 の固定で当たらなくなっていた。ADR 0044 決定4 の「有効・無効の正本は registry と
  kill switch」は「registry と盤面設定の `off`」になる。
- 種の盤面では、advisor を有効にした agent も、運用者が上限を選ぶまで advisor 無しで走る。
- 新しい Haiku / Sonnet / Opus の世代を表に足すと、release が adapter を直すまで main と同一(Haiku なら候補外)になる。

## 退けた案

- **上限を固定で選ぶだけ / 窓の連動だけ** —— 窓が減ったときに切り替える運用者と、Fable をいつも避ける運用者の両方が
  いる。上限と連動を2つの設定に分けると、`opus` に連動のような意味の無い組が作れる。
- **`main`(全行を main と同一)の値** —— `sonnet` との違いは Haiku の行が外れることだけで、安全な既定の役目は `off` に
  移った。
- **main と同一になる場合は advisor を付けない** —— 同一モデルの advisor の効果は測られていないが(Anthropic の測定は
  すべて advisor が強い組)、外せば agent.md の宣言の意味が変わる。**1つ上の系列だけを付ける値** —— 効果は main との
  差から来るので、差を縮める値が得かは測られていない。どちらも #1541 で測る。
- **Fable 以外の窓(session / week)で Sonnet や advisor 無しへ落とす** —— Opus と Sonnet に固有の窓は無く、session /
  week が throttled なら main も止まるので、いまの線では発火しない。新しい線が要り、#1540 に分けた。
- **kill switch の env を残し、盤面設定より優先する** —— 決定3。
