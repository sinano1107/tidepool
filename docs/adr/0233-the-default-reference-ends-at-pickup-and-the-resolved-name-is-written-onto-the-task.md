# 既定への参照は pickup で終わり、解決した名前をタスクに書く

2026-10-10 の grilling(issue #1728、#1738)で決定。workspace 未指定・assignee 未指定のタスクは、完了した後も着地のたびに
その時の既定へ解決されていた。既定を差し替えて再起動すると、無人 merge の tick は新しい既定の repo で同じ番号の PR の
CI を読んで merge しうる。ダイヤルも新しい既定 agent の profile から読む。旧既定の削除の扉と agent の着地待ちの数えも、
そのタスクを数えなくなる。再起動で中断したタスクの後始末は新しい既定の checkout で走り、無関係な workspace を quarantine
に落とす。retry は旧 workspace のタスクブランチから切り離される。再現と読み手の全件は #1728 に置く。

## 決定

1. **既定への参照は pickup で終わる。** 既定 workspace と既定 agent の両方に当てはまる。タスクブランチも PR も pickup で
   解決した workspace にしか無く、走ったのも解決した agent である。既定を差し替えて付いてくるのは、一度も pickup されて
   いないタスクだけである。retry などの再 pickup も、最初の pickup で解決した先に従う。
2. **pickup の瞬間に、解決した名前を `tasks.workspace` と `tasks.assignee` に書く。** 書くのは空の列だけで、指定済みの
   名前は書き換えない(ADR 0012)。着地・後始末・削除の扉・付帯子や子タスクへの写しは、列を読むだけで「走った先」を
   読む。issue-backed タスクの workspace を登録時に焼き込む先例(ADR 0016)と同じ形で、焼き込む時点が pickup になる。
3. **review の空の assignee は書かない。** これは既定 agent ではなく Auditor ポインタへの参照で、独立レビューであること
   を表す。review は着地を持たず、作業途中の内容も持たないので、同じ穴は無い。review の workspace は書く。
4. **既定から解決して書いた列と名前を、pickup の event に記録する。** 登録の event は assignee も workspace も記録しない
   ので、列を書けば「未指定で登録された」事実が消える。ADR 0012 が pickup の上書きを退けた理由(記録は何も消えない)は
   ここにも当たる。
5. **人間の編集で空に戻すことは許す。** 空に戻したタスクは既定への参照に戻り、次の pickup で解決し直される。既定へ
   付け替えるという明示の操作であって、既定の差し替えに黙って付いていくこととは違う。

## Considered options

- **着地の記録(PR を開いた時点)に書く** — PR を開く前の経路(local merge question、PR 昇格の retry)、後始末、付帯子
  の写しを覆わず、読み手ごとに分岐が要る。
- **assignee は event log の Executor を読み、workspace だけ列に書く** — workspace には Executor に当たる記録が無く、
  両者が揃わない。数えの SQL も event との join を要する。
- **path を pin する(ADR 0009 が退けた案)とは別物である。** 書くのは名前で、path は今も使うたびに registry から解決する
  ので、repo の移設には追従する。
