# issue の優先度 label は名指しの門に相対し、読み手を持つ

2026-10-13 の grilling(issue #1879)で決定。open issue が 220 件、毎月の起票が close を 50〜100 件上回り、
`priority:*` label は 2026-07-17 の docs commit(de40e81d、ADR 無し)で「Tidepool が Tidepool を開発するのを妨げる
もの」を high と決めたまま、読む skill が1本も無く(sweep は番号の新しい順、implement は見ない)、high が全部 close
したあと誰も付けなくなっていた(open の priority 付きは 11 件、うち 7 件は doc が除く `needs-triage`)。label は
読み手が居ないと腐る。盤面の「優先順位」(task の `quality` / `cost` 鍵、ADR 0114)とは別物なので、こちらは
**issue の優先度**と呼ぶ。実測の表と一掃の結果は #1879 に置く。

## 決定

1. **意味は名指しの門に相対する。** 門は `docs/agents/triage-labels.md` に1行で名指し、今の門は「自分の Mac で
   実運用を始める」(#1879: Lima VM の盤面で tidepool 自身を workspace に、`ready-for-agent` の issue 1件が task →
   PR → 朝の triage で merge まで通り、かつ `priority:high` が空)。門を越えたら次の門を書いてから open 全件を
   付け直す —— 2026-07 の意味が腐ったのは、門が消えても意味を書き直さなかったからである。
2. **3段と無印。** `high` = 門を塞ぐ。機械的テストは4つ: 実装が既存の表・列の形を変える —— 列の改名・削除・移動、型・NOT NULL・
   CHECK の変更(リリース前は migration を書かず盤面を作り直すので、実運用後に残すと記録を失う。SQLite ではどれも表の
   作り直しになる)。結論のどれかが形を変える問いも、結論の前から数える(#1895)。足すだけの変更 —— 表の新設、NULL を
   許す列の新設、索引 —— は生きた DB に当てられ記録を失わないので数えない(#1031)。実運用後はこの足す変更に限って
   DDL を当てる / 記録を書く側(decision log・event・episode・usage・
   PR 決着)の誤り / 自律的に動く最適化プロセス(memory・routing meta-review、Interview、学習器)の実装と
   誤り / 実運用で repo・財布・信頼を壊す欠陥。誤りと欠陥は確かめる前の疑いを含む —— 本当ならテストに当たる疑いは
   `high` で、最初の一手はその実測、外れたら下げるか close する(#1883: 確かめていない疑いを low に置くと、門が
   その疑いを残したまま開く)。`medium` = 門は塞がないが、実運用の最初の数週で自分が
   踏む摩擦。`low` = 門の後に見る。無印 = 付け忘れ。high の中に細分は作らず、取るのは blocker の無い high のうち
   一番古いもの。
3. **母集団は open 全部、既定は `low`。** state label を問わず1つ付ける(観測待ちの issue も、その観測が門の前に
   要るかで高低がある)。起票時に付け、テストに当たるか迷えば `low`。上げるには「門を塞ぐ理由」が1行要る。
4. **読み手を配線する。** `/triage-sweep` の queue は 無印 → high → medium の順で、`low` は乗せない —— low は
   門の後まで誰の時間も使わない。sweep は priority を自分で付ける(state の移動と違って spec の承認ではない)。
   起票する skill(`/triage` の派生、grilling の派生、`/to-tickets`)は起票時に付ける。人間は high から取る。
5. **門は root issue で、high ⇔ その blocker。** 門の issue(#1879)に high から blocked-by を張る。label が
   一覧の filter、edge が GitHub 上の残量と「0 になったら開く」の機械判定で、同じ集合を2つの形で持つ唯一の場所。
6. **門の確認は3つ。** 各実装 PR のテスト、自律最適化プロセスの隔離環境での様子見(設計は #1880、high)、
   委任の1周の実機走行(#1879 の close 条件)。テストは Board call を fake で置くので判断の質は盤面でしか見えず、
   PR のテストだけでは足りない。

## Considered options

- **門と無関係な一般の緊急度 + GitHub milestone で経路を示す** — 読み手(sweep の filter)が label 側に居るので
  採らない。milestone はこの repo で未使用。
- **high / low の2段** — medium の読み手は「high が空いた朝の自分」で居るので残す。
- **`ready-for-agent` にだけ付ける**(2026-07 の線) — 一生終わらないのは `needs-triage` の 93 件の側で、そこに
  付けなければ sweep が順を読めない。
- **未実装の最適化プロセスは門に入れない**(raw event が残るので後から再導出できる) — 実装が DDL を変えれば
  作り直しで記録を失うので退けた。
- **様子見は `docs/real-environment-trial.md` に段を足す** — 急ごしらえの文書で、自動化の余地も含めて設計し直す
  (#1880)。

## 帰結

- `docs/agents/triage-labels.md`「Priority labels」を書き換えた(2026-07-17 の表は置き換え)。
- `/triage-sweep` の queue と付与、`/triage` の派生起票、grilling の派生起票、`/to-tickets` の起票に priority の
  付与を足す(skill の編集、PR)。
- open 全件の一掃と #1879 への blocked-by は grilling の session で行い、結果は #1879 のコメントに置く。
- 段階計画(最初は grilling 済みの実装だけ委任する)と「grilling は委任しない」は使い方であって盤面の決定ではなく、
  記録に残さない。
