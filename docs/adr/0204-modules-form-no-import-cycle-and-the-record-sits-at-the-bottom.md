# module は値の import で循環を作らず、記録(events)を最下層に置く

2026-10-06 の grilling(issue #1459)で決定。`src/` の値の import は 9 module の強連結成分を作っており、`tests/` にも
1組の循環がある。循環の上で相手の値を top level で読む変更が入ると ESM の TDZ で `ReferenceError` になるが、落ちるかどうかは
**どの module から読み込んだか**で決まる(scratchpad の2ファイル実測)ので、ある test が通っても `main.ts` からの起動で落ちうる。
これまでは評価時に壊れる辺が出るたびに葉を個別に切り出してきた(`claude-model-alias.ts`)。成分の辺と測った数字は #1459 の
コメントに置く。

## 決定

1. **値の import の循環を作らない。** 既存の成分を解き、リポジトリ全体(`src/` と `tests/`)で Biome の
   `suspicious/noImportCycles` を `error`・`ignoreTypes: true` で有効にする。型だけの import は実行時に消えるので循環に数えない。
2. **lint は成分を解く前に有効にし、既存の箇所は `biome-ignore` の台帳にする。** 辺を解いた変更は効かなくなった ignore を
   消さないと `--error-on-warnings` で落ちる(`suppressions/unused`)ので、台帳は解いた分だけ機械的に縮む。ignore 済みの import 文に
   specifier を足す変更は通るが、それは移行中だけの穴として許容する。台帳が空になった後、この rule の ignore は置かない。
3. **`events` は成分の最下層に置き、上の層を読まない。** 記録そのものだからである。決定ログ一覧の read model(`listLog`)は
   ログ流し読みの読みとして `triage` へ移し、session の窓(`sessionWindow` / `sessionSpawnOf`)は `EventRow` だけを読む純関数として
   `events` へ下ろす。
4. **ティア(段)の一覧を `tasks` の下の module へ出し、`execution-setting` は全体として `tasks` と `quarantine` の上に置く。**
   `tasks` と `db` が読むのは実行設定の表ではなく段の一覧(名前と id の引き、名前の検査、提案の段の名前への引き、優先度、
   段の種)であり、この塊は quarantine を読まない。実行設定の側は変更と波及だけでなく「この行で走れるか」の読みも行の
   Quarantine を読む(ADR 0184 追記)ので、`quarantine` が宣言する向き(`quarantine` → タスクの module)の上にしか置けない。
5. **成分の葉になる値は、依存ゼロの module へ概念ごとに出す。** `DomainError`、worker の id、`git`。寄せ集めの module は
   何でも置ける場所になって次の循環の温床になるので作らない。互換の re-export も残さない。

向きを強制する lint は別に足さない。上の層への逆向きの import は必ず循環になり、決定1 が捕まえる。

## Considered options

- **lint だけで既存の成分は残す** — lint は import 文を見るだけで、既存の辺の上に top level の読みを足す変更(TDZ の引き金
  そのもの)を止めない。
- **成分を解くだけで lint を入れない** — 循環は #1436 のように辺1本ずつ足されてできたので、解いても戻る。
- **壊れたら葉を切り出す運用を続ける** — 「壊れれば test が落ちて気づく」が前提だが、落ちるかは読み込みの入口で決まるので
  その前提が成り立たない。
- **`execution-setting` を `tasks` の下に残し、変更・波及と走れる行の読みを上位の module へ出す** — 走れる行の読みを読む
  module の大半が import 元を変えることになり、動く量も段の一覧を下ろすより多い。
