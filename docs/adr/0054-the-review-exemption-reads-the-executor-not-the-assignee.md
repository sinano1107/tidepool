# レビューの免除が問うのは Assignee ではなく Executor である

issue #217 で決定。ADR 0013 の免除 —— レビューの修理子は被レビュータスクの実行者を常に名指してよい
(「that's part of what a review *is*」)—— の実装(`reviewedTaskAssignee`、`src/tasks.ts:1576`)は、
親タスクの `assignee` **列を素で**読んでいた。ADR 0011 により未指定の assignee は「その時の盤面の
既定エージェントへの参照」であって不在ではないため、assignee を空欄で登録したタスクのレビューでは
免除が `undefined` に落ち、**同じ tako が実行した2本のタスクが、人間が assignee 欄に打ったか空欄に
したかだけで decompose の挙動を変える**。

重大度は「免除が効かないと不便」ではない。`attributedAuthority`(`src/mcp.ts:259`)は review タスクに
対して常に `REVIEWER_AUTHORITY_PROFILE` を返し、その `assignable_to` は `[]`(`src/mcp.ts:217`)。
ADR 0013 の設計どおり task type が profile を上書きするため、**review の decompose で assignee を
名指せる道はこの免除ただ1本**であり、registry 側では緩められない。免除が落ちたレビューは指摘の数だけ
人間承認 question を積む。

## 決定

**免除は `assignee` を読まない。event log が持つ歴史的事実を読む。**

被レビュータスクの **executor** は次の順で解決する:

1. そのタスクの `task_completed` を書いた worker
2. 無ければ、そのタスクを**最後に** `task_picked_up` した worker

`assignee` 列に値があるときはその値をそのまま返す(従来どおり)—— 列が埋まっているタスクの
executor は、盤面がその値として走らせた者であり、両者は一致する。event を引くのは**列が NULL の
ときだけ**である。

用語として **Executor(実行者)** を Assignee の隣に立てる(CONTEXT.md)。関数も
`reviewedTaskExecutor` に改名する —— 名前が概念とずれていたことが、この不具合を書きやすくした。

## 根拠

**1. Assignee と Executor は別の概念であり、免除が問うているのは後者である。**
Assignee は**前を向いた**値 —— 「誰が実行することになるか」であり、未指定はその時の盤面のポインタへの
生きた参照(ADR 0011)。Executor は**後ろを向いた**値 —— 「誰が実行したか」であり、event log が持つ
確定値。列が設定されているとき両者が一致するので、同じものに見えていた。免除の文言は "the reviewed
task's own **executor**" であって "assignee" ではない。

**2. 生きたポインタを読むと免除の正当化が壊れる。** 被レビュータスクの実行後に既定エージェント
ポインタを差し替えた盤面では、現在のポインタは当時の実行者ではない。ポインタ読みの免除は、その
タスクに**一度も触れていないエージェント**へ修理を振ることを許してしまう。免除が正当化されるのは
「レビューとは対象を実行した者に直させるものだ」という一点であり、その一点が成り立たない相手に
広げれば、それはもう免除ではなく `assignable_to` の空洞化である。

**3. CONTEXT.md は既にこの語彙を持っていた。** Review の節に「当事者レビューの『self』は歴史的
事実 —— 異議されたログエントリを実際に書いた worker —— であり、ポインタへの参照ではなく確定値」と
ある。これは Executor の定義そのものだが、Review の節に埋まっていて Assignee の隣に立っていなかった。
ADR 0020(当事者レビューに**当時版**の agent 定義を注入する)も同じ筋 —— 盤面は既に「実行の事実は
歴史から引く」を採っている。免除だけがそこから外れていた。

## 全域性

この2段解決は**全域**である。`reviewedTaskExecutor` が呼ばれるのは、親を持つ review タスクの
decompose 時に限られる。親を持つ review の入口は2つ:

- **完了時レビュー**(`completeTask` の中で登録される、`src/tasks.ts:740`)—— 親は必ず `task_completed` を持つ。
- **異議由来の RCA review**(`bundleObjections`、`src/triage.ts:195`)—— objection の対象になれる
  log entry は `decision_logged | task_completed` の2種だけ(`src/triage.ts:114`)。`decision_logged` は
  worker session が書くものなので、その親は必ず pickup されている。

したがって「どちらも無い」は起こらず、免除が黙って落ちる穴はない。ルート review(親なし)は
従来どおり `undefined` —— 独立監査に被レビュータスクは存在しない。

`task_completed.worker_id` が `human` になることもない。人間が完了を書ける経路は2本
(`src/api.ts:1125`、`src/management-mcp.ts:470`)で、どちらも `assignee === 'human'` でなければ
409 で弾く。つまり human 完了のタスクは列に `'human'` が明示されており、event を引く経路に来ない。

## 到達する状態は3つとも実在する

RCA review の親は完了しているとは限らない。CONTEXT.md の Objection(ADR 0049)が
「**走行中タスクへの異議もその完了を塞がない**」と定めているため、review が decompose する時点の
親の状態は **done / todo / cancelled** の3つを踏む。todo と cancelled では `task_completed` が無く、
2段目の `task_picked_up` が引かれる —— これは辺縁ではなく、異議が付くのは判断が怪しいタスクであり、
そういうタスクほど escalate も abandon もする。

## Considered options

- **現在の既定エージェントポインタへ解決する(生きたポインタ読み)** —— SQL 一発で済み、
  `typeAwareDefaultAgentSql` を足すだけで直る。根拠2で却下。
- **最後の `task_picked_up` を第一の出所にする** —— 「実行した」の最も素朴な読み。しかし
  レビューされているのは**成果物**であり、それを完了として提出した者が免除の相手として正しい。
  加えて完了時レビューは `completeTask` の中で生成されるので、レビューの生成と帰属の出所が同じ
  瞬間になる。両者が食い違うのは親が未完了のときだけであり、そこでは 2段目として採る。
- **全 pickup の worker の集合(いずれかなら免除)** —— 一度触って escalate しただけの worker まで
  後発のレビューが修理先に指名できてしまう。免除は「距離のないレビュアーに認める例外」なので
  狭いほうが筋が通る。
- **免除を諦め、被レビュータスクを assignee 明示で登録する運用に倒す** —— 登録の作法で不具合を
  避けるだけで、ADR 0011 が「未指定は不在ではない」と決めた線を実質的に取り消す。

## 波及

`assigneeNeedsApproval`(`src/tasks.ts:1587`)は `list_agents` のロスター表示
(`src/mcp.ts:369` / ADR 0014)とも共有されているため、同じ修正でロスターが executor 本人を
「承認が要る」と誤って印付ける問題も直る。

registry の authority profile `auditor` に置いた `assignable_to: ["tako"]` は、この不具合の回避を
意図したものだったが `REVIEWER_AUTHORITY_PROFILE` に上書きされて**そもそも効いていない**。
修正後は `[]` が正直な値である。
