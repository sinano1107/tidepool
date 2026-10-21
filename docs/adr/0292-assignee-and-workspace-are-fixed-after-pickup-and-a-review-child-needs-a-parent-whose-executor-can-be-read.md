# pickup 済みの task の assignee / workspace は Edit で動かず、Executor の引けない親に review 子は付かない

2026-10-21 の grilling(issue #2369、兄弟 #2366 / #2362)で決定。ADR 0054 は Executor を event log の事実と定めつつ「`assignee` 列に
値があれば両者は一致する」として列を先に読み、ADR 0233 決定2 は列を「走った先」として読み手に読ませる。だが Edit(issue #130)は
実行済みの task が `todo` に戻った窓(escalate・decompose・queue 復帰)で列を書き換えられ、review の spawn が描いた Roster と、
後で同じ関数を今の値で呼ぶ読み手 —— live の免除と `list_agents` の `direct` 印、self RCA に注入する当時版、帰責 judge に渡す
当時版 —— が割れる。再現と読み手の全件は #2369 に置く。読み手を event log へ逃がす案(当初の本 ADR)でなく、列を動かす扉を
閉じる側を採った —— 列が pickup 後の固定の事実である、という ADR 0233 決定1 の線をそのまま守る形である。

## 決定

1. **pickup の event を持つ task の `assignee` と `workspace` は Edit で変えられない。空に戻すことも含む。** domain の `editTask` が
   拒む。ADR 0233 決定5「人間の編集で空に戻すことは許す」は一度も pickup されていない task に限られる(0233 に追記)。消費点は
   assignee も workspace も pickup で、Edit の「未消費フィールドを書き換える」(issue #130)の線に assignee を揃えた。これで
   ADR 0054 の「列に値があれば一致する」は門で保証される前提になり、Executor の読みは ADR 0054 のまま。#2362(workspace の同じ穴)は
   同じ門で消える。
2. **Executor が引けない親(`task_completed` も `task_picked_up` も無い)に、人間は review 子を登録できない。** domain の `registerTask` が
   人間名義(`HUMAN_WORKER_ID`)の登録を拒む —— WebUI・MCP の人間の扉と提案 question の approve はすべてここを通る。review は親の結果に
   付く付帯子(ADR 0049)で、結果の無い親には付く先が無い。決定1 だけでは、assignee 空の親の下に先に review を立てると pickup の fill
   (ADR 0233 決定2)で列が後から埋まり、spawn の Roster(空)と後の読み(1名)が割れる辺が残る。人間 assignee の task は pickup 無しで
   完了する(`task_completed` だけが残る)ので、述語は pickup でなく ADR 0054 の読みそのもの。将来のレビューの予約は Review flag / `review_by`。
   盤面自身の付帯子は門に掛けない。完了時レビュー・監査は実行の後に立つが、異議由来の auditor RCA は実行前の親にも立つ —— 一度も
   pickup されていない task への人間の decompose(`decision_logged` を人間名義で書く)に異議が出ると、triage は self RCA を飛ばして
   auditor RCA だけを登録する(`bundleObjections`)。この RCA には見る対象(人間の判断)があり、拒むと triage の commit ごと巻き戻る
   (実装時に `tests/triage.test.ts` の ADR 0237 のテストで判明し、当初の「扉を問わず」を改めた)。

## Considered options

- **Executor を列でなく event log だけから、review session の spawn の時点で区切って読む**(当初の決定) —— 読み手5経路に区切りを
  配り、adapter の描画と記録の順序も揃える必要があった。列を動かす扉が1つなら、閉じるほうが小さく、ADR 0233 決定2 の
  「読み手は列を読む」とも食い違わない。
- **spawn 記録に Executor の欄を写す** —— event log がすでに持つ事実の写し。
- **escalate で止まった task を別 agent に手渡す操作を Edit に残す** —— 今の UX はその運用を想定しておらず、cancel + 再登録が
  今の手。task ブランチの続きが切れる不便は別の経路(派生 issue)で開く。pickup 後に `human` へ手渡す Edit も同じ門で止まり、
  人間が引き取る手は cancel になる。
- **実行前の review 子を許し、Roster 空・免除無しで走らせる** —— 見るものの無い review に slot と課金を使う。
- **門を扉を問わず掛け、Executor の引けない親では triage が auditor RCA を飛ばす** —— 人間の判断への異議から RCA が消える。
  飛ばした事実を記録しても、見る対象のある review を落とすことに変わりはない。

## 帰結

- 当時版の Authority / Roster は spawn と同じ type の分岐で描く線(ADR 0020 part 4 / #1741 追記、ADR 0272 追記3、ADR 0291 決定2)は
  そのまま。#2366(修理子の self RCA に profile と roster を描く)はその線の code の写し漏れで、分岐の共有で消える。
- ADR 0054 のテストのうち「pickup 後に assignee を空に戻して別 worker に再 pickup させる」手順は門で不可能になり、「pickup 後の
  空戻しは拒まれる」に置き換わる。「最後の pickup が Executor」の順序が意味を持つのは、列を書かない review type の親(ADR 0233
  決定3)だけになる。
- **範囲外**: review type の親が escalate で `todo` に戻り、その間に Auditor の既定が差し替わって再 pickup されると Executor が
  session をまたいで変わり、その review への RCA の Roster がずれうる(派生 issue)。異議された task の修理子の宛先(#2371)は列が
  動かなくなったので問いが消える。
- **範囲外**: 盤面が実行前の親の下に立てる auditor RCA(決定2 の門の外)では、spawn の Roster(列が空なら空)と、親の pickup の fill や
  pickup 前の Edit の後の読みが割れる —— 決定2 が人間の扉で塞いだのと同じ辺(#2374)。
