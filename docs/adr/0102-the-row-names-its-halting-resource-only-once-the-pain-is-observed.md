# 資源単位の停止を行が名指す形は決め、足すのは痛みが観測されてから

2026-08-25 の grilling(issue #398)で決定。`listQueue` は資源単位の停止を1本の SQL CASE で `skipped` の一語に
潰しており、原因(workspace / agent 名 / provider 認証の quarantine と fable 線)は読み口に届く前に消えている。
Design System の `QueueItem` には `skipReason` の口が先にあり、盤面側が一度も埋めていない。**ADR 0068 決定4 は
「行単位の理由文言は当面付けない(痛みが観測されたら足す)」と既に決めており、この ADR はその条件がまだ発動して
いないことを確認したうえで、発動したときに取る形だけを先に決める。** 現況の調査・行幅の実測・`file:line` は
issue #398 に置く。

## 決定

1. **今は足さない。** 決定4 の条件「痛みが観測されたら」はまだ満たされていない。資源単位の `skipped` がブラウザに
   出るようになったのは 2026-08-12(#316)で、その後に起きた実際の quarantine(#466 の provider 認証、#468 の
   workspace)は**どちらもログと DB で診断されており、キュー行を見て原因を当てにいった記録は無い**。決定4 の前提
   「quarantine には修理 question がある」も今日なお真で、workspace 1つ・agent 数体の盤面では question と行の
   対応は自明。前提が崩れるのは workspace や provider が複数並び、skipped 行が同時に数行出るようになってから。
2. **発動の条件は「行を見て原因を当てにいった」実例が1件記録されること。** 起票の存在は観測ではない —— #398 の
   本文は予測であって発生の記録ではなく、それを観測の代わりに扱わない。
3. **発動したとき、行が名指すのは原因の種類まで。** 今日の列挙は4つ —— workspace quarantine(ADR 0012 / issue
   #26)、agent 名 quarantine(ADR 0012 / issue #36)、provider 認証 quarantine(ADR 0097 決定2、非 Anthropic のみ。
   Anthropic の失効は盤面全体の halt へ行く)、fable 線(ADR 0030)。**盤面全体の停止は行に降りない**(決定4 の
   本体は無傷 —— envelope の `halts` が1回答える)。
4. **fable 線も行が名指す。** 決定4 は「fable 線にはスロット行の表示が既にある」を理由に挙げたが、スロット行が
   言うのは「fable が詰まっている」という面の事実であって「**この行が** fable か」ではない。assignee → model の
   解決は registry を知っている人間の頭の中にしかなく、混在キューでは行から判らない。答えている問いが違うので
   重複ではない。
5. **読み口が返すのはタグであって表示文字列ではない。** 行は原因のタグ(`workspace` / `agent` / `provider_auth` /
   `fable`)を持ち、文言は画面が盤面全体の停止の文言マップと同型の並びで与える。サーバが UI コピーを持つ形は
   採らない —— 表示時翻訳は Board call の役であり、DS の `QueueItem` は文言を知らない部品(`skipReason` が文字列
   prop なのはそのため)。
6. **`skipped` と原因は SQL の同じ1本の式から出す。** status 側を「理由式が非 NULL なら `skipped`」と書き、条件式の
   写しを2本作らない。CASE の並びがそのまま優先順位になる。
7. **複数の原因が同時に成立する行は1つだけ名指す。** 順序は人間が手を出せるもの優先 —— workspace → agent →
   provider 認証 → fable 線。どれを直しても他が残る以上、行の役目は「今すぐ直せる1つ」を出すこと。
8. **原因の集合は pickup 述語と同じ1つの式から出す。** `pickupExcludedAssignees` は fable 線と provider 認証を平坦に
   連結して原因を消しているので、返り値を原因別に割り、平坦化は述語へ渡すヘルパーに閉じる。述語と表示を乖離させない
   線(`listQueue` / `/api/queue` のコメントが持つ)は無傷。
9. **資源名は行に出さない。** `skipped · workspace · ops-repo` の形は可変長で行幅の天井を破り、資源名は行の
   assignee chip と修理 question が既に持つ。375px の行に残るのは ~170px しかない(#396 と同じ罠)。
10. **原因の追加は列挙1行。** ADR 0068 決定5 と同じ作法で、5つ目(#453 が資源単位へ落とす Harness 単位の
    containment)は CASE に1行と文言マップに1行で足りる形にする。

## Considered options

- **起票済みであることを観測として扱い、今実装する** —— 決定4 の条件を満たしたことにする形。取らない。設計の答えが
  出ていることと、足すべき時が来たことは別。
- **status の値を `skipped:workspace` 等に割る** —— `BoardTask['status']` の union が膨らみ、`status === 'skipped'` を
  見ている既存の読み手が全部壊れる。
- **UI が原因を再計算する** —— 述語の写しが2本になる。ADR 0068 決定6 がブラウザ側の再導出を廃したのと逆向き。
- **取るべき手で括る**(`answer its question` / `waiting on fable line`)—— quarantine 3種が同じ手に潰れ、どの資源の
  question かが行から消える。
- **#396 と同じ2段化で理由を全文出す** —— キューは何十行も並ぶので全行が2段になる代償が slot 行より大きい。短い
  タグが 375px で1行に収まる限り払わない。収まらないと実測で分かればこちらへ倒す。
