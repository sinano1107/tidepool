# 報告なき exit の question は CLI が報告した失敗の文を逐語で添え、盤面はそれで判定しない

2026-10-02 の triage / grilling(issue #1256 / #1278)で決定。「報告なき exit」(ADR 0145)の failure question は exit code と
stderr 末尾だけで組み立てられ、Provider や CLI が失敗の理由を stdout にだけ出したとき(Claude の result 行、Codex の
`turn.failed`)、人間は transcript を開かないと原因にたどり着けなかった。CLI の行の形の調べ(Claude 2.1.241 の型定義、
Codex 0.147.0 のソース)と実装の範囲は #1278 のコメントに置く。

## 決定

1. **CLI が報告した失敗の文は、stderr 末尾と同じく空でなければ添える。** 盤面の断言ではなく CLI の言葉の転記であり、
   ADR 0145 決定6 の「断言は3つだけ」は変わらない。文は表示にだけ使い、行の拒否・Quarantine・推奨のどの判定にも
   使わない —— 文言から推測しない線(ADR 0104 決定2 / ADR 0184 決定3)はそのまま守られる。
2. **主語は「Provider の拒否」ではなく「CLI が報告した失敗」である。** Claude は `is_error: true` の result 行すべて
   —— API エラーの `result`(`api_error_status` が数値なら添える)も、CLI 側の失敗の `errors` も。線は「worker 自身の
   言葉ではない」に引く: 走り終えた worker の最後の発話は別の主語で、#1296 が扱う。
3. **Codex は `turn.failed` の `error.message` だけを読む。** `error` event は再試行のたびにも流れ、別の理由で終わった
   session に回復済みの文を原因のように見せる。`turn.failed` は自分で直前の `error` へ代用しているので、盤面が重ねて
   代用しない。message の中の入れ子の JSON は解かない —— vendor の形への依存を増やさない。
4. **最後の1件を切り詰めずに載せる。** stderr 末尾の上限は際限なく流れるログのためのもので、CLI が1度だけ出す失敗の
   文には当たらない。長い文が観測されたら上限を足す。
5. **事実は `worker_exited` に載り、question は提供元を見ずに描く。** adapter が自分の stdout から埋め、盤面は1本で
   描く。stderr 末尾に混ぜない(欄の意味が嘘になる)、watchdog が transcript を読まない(配置は adapter 固有、
   ADR 0005)。

## 帰結

- 行の拒否(ADR 0184 / 0187)と上限到達による中断は question の前に経路が分かれるので、この文は載らない。ADR 0187
  決定5 の「field が消えたら報告なき exit に落ちる」ときは、この文が人間に理由を見せる。
- 401 で落ちた session は Quarantine の question と並ぶ failure question(ADR 0145 決定5)にも理由が載る。

## 退けた案

- **`turn.failed` が無ければ最後の `error` event で代用する** —— 決定3。
- **API エラーの系統だけを載せる** —— 判定に使わない文を Provider 由来かどうかで落とす理由が無い。
