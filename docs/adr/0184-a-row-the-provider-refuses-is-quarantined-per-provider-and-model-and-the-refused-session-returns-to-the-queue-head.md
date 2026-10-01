# Provider が断った行は provider と model の組で Quarantine され、断られた session は queue の先頭へ戻る

2026-10-01 の triage / grilling(issue #1249)で決定。表の行は具体 id だけになったので(ADR 0182)、Provider がその id を
断ると行は走れなくなる。断られた session は「報告なき exit」(ADR 0145)に落ち、retry は同じ行でまた落ち、question は行を
名指さず、その行を使う task の数だけ立っていた。学習器はその行を未観測のまま離れない(ADR 0181)。実測と現状の読みは #1249 の
コメントに置く。

## 決定

1. **主語は「退役」ではなく「この盤面で走れない行」である。** 盤面が観測できるのは、この CLI の版とこのアカウントで Provider が
   その id を断った、までである。退役・アカウントの権限・CLI の版の古さを、どちらの CLI も区別して返さない。文面は原因を
   断言しない。
2. **走れない行は Quarantine の資源で、鍵は (provider, model) である。** 行は pickup の除外に入り、advisor の導出からも外れ、
   行を名指す確認 question が1枚立つ。黙った除外にしないのは、走れない行が時間で直らず、同じティアに別の候補がある限り
   誰も気づかないからである。全候補が外れた task は既存の skipped で表示する。
3. **証拠は Provider ごとに、構造化されたものだけを使う。** Claude CLI を喋る Provider は spawn 後の result envelope の 404
   (401 / 429 と同じ形の述語で、spawn 時の Provider に帰属)。Codex は spawn 後の証拠が文言しか無いので、app-server の
   model 一覧を pickup 前に読み、openai を観測するたびに表の openai の行すべてを照合する —— 選ばれていない行も、一覧に
   無ければその時点で Quarantine される。一覧が読めないときは Quarantine を立てず、使用量の観測不能と同じ provider 全体の
   fail-closed に倒す。
4. **404 で断られた session は失敗ではない(行の拒否)。** 1ターンも走っておらず、retry か abandon かの判断が存在しないので、
   failure question を立てずに task を `todo` の先頭へ戻す。行は決定2 で外れているので、次の pickup は別の候補で走る。
   記録は専用の event で残し、上限到達による中断の event は流用しない。
5. **解除の門は2つある。** 表の編集でその (provider, model) の行が無くなれば、question は回答なしで決着する —— 多くの修復は
   行の差し替えで、済ませた人間に意味の無い回答を求めない。行を残す修復(CLI の更新、アカウントの回復)は回答で、盤面は
   受理の前に検査し直す: Codex は一覧の読み直し、Claude はその id で最小の1ターン。
6. **question は表の修正を先頭に促し、settings タブを開く導線を持つ。settings タブの表は Quarantine 中の行に印を出す。**
   question に「行を消す」選択肢は足さない —— 差し替えは settings タブの入力でしかできず、扉が2つになる。

## 帰結

- ADR 0182 決定2「世代を検知する機構は足さない」とは別の機構である。あちらは alias の指す先の推定で、こちらは Provider が
  断ったという観測である。
- 学習器は変えない。行の拒否で落ちた session は既存の規則で受理率の分母に入らない(ADR 0115 決定5)。
- Codex の spawn 後の 400 と、advisor として断られた id(stderr の文だけ)は構造化された証拠が無く、「報告なき exit」のまま残る(Codex の理由が failure question に載らない件は #1256)。
- pin した Codex の版が実行できない種の行(#696)は、この機構で Quarantine として名指される。

## 退けた案

- **人間が表を直すまで行を残す** —— 冒頭の現状そのもの。
- **Codex の `turn.failed` の文言で判定する** —— 別原因の 400 と status も type も同じで、部分文字列から推測しない線(ADR 0104 決定2)を破る。
- **Codex は判定しない** —— 同じ痛みが openai にだけ残る。
- **行を書く扉で検査する** —— Claude は1ターン走らせないと確かめられず、Codex は次の観測で全行が照合される。
- **回答を検査せずに信じる** —— 直っていない回答のたびに task が先頭復帰を1往復する。
