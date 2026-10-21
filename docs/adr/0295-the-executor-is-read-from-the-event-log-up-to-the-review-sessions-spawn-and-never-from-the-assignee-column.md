# Executor は review の session の spawn を時点として event log から読み、assignee 列は読まない

2026-10-21 の grilling(issue #2374、族: #2373)で決定。ADR 0054 は Executor を event log の事実と定めつつ「`assignee` 列に値が
あればそのまま返す」として列を先に読み、ADR 0292 は Edit の扉を閉じて「Executor の読みは ADR 0054 のまま」とした。だが列を動かす
手は Edit の他に2つ残る —— 未実行の親の pickup の埋め(ADR 0233 決定2)と、一度も pickup されていない task への Edit(ADR 0233
決定5 の許容)。盤面が実行前の親の下に立てる異議由来の auditor RCA(ADR 0292 決定2 の門の外)は、RCA が走っている最中に親が
queue の先頭に来て埋められ(RCA は付帯子で親を止めない)、spawn が描いた Roster(空)と後の読み(既定 agent 1名)が割れる。
review type の親は列を書かないので、escalate 後の再 pickup でも最後の pickup が変わる(#2373)。どちらの手も閉じられない —— 埋めは
機構そのもの、未 pickup の Edit は許容された操作である。再現と読み手の全件は #2374 に置く。

## 決定

1. **Executor は時点つきの事実である。** review の session を spawn した時点までの event log が示す実行者(`task_completed`、無ければ
   最後の `task_picked_up`、ADR 0054 の順)で、その時点より前に実行の事実が無ければ「まだ居ない」が答え。列は読まない —— 列は
   前を向いた札で、pickup 前は実行者ではない。pickup 後は列と最後の pickup の worker が一致する(scheduler は列の名前をそのまま
   worker にして pickup し、空なら埋める。production の pickup 経路は1本)ので、列を読まなくなって失う事実は無い。
2. **時点は各 session の spawn(`worker_spawned`)。** 登録でも最初の spawn でもない。session が見た写真がその session の読みで、
   当時版は ADR 0020 以来 session ごとに解決している。再 spawn は撮り直す。
3. **時点は event log を区切って運ぶ。記録は足さない。** spawn の Roster は自分の `worker_spawned` の id、live の免除と `list_agents`
   の `direct` 印はその session の最新 `worker_spawned`、self RCA の当時版と帰責の入力は手に持つ spawned の id を区切りに、同じ
   1つの読みを呼ぶ。「この id より前に実行の event が無い」は log の事実そのものなので、spawn 記録への写しは要らない。
4. **Codex adapter も `worker_spawned` を本文の描画より先に書く。** 封じ込めの確認(ADR 0259)は本文入りの config を要るので、
   順は event → 描画 → 確認 → spawn。Claude adapter と同じく event は attempt の記録で、失敗は `spawn_failed` が対を閉じる
   (ADR 0149 決定2)。描画と event の間の `await` の窓に親の pickup が入る interleaving はこれで消える。

## Considered options

- **読み手を列のままにし、扉を閉じる**(ADR 0292 の形)—— 埋めと未 pickup の Edit は閉じられない。
- **登録の時点で読む** —— 免除が問うのは entry の書き手でなく task の実行者(ADR 0054 / ADR 0237)で、登録時点に意味が無い。
- **最初の spawn の時点で読む** —— 再 spawn が描き直す Roster と、その session の当時版が割れる。
- **`worker_spawned` に Executor を写す** —— live の読み手2本もどのみち自分の spawn を探すので手間は減らず、同じ事実の写しが増える。
- **異議の対象が人間の entry だけの RCA は Roster を常に空にする / 実行前の親では Executor を読まない**(issue の候補)—— 決定1 で
  両方とも自動で含まれる。
- **Codex は描画時の最新 event id を区切りにして `worker_spawned` に書く** —— 退けた写しがここだけ戻る。

## 帰結

- ADR 0054 の「列に値があればそのまま返す(従来どおり)」と ADR 0292 の「Executor の読みは ADR 0054 のまま」は本 ADR で変わる
  (両方に追記)。ADR 0054 の全域性の節が置いた「RCA の親は必ず pickup 済み(`decision_logged` は worker session が書く)」は
  人間 decompose で外れており、「まだ居ない」が正当な答えになる場合に、盤面が実行前の親の下に立てる RCA が加わる。
- ADR 0292 決定2 の門(人間の review 子)は「今、実行の事実があるか」なので区切り無しのまま。ADR 0233 決定3(review の列は
  書かない)も変えない —— #2373 は区切りで消える。
- **範囲外**: RCA が走っている間に親の統合が始まること(付帯子の線、ADR 0049)、列を書く側の問い(族 #1796)。
